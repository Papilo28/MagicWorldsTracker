// api/index.js
const { handleCors } = require('../lib/cors');

module.exports = (req, res) => {
  if (handleCors(req, res)) return;

  const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;

  res.json({
    name: 'Affiliate Tracking Platform API',
    version: '2.0.0',
    endpoints: {
      tracking: {
        'GET /r/:affiliateCode':          'Redirect link — tracks click then redirects',
        'POST /api/track/conversion':     'S2S server-to-server conversion postback',
        'GET /api/track/script.js':       'JS snippet for partner sites',
        'GET /api/track/info':            'Current visitor tracking info'
      },
      affiliates: {
        'POST /api/affiliates/signup':    'Register new affiliate (public)',
        'POST /api/affiliates/login':     'Request magic login link',
        'GET /api/affiliates/magic':      'Verify magic link → JWT',
        'GET /api/affiliates/me':         'Own profile (auth required)',
        'PUT /api/affiliates/me':         'Update own profile (auth required)',
        'GET /api/affiliates/stats':      'Own statistics (auth required)',
        'GET /api/affiliates/conversions':'Own conversions (auth required)'
      },
      admin: {
        'POST /api/admin/login':           'Admin login → JWT',
        'GET /api/admin/affiliates':       'List all affiliates',
        'GET /api/admin/affiliates/[id]':  'Get affiliate details',
        'PUT /api/admin/affiliates/[id]':  'Update affiliate',
        'DELETE /api/admin/affiliates/[id]':'Deactivate affiliate',
        'GET /api/admin/stats':            'Platform-wide statistics',
        'GET /api/admin/payout':           'Download Excel payout report',
        'GET /api/admin/destinations':     'List redirect destinations',
        'POST /api/admin/destinations':    'Add new destination'
      }
    },
    integration_examples: {
      javascript_snippet: `<script src="${base}/api/track/script.js"></script>\n<script>\n  AffiliateTracker.trackWalletConnect('0x...', 'ethereum');\n  AffiliateTracker.trackPurchase(99.99, 'USD', 'order-123');\n</script>`,
      s2s_postback: `curl -X POST ${base}/api/track/conversion \\\n  -H "Content-Type: application/json" \\\n  -d '{"affiliate_code":"ABC12345","conversion_type":"purchase","conversion_value":99.99}'`
    }
  });
};
