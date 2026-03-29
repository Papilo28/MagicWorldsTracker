// api/redirect.js — handles GET /r/:affiliateCode
const { handleCors } = require('../lib/cors');
const { query } = require('../lib/db');
const { v4: uuidv4 } = require('uuid');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const affiliateCode = (req.query.affiliateCode || '').toUpperCase();
  const fallback = process.env.DEFAULT_REDIRECT_URL || 'https://example.com';

  if (!affiliateCode) return res.redirect(302, fallback);

  try {
    const aff = await query(`SELECT id,affiliate_code FROM affiliates WHERE affiliate_code=$1 AND status='active'`, [affiliateCode]);
    if (aff.rows.length === 0) return res.redirect(302, fallback);

    const dest = await query(`SELECT url FROM redirect_destinations WHERE is_default=TRUE LIMIT 1`);
    const destination = dest.rows[0]?.url || fallback;

    const cookies = {};
    (req.headers.cookie||'').split(';').forEach(c => { const [k,v]=c.trim().split('='); if(k) cookies[k.trim()]=decodeURIComponent(v||''); });
    const sessionId = cookies.aff_session || uuidv4();

    query(
      `INSERT INTO clicks (affiliate_id,affiliate_code,ip_address,user_agent,referer,destination,session_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [aff.rows[0].id, affiliateCode, req.headers['x-forwarded-for']?.split(',')[0]||'', req.headers['user-agent']||'', req.headers['referer']||'', destination, sessionId]
    ).catch(console.error);

    const days = parseInt(process.env.ATTRIBUTION_WINDOW_DAYS||'30');
    res.setHeader('Set-Cookie', [
      `aff_code=${affiliateCode}; Path=/; Max-Age=${days*86400}; SameSite=Lax`,
      `aff_session=${sessionId}; Path=/; Max-Age=${days*86400}; SameSite=Lax`
    ]);

    const redirectUrl = new URL(destination);
    redirectUrl.searchParams.set('ref', affiliateCode);
    res.redirect(302, redirectUrl.toString());
  } catch (err) {
    console.error('redirect error:', err);
    res.redirect(302, fallback);
  }
};
