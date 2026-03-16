// api/admin/affiliates/[id].js
const { handleCors } = require('../../../lib/cors');
const { query } = require('../../../lib/db');
const { requireAdmin } = require('../../../lib/auth');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const admin = requireAdmin(req, res);
  if (!admin) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id is required' });

  if (req.method === 'GET') {
    const [aff, clicks, conversions] = await Promise.all([
      query('SELECT * FROM affiliates WHERE id=$1', [id]),
      query('SELECT COUNT(*) FROM clicks WHERE affiliate_id=$1', [id]),
      query(
        `SELECT conversion_type, COUNT(*), COALESCE(SUM(commission_amount),0) AS earnings
         FROM conversions WHERE affiliate_id=$1 GROUP BY conversion_type`,
        [id]
      )
    ]);
    if (aff.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json({ ...aff.rows[0], clicks: parseInt(clicks.rows[0].count), conversions: conversions.rows });
  }

  if (req.method === 'PUT') {
    const { name, email, commission_rate, status, payment_method, wallet_address } = req.body || {};
    await query(
      `UPDATE affiliates SET
         name=COALESCE($1,name), email=COALESCE($2,email),
         commission_rate=COALESCE($3,commission_rate), status=COALESCE($4,status),
         payment_method=COALESCE($5,payment_method), wallet_address=COALESCE($6,wallet_address),
         updated_at=NOW()
       WHERE id=$7`,
      [name, email, commission_rate, status, payment_method, wallet_address, id]
    );
    return res.json({ message: 'Affiliate updated' });
  }

  if (req.method === 'DELETE') {
    await query(`UPDATE affiliates SET status='inactive', updated_at=NOW() WHERE id=$1`, [id]);
    return res.json({ message: 'Affiliate deactivated' });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
