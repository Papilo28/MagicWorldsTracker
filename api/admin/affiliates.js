// api/admin/affiliates.js  — GET list / POST create
const { handleCors } = require('../../lib/cors');
const { query } = require('../../lib/db');
const { requireAdmin } = require('../../lib/auth');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const admin = requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const page   = Math.max(1, parseInt(req.query.page)   || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const status = req.query.status;
    const search = req.query.search;

    let where = 'WHERE 1=1';
    const params = [];

    if (status) { params.push(status); where += ` AND status=$${params.length}`; }
    if (search) { params.push(`%${search}%`); where += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length})`; }

    const [rows, count] = await Promise.all([
      query(
        `SELECT a.id, a.affiliate_code, a.email, a.name, a.website, a.wallet_address,
                a.payment_method, a.commission_rate, a.status, a.created_at,
                COUNT(DISTINCT c.id)  AS clicks,
                COUNT(DISTINCT cv.id) AS conversions,
                COALESCE(SUM(cv.commission_amount),0) AS total_earnings
         FROM affiliates a
         LEFT JOIN clicks      c  ON c.affiliate_id = a.id
         LEFT JOIN conversions cv ON cv.affiliate_id = a.id
         ${where}
         GROUP BY a.id ORDER BY a.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) FROM affiliates ${where}`, params)
    ]);

    return res.json({
      affiliates: rows.rows,
      pagination: { page, limit, total: parseInt(count.rows[0].count), pages: Math.ceil(count.rows[0].count / limit) }
    });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
