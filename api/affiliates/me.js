// api/affiliates/me.js
const { handleCors } = require('../../lib/cors');
const { query } = require('../../lib/db');
const { requireAuth } = require('../../lib/auth');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const user = requireAuth(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const result = await query(
      `SELECT id, affiliate_code, email, name, website, wallet_address,
              payment_method, commission_rate, status, created_at
       FROM affiliates WHERE id=$1`,
      [user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const aff = result.rows[0];
    return res.json({ ...aff, tracking_link: `${base}/r/${aff.affiliate_code}` });
  }

  if (req.method === 'PUT') {
    const { name, website, wallet_address, payment_method } = req.body || {};
    await query(
      `UPDATE affiliates SET name=COALESCE($1,name), website=COALESCE($2,website),
       wallet_address=COALESCE($3,wallet_address), payment_method=COALESCE($4,payment_method),
       updated_at=NOW() WHERE id=$5`,
      [name, website, wallet_address, payment_method, user.id]
    );
    return res.json({ message: 'Profile updated' });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
