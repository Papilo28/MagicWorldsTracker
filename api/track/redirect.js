// api/track/redirect.js  (handles GET /r/:affiliateCode via vercel.json rewrite)
const { handleCors } = require('../../lib/cors');
const { query } = require('../../lib/db');
const { v4: uuidv4 } = require('uuid');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  // affiliateCode comes from the URL path /r/:affiliateCode
  const urlParts = req.url.split('/');
  const affiliateCode = req.query.affiliateCode
    || urlParts[urlParts.indexOf('r') + 1]?.split('?')[0];

  if (!affiliateCode) return res.redirect(process.env.DEFAULT_REDIRECT_URL || 'https://example.com');

  try {
    const aff = await query(
      `SELECT id, affiliate_code FROM affiliates WHERE affiliate_code=$1 AND status='active'`,
      [affiliateCode.toUpperCase()]
    );

    if (aff.rows.length === 0) {
      return res.redirect(process.env.DEFAULT_REDIRECT_URL || 'https://example.com');
    }

    // Determine destination
    const dest = await query(
      `SELECT url FROM redirect_destinations WHERE is_default=TRUE LIMIT 1`
    );
    const destination = dest.rows[0]?.url || process.env.DEFAULT_REDIRECT_URL || 'https://example.com';

    // Build session id (use existing cookie or create new)
    const sessionId = req.cookies?.aff_session || uuidv4();

    // Record click (fire-and-forget, don't block redirect)
    query(
      `INSERT INTO clicks (affiliate_id, affiliate_code, ip_address, user_agent, referer, destination, session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        aff.rows[0].id,
        affiliateCode.toUpperCase(),
        req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '',
        req.headers['user-agent'] || '',
        req.headers['referer'] || '',
        destination,
        sessionId
      ]
    ).catch(console.error);

    // Set attribution cookie (30 days)
    const days = parseInt(process.env.ATTRIBUTION_WINDOW_DAYS || '30');
    res.setHeader('Set-Cookie', [
      `aff_code=${affiliateCode.toUpperCase()}; Path=/; Max-Age=${days * 86400}; SameSite=Lax`,
      `aff_session=${sessionId}; Path=/; Max-Age=${days * 86400}; SameSite=Lax`
    ]);

    const redirectUrl = new URL(destination);
    redirectUrl.searchParams.set('ref', affiliateCode.toUpperCase());
    res.redirect(302, redirectUrl.toString());
  } catch (err) {
    console.error('redirect error:', err);
    res.redirect(process.env.DEFAULT_REDIRECT_URL || 'https://example.com');
  }
};
