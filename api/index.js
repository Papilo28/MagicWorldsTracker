// api/index.js
const { handleCors } = require('../lib/cors');

// Import your existing logic files
// Make sure these filenames match exactly what is in your /api folder
const affiliates = require('./affiliates');
const track = require('./track');
const admin = require('./admin');
const redirect = require('./redirect');
const health = require('./health');

module.exports = async (req, res) => {
  // 1. Handle CORS first
  if (handleCors(req, res)) return;

  const url = req.url || '';
  const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;

  try {
    // 2. Route the request to the correct sub-module
    if (url.startsWith('/api/affiliates')) {
      return await affiliates(req, res);
    }
    
    if (url.startsWith('/api/track')) {
      return await track(req, res);
    }
    
    if (url.startsWith('/api/admin')) {
      return await admin(req, res);
    }

    if (url.startsWith('/api/health')) {
      if (typeof health === 'function') return await health(req, res);
      return res.json({ status: 'ok' });
    }

    if (url.startsWith('/r/')) {
      return await redirect(req, res);
    }

    // 3. Default "Home" response (Documentation)
    return res.json({
      name: 'Affiliate Tracking Platform API',
      version: '2.0.0',
      mode: 'Consolidated (Hobby Plan Optimized)',
      endpoints: {
        tracking: {
          'GET /r/:affiliateCode': 'Redirect link — tracks click then redirects',
          'POST /api/track/conversion': 'S2S server-to-server conversion postback',
          'GET /api/track/script.js': 'JS snippet for partner sites',
          'GET /api/track/info': 'Current visitor tracking info'
        },
        affiliates: {
          'POST /api/affiliates/signup': 'Register new affiliate (public)',
          'POST /api/affiliates/login': 'Request magic login link',
          'GET /api/affiliates/magic': 'Verify magic link → JWT'
        },
        admin: {
          'GET /api/admin/stats': 'Platform-wide statistics',
          'GET /api/admin/payout': 'Download Excel payout report'
        }
      },
      integration_examples: {
        javascript_snippet: `<script src="${base}/api/track/script.js"></script>`,
        s2s_postback: `curl -X POST ${base}/api/track/conversion`
      }
    });

  } catch (error) {
    console.error('Routing Error:', error);
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
};