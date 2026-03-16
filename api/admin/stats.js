// api/admin/stats.js
const { handleCors } = require('../../lib/cors');
const { query } = require('../../lib/db');
const { requireAdmin } = require('../../lib/auth');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const admin = requireAdmin(req, res);
  if (!admin) return;

  const [affiliates, clicks, conversions, earnings, topAffiliates, recentConversions] = await Promise.all([
    query(`SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN status='active'  THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
           FROM affiliates`),
    query(`SELECT COUNT(*) AS total,
             SUM(CASE WHEN clicked_at >= NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END) AS last_30
           FROM clicks`),
    query(`SELECT COUNT(*) AS total,
             SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
             SUM(CASE WHEN status='paid'     THEN 1 ELSE 0 END) AS paid
           FROM conversions`),
    query(`SELECT
             COALESCE(SUM(commission_amount),0) AS total_owed,
             COALESCE(SUM(CASE WHEN status='paid' THEN commission_amount ELSE 0 END),0) AS total_paid,
             COALESCE(SUM(CASE WHEN status='approved' THEN commission_amount ELSE 0 END),0) AS pending_payout
           FROM conversions`),
    query(`SELECT a.affiliate_code, a.name, a.email,
             COUNT(DISTINCT c.id)  AS clicks,
             COUNT(DISTINCT cv.id) AS conversions,
             COALESCE(SUM(cv.commission_amount),0) AS earnings
           FROM affiliates a
           LEFT JOIN clicks      c  ON c.affiliate_id=a.id
           LEFT JOIN conversions cv ON cv.affiliate_id=a.id
           WHERE a.status='active'
           GROUP BY a.id ORDER BY earnings DESC LIMIT 10`),
    query(`SELECT cv.id, cv.conversion_type, cv.conversion_value, cv.currency,
             cv.commission_amount, cv.status, cv.created_at,
             a.name AS affiliate_name, a.affiliate_code
           FROM conversions cv
           JOIN affiliates a ON a.id=cv.affiliate_id
           ORDER BY cv.created_at DESC LIMIT 20`)
  ]);

  res.json({
    affiliates: affiliates.rows[0],
    clicks:     clicks.rows[0],
    conversions: conversions.rows[0],
    earnings:   earnings.rows[0],
    top_affiliates:      topAffiliates.rows,
    recent_conversions:  recentConversions.rows
  });
};
