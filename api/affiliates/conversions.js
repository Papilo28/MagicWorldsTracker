// api/affiliates/conversions.js
const { handleCors } = require('../../lib/cors');
const { query } = require('../../lib/db');
const { requireAuth } = require('../../lib/auth');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = requireAuth(req, res);
  if (!user) return;

  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;

  const [rows, count] = await Promise.all([
    query(
      `SELECT id, conversion_type, conversion_value, currency, commission_amount, status, metadata, created_at
       FROM conversions WHERE affiliate_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [user.id, limit, offset]
    ),
    query('SELECT COUNT(*) FROM conversions WHERE affiliate_id=$1', [user.id])
  ]);

  res.json({
    conversions: rows.rows,
    pagination: { page, limit, total: parseInt(count.rows[0].count), pages: Math.ceil(count.rows[0].count / limit) }
  });
};
