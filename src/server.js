require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { initDB } = require('./database/init');
const affiliateRoutes = require('./routes/affiliates');
const trackingRoutes = require('./routes/tracking');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const programRoutes = require('./routes/programs');
const merchantRoutes = require('./routes/merchants');
const superadminRoutes = require('./routes/superadmin');

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://magictracker.cc';

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // disabled to allow inline scripts in static pages
  crossOriginEmbedderPolicy: false,
}));

// CORS — allow both the frontend domain and any localhost for dev
const allowedOrigins = [
  FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(null, true); // permissive for affiliate embed use-case; tighten if needed
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-API-Secret'],
}));

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many requests, please try again later.' } });

app.use('/api/', apiLimiter);
app.use('/api/affiliates/login', authLimiter);
app.use('/api/affiliates/forgot-password', authLimiter);
app.use('/api/merchants/login', authLimiter);
app.use('/api/merchants/forgot-password', authLimiter);
app.use('/api/superadmin/login', authLimiter);
app.use('/api/admin/login', authLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Trust proxy (needed for rate limiting behind Railway/Render)
app.set('trust proxy', 1);

// Static files (only served when running standalone — not needed in split hosting)
app.use(express.static(path.join(__dirname, '..', 'public')));

// API Routes
app.use('/api/affiliates', affiliateRoutes);
app.use('/api/track', trackingRoutes);
app.use('/postback', (req, res, next) => { req.url = '/postback' + (req.url === '/' ? '' : req.url); trackingRoutes(req, res, next); });
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/programs', programRoutes);
app.use('/api/merchants', merchantRoutes);
app.use('/api/superadmin', superadminRoutes);


// Our Flame / generic click tracking endpoint
// URL: /click?offer_id=FLAME&pub_id={USER_ID}&aff_id={ALT}
app.get('/click', async (req, res) => {
  try {
    const { offer_id, pub_id, aff_id, aff_code, dest } = req.query;
    const { queryOne, query } = require('./database/init');
    const { generateVisitorId } = require('./utils/helpers');
    const DEFAULT_URL = process.env.DEFAULT_REDIRECT_URL || 'https://magictracker.cc';

    const code = aff_code || pub_id || aff_id;
    if (!code) return res.redirect(DEFAULT_URL);

    const affiliate = await queryOne(
      `SELECT * FROM affiliates WHERE affiliate_code = $1 AND status = 'active'`, [code]
    );
    if (!affiliate) return res.redirect(DEFAULT_URL);

    const merchant = await queryOne(`SELECT * FROM merchants WHERE id = $1`, [affiliate.merchant_id]);
    const visitorId = (req.cookies && req.cookies['aff_vid']) || generateVisitorId();

    await query(
      `INSERT INTO clicks (merchant_id, affiliate_id, visitor_id, ip_address, user_agent, referer, destination_url, sub_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [affiliate.merchant_id, affiliate.id, visitorId, req.ip,
       req.headers['user-agent']||'', req.headers.referer||'',
       dest || merchant?.default_redirect_url || DEFAULT_URL,
       offer_id || '']
    );

    const cookieOptions = { maxAge: 30*86400000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV==='production' };
    res.cookie('aff_vid', visitorId, cookieOptions);
    res.cookie('aff_code', code, cookieOptions);
    if (offer_id) res.cookie('aff_offer', offer_id, cookieOptions);

    const destination = dest || merchant?.default_redirect_url || DEFAULT_URL;
    res.redirect(destination);
  } catch(err) {
    console.error('[Click] Error:', err.message);
    res.redirect(process.env.DEFAULT_REDIRECT_URL || 'https://magictracker.cc');
  }
});

// Redirect tracking short URLs
// The tracking router handles /r/:affiliateCode at /api/track/r/:affiliateCode
// We proxy the short /r/:code URL by forwarding query params and handling inline
app.get('/r/:affiliateCode', async (req, res) => {
  try {
    const { queryOne, query } = require('./database/init');
    const { generateVisitorId } = require('./utils/helpers');
    const affiliateCode = req.params.affiliateCode;
    const dest = req.query.dest;
    const subid = req.query.subid;
    const ATTRIBUTION_WINDOW_DAYS = parseInt(process.env.ATTRIBUTION_WINDOW_DAYS) || 30;
    const DEFAULT_URL = process.env.DEFAULT_REDIRECT_URL || 'https://magictracker.cc';

    const affiliate = await queryOne(
      `SELECT * FROM affiliates WHERE affiliate_code = $1 AND status = 'active'`, [affiliateCode]
    );
    if (!affiliate) return res.redirect(DEFAULT_URL);

    let programRecord = await queryOne(
      `SELECT * FROM programs WHERE merchant_id = $1 AND is_default = 1 AND is_active = 1`, [affiliate.merchant_id]
    );

    const visitorId = (req.cookies && req.cookies['aff_vid']) || generateVisitorId();

    await query(
      `INSERT INTO clicks (merchant_id, affiliate_id, program_id, visitor_id, ip_address, user_agent, referer, destination_url, sub_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [affiliate.merchant_id, affiliate.id, programRecord?.id || null, visitorId, req.ip, req.headers['user-agent'] || '', req.headers.referer || '', dest || null, subid || null]
    );

    const cookieDuration = programRecord?.cookie_duration || ATTRIBUTION_WINDOW_DAYS;
    const cookieOptions = { maxAge: cookieDuration * 86400000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' };
    res.cookie('aff_vid', visitorId, cookieOptions);
    res.cookie('aff_code', affiliateCode, cookieOptions);
    if (programRecord) res.cookie('aff_prog', programRecord.slug, cookieOptions);

    let destination = dest;
    if (!destination) {
      if (programRecord && programRecord.landing_page_url) {
        destination = programRecord.landing_page_url;
      } else {
        const merchant = await queryOne('SELECT default_redirect_url FROM merchants WHERE id = $1', [affiliate.merchant_id]);
        destination = merchant?.default_redirect_url;
      }
    }

    // Ensure destination is a valid absolute URL, not the tracker itself
    if (!destination || destination === 'https://magictracker.cc' || destination === process.env.FRONTEND_URL) {
      console.warn('Redirect destination not set for merchant', affiliate.merchant_id, '- using DEFAULT_URL');
      destination = DEFAULT_URL;
    }

    if (!destination.startsWith('http')) destination = 'https://' + destination;
    res.redirect(destination);
  } catch (err) {
    console.error('Redirect error:', err);
    res.redirect(process.env.DEFAULT_REDIRECT_URL || 'https://magictracker.cc');
  }
});

// Page routes (for standalone mode)
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'dashboard', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));
app.get('/merchant', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'merchant', 'index.html')));
app.get('/superadmin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'superadmin', 'index.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'reset-password.html')));
app.get('/api-docs', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'api.html')));
app.get('/api', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'api.html')));
app.get('/solar-lead', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'solar-lead.html')));
app.get('/field-agent', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'field-agent.html')));
app.get('/campaign', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'campaign.html')));


// Config diagnostic — shows which keys are set (NOT their values)
app.get('/api/health/config', (req, res) => {
  res.json({
    status: 'ok',
    env: {
      BREVO_API_KEY: process.env.BREVO_API_KEY
        ? (process.env.BREVO_API_KEY.includes('your-brevo') ? 'PLACEHOLDER_NOT_SET' : 'SET (' + process.env.BREVO_API_KEY.length + ' chars)')
        : 'MISSING',
      EMAIL_FROM: process.env.EMAIL_FROM || 'MISSING',
      FLW_SECRET_KEY: process.env.FLW_SECRET_KEY
        ? 'SET (' + process.env.FLW_SECRET_KEY.length + ' chars)'
        : 'MISSING',
      FLW_PUBLIC_KEY: process.env.FLW_PUBLIC_KEY
        ? 'SET (' + process.env.FLW_PUBLIC_KEY.length + ' chars)'
        : 'MISSING',
      DATABASE_URL: process.env.DATABASE_URL ? 'SET' : 'MISSING',
      JWT_SECRET: process.env.JWT_SECRET ? 'SET' : 'MISSING',
      BASE_URL: process.env.BASE_URL || 'MISSING',
      FRONTEND_URL: process.env.FRONTEND_URL || 'MISSING',
    }
  });
});


// Superadmin: get all solar leads with agent info
app.get('/api/superadmin/solar-leads', async (req, res) => {
  try {
    const { queryAll } = require('./database/init');
    const leads = await queryAll(`
      SELECT sl.*, co.status, co.created_at, co.commission_amount, co.id as conversion_id,
             a.affiliate_code, a.name as agent_name, a.email as agent_email
      FROM solar_leads sl
      LEFT JOIN conversions co ON sl.conversion_id = co.id
      LEFT JOIN affiliates a ON sl.affiliate_id = a.id
      ORDER BY sl.created_at DESC
      LIMIT 500
    `);
    res.json({ leads, total: leads.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Superadmin: get all field agents with lead counts
app.get('/api/superadmin/agents', async (req, res) => {
  try {
    const { queryAll } = require('./database/init');
    const agents = await queryAll(`
      SELECT a.id, a.name, a.affiliate_code, a.email, a.created_at,
             COUNT(DISTINCT sl.id) as total_leads,
             COUNT(DISTINCT CASE WHEN co.status='qualified' THEN sl.id END) as qualified_leads,
             COUNT(DISTINCT CASE WHEN co.status='converted' THEN sl.id END) as converted_leads
      FROM affiliates a
      LEFT JOIN solar_leads sl ON a.id = sl.affiliate_id
      LEFT JOIN conversions co ON sl.conversion_id = co.id
      GROUP BY a.id
      ORDER BY total_leads DESC
      LIMIT 200
    `);
    res.json({ agents, total: agents.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.0.0' }));

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start
initDB().then(() => {
  app.listen(PORT, () => {
    console.log('\n============================================================');
    console.log('  MAGIC WORLDS TRACKER v2.0 — Production');
    console.log('============================================================');
    console.log(`  API running at: http://localhost:${PORT}`);
    console.log(`  Frontend URL:   ${FRONTEND_URL}`);
    console.log('============================================================\n');
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

module.exports = app;
