// api/admin/conversions.js — list and update conversion status
const { handleCors } = require('../../lib/cors');
const { query } = require('../../lib/db');
const { requireAdmin } = require('../../lib/auth');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const admin = requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const page   = Math.max(1, parseInt(req.query.page)   || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    const status = req.query.status;

    const params = [];
    let where = 'WHERE 1=1';
    if (status) { params.push(status); where += ` AND cv.status=$${params.length}`; }

    const [rows, count] = await Promise.all([
      query(
        `SELECT cv.*, a.name AS affiliate_name, a.email AS affiliate_email
         FROM conversions cv
         JOIN affiliates a ON a.id=cv.affiliate_id
         ${where}
         ORDER BY cv.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) FROM conversions cv ${where}`, params)
    ]);

    return res.json({
      conversions: rows.rows,
      pagination: { page, limit, total: parseInt(count.rows[0].count), pages: Math.ceil(count.rows[0].count / limit) }
    });
  }

  if (req.method === 'PUT') {
    const { id } = req.query;
    const { status } = req.body || {};
    const allowed = ['pending', 'approved', 'rejected', 'paid'];
    if (!id) return res.status(400).json({ error: 'id is required' });
    if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });

    await query(`UPDATE conversions SET status=$1, updated_at=NOW() WHERE id=$2`, [status, id]);
    return res.json({ message: 'Conversion updated' });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
