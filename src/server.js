require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

// Initialize database (creates tables if they don't exist)
const db = require('./database/init');

// Import routes
const affiliateRoutes = require('./routes/affiliates');
const trackingRoutes = require('./routes/tracking');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

// Middleware
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// API Routes
app.use('/api/affiliates', affiliateRoutes);
app.use('/api/track', trackingRoutes);
app.use('/api/admin', adminRoutes);

// Redirect route (short URL for affiliate links)
app.get('/r/:affiliateCode', (req, res, next) => {
  // Forward to tracking route
  req.url = `/api/track/r/${req.params.affiliateCode}`;
  next();
});
app.use('/api/track', trackingRoutes);

// Dashboard routes (serve HTML files)
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// API documentation endpoint
app.get('/api', (req, res) => {
  const baseUrl = `http://${HOST}:${PORT}`;
  res.json({
    name: 'Affiliate Tracking Platform API',
    version: '1.0.0',
    endpoints: {
      tracking: {
        'GET /r/:affiliateCode': 'Redirect link - tracks click and redirects to destination',
        'POST /api/track/conversion': 'S2S conversion tracking',
        'GET /api/track/script.js': 'JavaScript snippet for non-tech partners',
        'GET /api/track/info': 'Get current visitor tracking info'
      },
      affiliates: {
        'POST /api/affiliates/signup': 'Register new affiliate (public)',
        'POST /api/affiliates/login': 'Request magic login link',
        'GET /api/affiliates/login/magic': 'Verify magic link and get token',
        'GET /api/affiliates/me': 'Get own profile (auth required)',
        'PUT /api/affiliates/me': 'Update own profile (auth required)',
        'GET /api/affiliates/stats': 'Get own statistics (auth required)',
        'GET /api/affiliates/conversions': 'Get own conversions list (auth required)'
      },
      admin: {
        'POST /api/admin/login': 'Admin login',
        'GET /api/admin/affiliates': 'List all affiliates',
        'GET /api/admin/affiliates/:id': 'Get affiliate details',
        'PUT /api/admin/affiliates/:id': 'Update affiliate',
        'DELETE /api/admin/affiliates/:id': 'Deactivate affiliate',
        'GET /api/admin/stats': 'Platform-wide statistics',
        'GET /api/admin/reports/payout': 'Generate Excel payout report',
        'GET /api/admin/destinations': 'List redirect destinations',
        'POST /api/admin/destinations': 'Add new destination'
      }
    },
    integration_examples: {
      javascript_snippet: `<script src="${baseUrl}/api/track/script.js"></script>
<script>
  // After wallet connects:
  AffiliateTracker.trackWalletConnect('0x...', 'ethereum');
  
  // After purchase:
  AffiliateTracker.trackPurchase(99.99, 'USD', 'order-123');
  
  // Custom conversion:
  AffiliateTracker.convert('custom_event', { key: 'value' }, 10, 'USD');
</script>`,
      s2s_api: `curl -X POST ${baseUrl}/api/track/conversion \\
  -H "Content-Type: application/json" \\
  -d '{
    "affiliate_code": "ABC12345",
    "conversion_type": "wallet_connect",
    "conversion_value": 0,
    "metadata": {
      "wallet_address": "0x...",
      "chain": "ethereum"
    }
  }'`
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log('');
  console.log('='.repeat(60));
  console.log('  AFFILIATE TRACKING PLATFORM');
  console.log('='.repeat(60));
  console.log('');
  console.log(`  Server running at: http://${HOST}:${PORT}`);
  console.log('');
  console.log('  Quick Links:');
  console.log(`  - API Docs:        http://${HOST}:${PORT}/api`);
  console.log(`  - Admin Dashboard: http://${HOST}:${PORT}/admin`);
  console.log(`  - Affiliate Dashboard: http://${HOST}:${PORT}/dashboard`);
  console.log('');
  console.log('  Admin Credentials:');
  console.log(`  - Email: ${process.env.ADMIN_EMAIL || 'admin@yourcompany.com'}`);
  console.log(`  - Password: ${process.env.ADMIN_PASSWORD || 'admin123'}`);
  console.log('');
  console.log('='.repeat(60));
});

module.exports = app;
