// api/admin.js — handles all /api/admin/* routes
const { handleCors } = require('../lib/cors');
const { query } = require('../lib/db');
const { signToken, requireAdmin } = require('../lib/auth');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');

async function login(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const adminEmail    = process.env.ADMIN_EMAIL    || 'admin@yourcompany.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const emailMatch    = email.toLowerCase() === adminEmail.toLowerCase();
  const passwordMatch = adminPassword.startsWith('$2')
    ? await bcrypt.compare(password, adminPassword)
    : password === adminPassword;

  if (!emailMatch || !passwordMatch) return res.status(401).json({ error: 'Invalid credentials' });
  const token = signToken({ email: adminEmail, role: 'admin' }, '12h');
  res.json({ token, role: 'admin' });
}

async function stats(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const [affiliates, clicks, conversions, earnings, topAffiliates, recentConversions] = await Promise.all([
    query(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending FROM affiliates`),
    query(`SELECT COUNT(*) AS total, SUM(CASE WHEN clicked_at>=NOW()-INTERVAL '30 days' THEN 1 ELSE 0 END) AS last_30 FROM clicks`),
    query(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved, SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid FROM conversions`),
    query(`SELECT COALESCE(SUM(commission_amount),0) AS total_owed, COALESCE(SUM(CASE WHEN status='paid' THEN commission_amount ELSE 0 END),0) AS total_paid, COALESCE(SUM(CASE WHEN status='approved' THEN commission_amount ELSE 0 END),0) AS pending_payout FROM conversions`),
    query(`SELECT a.affiliate_code,a.name,a.email,COUNT(DISTINCT c.id) AS clicks,COUNT(DISTINCT cv.id) AS conversions,COALESCE(SUM(cv.commission_amount),0) AS earnings FROM affiliates a LEFT JOIN clicks c ON c.affiliate_id=a.id LEFT JOIN conversions cv ON cv.affiliate_id=a.id WHERE a.status='active' GROUP BY a.id ORDER BY earnings DESC LIMIT 10`),
    query(`SELECT cv.id,cv.conversion_type,cv.conversion_value,cv.currency,cv.commission_amount,cv.status,cv.created_at,a.name AS affiliate_name,a.affiliate_code FROM conversions cv JOIN affiliates a ON a.id=cv.affiliate_id ORDER BY cv.created_at DESC LIMIT 20`)
  ]);
  res.json({ affiliates: affiliates.rows[0], clicks: clicks.rows[0], conversions: conversions.rows[0], earnings: earnings.rows[0], top_affiliates: topAffiliates.rows, recent_conversions: recentConversions.rows });
}

async function affiliates(req, res) {
  // GET list
  if (req.method === 'GET') {
    const page = Math.max(1, parseInt(req.query.page)||1);
    const limit = Math.min(100, parseInt(req.query.limit)||20);
    const offset = (page-1)*limit;
    const params = [];
    let where = 'WHERE 1=1';
    if (req.query.status) { params.push(req.query.status); where += ` AND status=$${params.length}`; }
    if (req.query.search) { params.push(`%${req.query.search}%`); where += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length})`; }
    const [rows, count] = await Promise.all([
      query(`SELECT a.id,a.affiliate_code,a.email,a.name,a.website,a.wallet_address,a.payment_method,a.commission_rate,a.status,a.created_at,COUNT(DISTINCT c.id) AS clicks,COUNT(DISTINCT cv.id) AS conversions,COALESCE(SUM(cv.commission_amount),0) AS total_earnings FROM affiliates a LEFT JOIN clicks c ON c.affiliate_id=a.id LEFT JOIN conversions cv ON cv.affiliate_id=a.id ${where} GROUP BY a.id ORDER BY a.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params,limit,offset]),
      query(`SELECT COUNT(*) FROM affiliates ${where}`, params)
    ]);
    return res.json({ affiliates: rows.rows, pagination: { page, limit, total: parseInt(count.rows[0].count), pages: Math.ceil(count.rows[0].count/limit) } });
  }
  res.status(405).json({ error: 'Method not allowed' });
}

async function affiliateById(req, res, id) {
  if (req.method === 'GET') {
    const [aff, clicks, convs] = await Promise.all([
      query('SELECT * FROM affiliates WHERE id=$1', [id]),
      query('SELECT COUNT(*) FROM clicks WHERE affiliate_id=$1', [id]),
      query(`SELECT conversion_type,COUNT(*),COALESCE(SUM(commission_amount),0) AS earnings FROM conversions WHERE affiliate_id=$1 GROUP BY conversion_type`, [id])
    ]);
    if (aff.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json({ ...aff.rows[0], clicks: parseInt(clicks.rows[0].count), conversions: convs.rows });
  }
  if (req.method === 'PUT') {
    const { name, email, commission_rate, status, payment_method, wallet_address } = req.body || {};
    await query(`UPDATE affiliates SET name=COALESCE($1,name),email=COALESCE($2,email),commission_rate=COALESCE($3,commission_rate),status=COALESCE($4,status),payment_method=COALESCE($5,payment_method),wallet_address=COALESCE($6,wallet_address),updated_at=NOW() WHERE id=$7`, [name,email,commission_rate,status,payment_method,wallet_address,id]);
    return res.json({ message: 'Affiliate updated' });
  }
  if (req.method === 'DELETE') {
    await query(`UPDATE affiliates SET status='inactive',updated_at=NOW() WHERE id=$1`, [id]);
    return res.json({ message: 'Affiliate deactivated' });
  }
  res.status(405).json({ error: 'Method not allowed' });
}

async function conversions(req, res) {
  if (req.method === 'GET') {
    const page = Math.max(1, parseInt(req.query.page)||1);
    const limit = Math.min(100, parseInt(req.query.limit)||50);
    const offset = (page-1)*limit;
    const params = [];
    let where = 'WHERE 1=1';
    if (req.query.status) { params.push(req.query.status); where += ` AND cv.status=$${params.length}`; }
    const [rows, count] = await Promise.all([
      query(`SELECT cv.*,a.name AS affiliate_name,a.email AS affiliate_email FROM conversions cv JOIN affiliates a ON a.id=cv.affiliate_id ${where} ORDER BY cv.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params,limit,offset]),
      query(`SELECT COUNT(*) FROM conversions cv ${where}`, params)
    ]);
    return res.json({ conversions: rows.rows, pagination: { page, limit, total: parseInt(count.rows[0].count), pages: Math.ceil(count.rows[0].count/limit) } });
  }
  if (req.method === 'PUT') {
    const id = req.query.id;
    const { status } = req.body || {};
    const allowed = ['pending','approved','rejected','paid'];
    if (!id) return res.status(400).json({ error: 'id is required' });
    if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    await query(`UPDATE conversions SET status=$1,updated_at=NOW() WHERE id=$2`, [status,id]);
    return res.json({ message: 'Conversion updated' });
  }
  res.status(405).json({ error: 'Method not allowed' });
}

async function payout(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const rows = await query(`SELECT a.affiliate_code,a.name,a.email,a.wallet_address,a.payment_method,COUNT(cv.id) AS total_conversions,COALESCE(SUM(cv.commission_amount),0) AS total_earnings,COALESCE(SUM(CASE WHEN cv.status='paid' THEN cv.commission_amount ELSE 0 END),0) AS paid,COALESCE(SUM(CASE WHEN cv.status='approved' THEN cv.commission_amount ELSE 0 END),0) AS approved_pending,COALESCE(SUM(CASE WHEN cv.status='pending' THEN cv.commission_amount ELSE 0 END),0) AS pending_review FROM affiliates a LEFT JOIN conversions cv ON cv.affiliate_id=a.id WHERE a.status='active' GROUP BY a.id ORDER BY approved_pending DESC`);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Affiliate Tracker';
  const ws = wb.addWorksheet('Payout Report');
  ws.columns = [
    { header:'Code',            key:'affiliate_code',  width:14 },
    { header:'Name',            key:'name',            width:22 },
    { header:'Email',           key:'email',           width:28 },
    { header:'Payment Method',  key:'payment_method',  width:16 },
    { header:'Wallet/Details',  key:'wallet_address',  width:42 },
    { header:'Conversions',     key:'total_conversions',width:14 },
    { header:'Total Earned',    key:'total_earnings',  width:14 },
    { header:'Already Paid',    key:'paid',            width:14 },
    { header:'Approved (Owed)', key:'approved_pending',width:16 },
    { header:'Pending Review',  key:'pending_review',  width:16 },
  ];
  ws.getRow(1).eachCell(cell => {
    cell.font = { bold:true, color:{ argb:'FFFFFFFF' } };
    cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1E3A5F' } };
    cell.alignment = { horizontal:'center' };
  });
  rows.rows.forEach(r => ws.addRow(r));
  ['total_earnings','paid','approved_pending','pending_review'].forEach(k => { ws.getColumn(k).numFmt = '#,##0.00'; });
  ws.autoFilter = { from:'A1', to:'J1' };
  const buffer = await wb.xlsx.writeBuffer();
  const date = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="payout-report-${date}.xlsx"`);
  res.send(Buffer.from(buffer));
}

async function destinations(req, res) {
  if (req.method === 'GET') {
    const rows = await query('SELECT * FROM redirect_destinations ORDER BY created_at DESC');
    return res.json({ destinations: rows.rows });
  }
  if (req.method === 'POST') {
    const { name, url, is_default=false } = req.body || {};
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
    if (is_default) await query('UPDATE redirect_destinations SET is_default=FALSE');
    const result = await query('INSERT INTO redirect_destinations (name,url,is_default) VALUES ($1,$2,$3) RETURNING *', [name,url,is_default]);
    return res.status(201).json({ destination: result.rows[0] });
  }
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id is required' });
    await query('DELETE FROM redirect_destinations WHERE id=$1', [id]);
    return res.json({ message: 'Destination deleted' });
  }
  res.status(405).json({ error: 'Method not allowed' });
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const path = (req.query.path || req.url.replace(/[?].*$/, '').split('/').pop() || '').split('/')[0];
  const admin = path === 'login' ? true : requireAdmin(req, res);
  if (!admin) return;

  try {
    if (path === 'login')       return await login(req, res);
    if (path === 'stats')       return await stats(req, res);
    if (path === 'affiliates')  return await affiliates(req, res);
    if (path === 'conversions') return await conversions(req, res);
    if (path === 'payout')      return await payout(req, res);
    if (path === 'destinations')return await destinations(req, res);

    // /api/admin/affiliates/123
    const affMatch = path.match(/^affiliates\/(\d+)$/);
    if (affMatch) return await affiliateById(req, res, affMatch[1]);

    res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('admin error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
