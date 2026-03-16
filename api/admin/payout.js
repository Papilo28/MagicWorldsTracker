// api/admin/payout.js — generates Excel payout report
const { handleCors } = require('../../lib/cors');
const { query } = require('../../lib/db');
const { requireAdmin } = require('../../lib/auth');
const ExcelJS = require('exceljs');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rows = await query(`
    SELECT
      a.affiliate_code, a.name, a.email,
      a.wallet_address, a.payment_method,
      COUNT(cv.id)                              AS total_conversions,
      COALESCE(SUM(cv.commission_amount), 0)    AS total_earnings,
      COALESCE(SUM(CASE WHEN cv.status='paid'     THEN cv.commission_amount ELSE 0 END),0) AS paid,
      COALESCE(SUM(CASE WHEN cv.status='approved' THEN cv.commission_amount ELSE 0 END),0) AS approved_pending,
      COALESCE(SUM(CASE WHEN cv.status='pending'  THEN cv.commission_amount ELSE 0 END),0) AS pending_review
    FROM affiliates a
    LEFT JOIN conversions cv ON cv.affiliate_id=a.id
    WHERE a.status='active'
    GROUP BY a.id
    ORDER BY approved_pending DESC
  `);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Affiliate Tracker';
  wb.created = new Date();

  const ws = wb.addWorksheet('Payout Report');
  ws.columns = [
    { header: 'Code',              key: 'affiliate_code',   width: 14 },
    { header: 'Name',              key: 'name',             width: 22 },
    { header: 'Email',             key: 'email',            width: 28 },
    { header: 'Payment Method',    key: 'payment_method',   width: 16 },
    { header: 'Wallet / Details',  key: 'wallet_address',   width: 42 },
    { header: 'Conversions',       key: 'total_conversions',width: 14 },
    { header: 'Total Earned',      key: 'total_earnings',   width: 14 },
    { header: 'Already Paid',      key: 'paid',             width: 14 },
    { header: 'Approved (Owed)',   key: 'approved_pending', width: 16 },
    { header: 'Pending Review',    key: 'pending_review',   width: 16 },
  ];

  // Style header row
  ws.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    cell.alignment = { horizontal: 'center' };
  });

  rows.rows.forEach(r => ws.addRow(r));

  // Number format for currency columns
  ['total_earnings','paid','approved_pending','pending_review'].forEach(key => {
    ws.getColumn(key).numFmt = '#,##0.00';
  });

  ws.autoFilter = { from: 'A1', to: 'J1' };

  const buffer = await wb.xlsx.writeBuffer();
  const date   = new Date().toISOString().split('T')[0];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="payout-report-${date}.xlsx"`);
  res.send(Buffer.from(buffer));
};
