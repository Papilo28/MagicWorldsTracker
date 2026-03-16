// api/affiliates/login.js
const { handleCors } = require('../../lib/cors');
const { query } = require('../../lib/db');
const { signToken } = require('../../lib/auth');
const { v4: uuidv4 } = require('uuid');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  // POST /api/affiliates/login — request magic link token
  if (req.method === 'POST') {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email is required' });

    const aff = await query('SELECT id, email, status FROM affiliates WHERE email = $1', [email.toLowerCase()]);
    // Always return 200 to avoid user enumeration
    if (aff.rows.length === 0 || aff.rows[0].status !== 'active') {
      return res.json({ message: 'If that email is registered, a magic link has been sent.' });
    }

    const token = uuidv4();
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 min
    await query(
      'UPDATE affiliates SET magic_token=$1, magic_token_expires=$2 WHERE id=$3',
      [token, expires, aff.rows[0].id]
    );

    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const magicUrl = `${base}/api/affiliates/magic?token=${token}&email=${encodeURIComponent(email)}`;

    // In production, email this link. For now return it (replace with your email provider).
    console.log('Magic link:', magicUrl);

    return res.json({
      message: 'If that email is registered, a magic link has been sent.',
      // REMOVE the line below in production — for testing only:
      dev_magic_url: process.env.NODE_ENV !== 'production' ? magicUrl : undefined
    });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
