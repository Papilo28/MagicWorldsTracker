// api/affiliates/signup.js
const { handleCors } = require('../../lib/cors');
const { query } = require('../../lib/db');
const { v4: uuidv4 } = require('uuid');

function generateCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, name, website, wallet_address, payment_method } = req.body || {};
  if (!email || !name) return res.status(400).json({ error: 'email and name are required' });

  try {
    // Check duplicate
    const existing = await query('SELECT id FROM affiliates WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Email already registered' });

    let code;
    let attempts = 0;
    do {
      code = generateCode();
      const taken = await query('SELECT id FROM affiliates WHERE affiliate_code = $1', [code]);
      if (taken.rows.length === 0) break;
    } while (++attempts < 10);

    const result = await query(
      `INSERT INTO affiliates (affiliate_code, email, name, website, wallet_address, payment_method, status)
       VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING id, affiliate_code, email, name, status, created_at`,
      [code, email.toLowerCase(), name, website || null, wallet_address || null, payment_method || 'crypto']
    );

    res.status(201).json({
      message: 'Affiliate registered successfully',
      affiliate: result.rows[0],
      tracking_link: `${process.env.NEXT_PUBLIC_BASE_URL || ''}/r/${code}`
    });
  } catch (err) {
    console.error('signup error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
};
