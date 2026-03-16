// api/affiliates/stats.js
const { handleCors } = require('../../lib/cors');
const { query } = require('../../lib/db');
const { requireAuth } = require('../../lib/auth');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = requireAuth(req, res);
  if (!user) return;

  const [clicks, conversions, earnings] = await Promise.all([
    query('SELECT COUNT(*) FROM clicks WHERE affiliate_id=$1', [user.id]),
    query(`SELECT COUNT(*), conversion_type FROM conversions WHERE affiliate_id=$1 GROUP BY conversion_type`, [user.id]),
    query(
      `SELECT COALESCE(SUM(commission_amount),0) AS total,
              COALESCE(SUM(CASE WHEN status='approved' THEN commission_amount ELSE 0 END),0) AS approved,
              COALESCE(SUM(CASE WHEN status='paid'     THEN commission_amount ELSE 0 END),0) AS paid
       FROM conversions WHERE affiliate_id=$1`,
      [user.id]
    )
  ]);

  const convByType = {};
  for (const row of conversions.rows) convByType[row.conversion_type] = parseInt(row.count);

  res.json({
    clicks: parseInt(clicks.rows[0].count),
    conversions: conversions.rows.reduce((s, r) => s + parseInt(r.count), 0),
    conversions_by_type: convByType,
    earnings: earnings.rows[0]
  });
};
