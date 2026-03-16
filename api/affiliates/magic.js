// api/affiliates/magic.js
const { handleCors } = require('../../lib/cors');
const { query } = require('../../lib/db');
const { signToken } = require('../../lib/auth');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { token, email } = req.query;
  if (!token || !email) return res.status(400).json({ error: 'token and email are required' });

  const result = await query(
    `SELECT * FROM affiliates
     WHERE email=$1 AND magic_token=$2 AND magic_token_expires > NOW() AND status='active'`,
    [email.toLowerCase(), token]
  );

  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Invalid or expired magic link' });
  }

  const aff = result.rows[0];
  // Invalidate token
  await query('UPDATE affiliates SET magic_token=NULL, magic_token_expires=NULL WHERE id=$1', [aff.id]);

  const jwt = signToken({ id: aff.id, email: aff.email, role: 'affiliate', code: aff.affiliate_code });

  res.json({
    token: jwt,
    affiliate: {
      id: aff.id,
      affiliate_code: aff.affiliate_code,
      email: aff.email,
      name: aff.name,
      commission_rate: aff.commission_rate,
      status: aff.status
    }
  });
};
