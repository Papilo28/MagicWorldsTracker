// api/track/info.js
const { handleCors } = require('../../lib/cors');

module.exports = (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Parse cookies manually (no cookie-parser in serverless)
  const cookies = {};
  const cookieHeader = req.headers.cookie || '';
  cookieHeader.split(';').forEach(c => {
    const [k, v] = c.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v || '');
  });

  res.json({
    affiliate_code: cookies.aff_code || null,
    session_id:     cookies.aff_session || null,
    has_attribution: !!cookies.aff_code
  });
};
