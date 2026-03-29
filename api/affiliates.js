// api/affiliates.js — handles all /api/affiliates/* routes
const { handleCors } = require('../lib/cors');
const { query } = require('../lib/db');
const { signToken, requireAuth } = require('../lib/auth');
const { v4: uuidv4 } = require('uuid');

function generateCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

async function signup(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email, name, website, wallet_address, payment_method } = req.body || {};
  if (!email || !name) return res.status(400).json({ error: 'email and name are required' });

  const existing = await query('SELECT id FROM affiliates WHERE email=$1', [email.toLowerCase()]);
  if (existing.rows.length > 0) return res.status(409).json({ error: 'Email already registered' });

  let code, attempts = 0;
  do {
    code = generateCode();
    const taken = await query('SELECT id FROM affiliates WHERE affiliate_code=$1', [code]);
    if (taken.rows.length === 0) break;
  } while (++attempts < 10);

  const result = await query(
    `INSERT INTO affiliates (affiliate_code,email,name,website,wallet_address,payment_method,status)
     VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING id,affiliate_code,email,name,status,created_at`,
    [code, email.toLowerCase(), name, website||null, wallet_address||null, payment_method||'crypto']
  );
  const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;
  res.status(201).json({ message: 'Affiliate registered', affiliate: result.rows[0], tracking_link: `${base}/r/${code}` });
}

async function login(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });

  const aff = await query('SELECT id,email,status FROM affiliates WHERE email=$1', [email.toLowerCase()]);
  if (aff.rows.length === 0 || aff.rows[0].status !== 'active') {
    return res.json({ message: 'If that email is registered, a magic link has been sent.' });
  }

  const token = uuidv4();
  const expires = new Date(Date.now() + 15 * 60 * 1000);
  await query('UPDATE affiliates SET magic_token=$1,magic_token_expires=$2 WHERE id=$3', [token, expires, aff.rows[0].id]);

  const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;
  const magicUrl = `${base}/dashboard?token=${token}&email=${encodeURIComponent(email)}`;
  console.log('Magic link:', magicUrl);

  res.json({
    message: 'If that email is registered, a magic link has been sent.',
    dev_magic_url: process.env.NODE_ENV !== 'production' ? magicUrl : undefined
  });
}

async function magic(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { token, email } = req.query;
  if (!token || !email) return res.status(400).json({ error: 'token and email are required' });

  const result = await query(
    `SELECT * FROM affiliates WHERE email=$1 AND magic_token=$2 AND magic_token_expires>NOW() AND status='active'`,
    [email.toLowerCase(), token]
  );
  if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid or expired magic link' });

  const aff = result.rows[0];
  await query('UPDATE affiliates SET magic_token=NULL,magic_token_expires=NULL WHERE id=$1', [aff.id]);
  const jwt = signToken({ id: aff.id, email: aff.email, role: 'affiliate', code: aff.affiliate_code });
  res.json({ token: jwt, affiliate: { id: aff.id, affiliate_code: aff.affiliate_code, email: aff.email, name: aff.name, commission_rate: aff.commission_rate, status: aff.status } });
}

async function me(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const result = await query(
      `SELECT id,affiliate_code,email,name,website,wallet_address,payment_method,commission_rate,status,created_at FROM affiliates WHERE id=$1`,
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
      `UPDATE affiliates SET name=COALESCE($1,name),website=COALESCE($2,website),
       wallet_address=COALESCE($3,wallet_address),payment_method=COALESCE($4,payment_method),updated_at=NOW() WHERE id=$5`,
      [name, website, wallet_address, payment_method, user.id]
    );
    return res.json({ message: 'Profile updated' });
  }
  res.status(405).json({ error: 'Method not allowed' });
}

async function stats(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;

  const [clicks, conversions, earnings] = await Promise.all([
    query('SELECT COUNT(*) FROM clicks WHERE affiliate_id=$1', [user.id]),
    query(`SELECT COUNT(*),conversion_type FROM conversions WHERE affiliate_id=$1 GROUP BY conversion_type`, [user.id]),
    query(`SELECT COALESCE(SUM(commission_amount),0) AS total,
             COALESCE(SUM(CASE WHEN status='approved' THEN commission_amount ELSE 0 END),0) AS approved,
             COALESCE(SUM(CASE WHEN status='paid' THEN commission_amount ELSE 0 END),0) AS paid
           FROM conversions WHERE affiliate_id=$1`, [user.id])
  ]);
  const convByType = {};
  for (const row of conversions.rows) convByType[row.conversion_type] = parseInt(row.count);
  res.json({ clicks: parseInt(clicks.rows[0].count), conversions: conversions.rows.reduce((s,r)=>s+parseInt(r.count),0), conversions_by_type: convByType, earnings: earnings.rows[0] });
}

async function conversions(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;

  const page = Math.max(1, parseInt(req.query.page)||1);
  const limit = Math.min(100, parseInt(req.query.limit)||20);
  const offset = (page-1)*limit;

  const [rows, count] = await Promise.all([
    query(`SELECT id,conversion_type,conversion_value,currency,commission_amount,status,metadata,created_at
           FROM conversions WHERE affiliate_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [user.id,limit,offset]),
    query('SELECT COUNT(*) FROM conversions WHERE affiliate_id=$1', [user.id])
  ]);
  res.json({ conversions: rows.rows, pagination: { page, limit, total: parseInt(count.rows[0].count), pages: Math.ceil(count.rows[0].count/limit) } });
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  const path = (req.query.path || req.url.replace(/[?].*$/, '').split('/').pop() || '').split('/')[0];

  try {
    if (path === 'signup')      return await signup(req, res);
    if (path === 'login')       return await login(req, res);
    if (path === 'magic')       return await magic(req, res);
    if (path === 'me')          return await me(req, res);
    if (path === 'stats')       return await stats(req, res);
    if (path === 'conversions') return await conversions(req, res);
    res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('affiliates error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
