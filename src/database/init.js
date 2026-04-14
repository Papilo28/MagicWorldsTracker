require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Helper: run a query
async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

// Helper: get single row
async function queryOne(text, params) {
  const res = await query(text, params);
  return res.rows[0] || null;
}

// Helper: get all rows
async function queryAll(text, params) {
  const res = await query(text, params);
  return res.rows;
}

async function initDB() {
  // Tables are created with IF NOT EXISTS — no data is ever dropped on restart

  await query(`
    CREATE TABLE IF NOT EXISTS super_admins (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS merchants (
      id SERIAL PRIMARY KEY,
      company_name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      website_url TEXT,
      logo_url TEXT,
      default_redirect_url TEXT NOT NULL,
      commission_type TEXT DEFAULT 'percentage',
      commission_value REAL DEFAULT 10,
      cookie_duration INTEGER DEFAULT 30,
      currency TEXT DEFAULT 'USD',
      status TEXT DEFAULT 'active',
      plan TEXT DEFAULT 'starter',
      trial_started_at TIMESTAMPTZ DEFAULT NOW(),
      trial_ends_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days'),
      trial_status TEXT DEFAULT 'active',
      subscribed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS merchant_api_keys (
      id SERIAL PRIMARY KEY,
      merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      key_name TEXT NOT NULL,
      api_key TEXT UNIQUE NOT NULL,
      api_secret TEXT NOT NULL,
      permissions TEXT DEFAULT 'full',
      is_active INTEGER DEFAULT 1,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS affiliates (
      id SERIAL PRIMARY KEY,
      merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      affiliate_code TEXT UNIQUE NOT NULL,
      wallet_address TEXT,
      wallet_private_key_encrypted TEXT,
      payment_method TEXT DEFAULT 'crypto',
      status TEXT DEFAULT 'active',
      password_hash TEXT,
      reset_token TEXT,
      reset_token_expires TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(merchant_id, email)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS programs (
      id SERIAL PRIMARY KEY,
      merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT,
      landing_page_url TEXT NOT NULL,
      commission_type TEXT DEFAULT 'percentage',
      commission_value REAL DEFAULT 10,
      cookie_duration INTEGER DEFAULT 30,
      currency TEXT DEFAULT 'USD',
      is_default INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(merchant_id, slug)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS affiliate_programs (
      id SERIAL PRIMARY KEY,
      affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
      program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'active',
      custom_commission_type TEXT,
      custom_commission_value REAL,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(affiliate_id, program_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS clicks (
      id SERIAL PRIMARY KEY,
      merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
      program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
      visitor_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      referer TEXT,
      destination_url TEXT,
      sub_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS conversions (
      id SERIAL PRIMARY KEY,
      merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
      program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
      click_id INTEGER REFERENCES clicks(id) ON DELETE SET NULL,
      visitor_id TEXT,
      external_visitor_id TEXT,
      conversion_type TEXT NOT NULL DEFAULT 'lead',
      conversion_value REAL DEFAULT 0,
      commission_amount REAL DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      status TEXT DEFAULT 'pending',
      metadata TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS payouts (
      id SERIAL PRIMARY KEY,
      merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
      program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      status TEXT DEFAULT 'pending',
      payment_method TEXT,
      transaction_id TEXT,
      notes TEXT,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS destinations (
      id SERIAL PRIMARY KEY,
      merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS assets (
      id SERIAL PRIMARY KEY,
      merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      file_url TEXT,
      content TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);


  await query(`
    CREATE TABLE IF NOT EXISTS solar_leads (
      id SERIAL PRIMARY KEY,
      conversion_id INTEGER REFERENCES conversions(id) ON DELETE SET NULL,
      affiliate_id INTEGER REFERENCES affiliates(id) ON DELETE SET NULL,
      merchant_id INTEGER REFERENCES merchants(id) ON DELETE SET NULL,
      click_id TEXT,
      affiliate_code TEXT,
      site_address TEXT,
      site_ownership TEXT,
      roof_type TEXT,
      asbestos_status TEXT,
      mpan_number TEXT,
      annual_kwh REAL,
      payback_hurdle REAL,
      contact_name TEXT,
      contact_phone TEXT,
      contact_email TEXT,
      company_name TEXT,
      notes TEXT,
      photos_urls TEXT,
      status TEXT DEFAULT 'pending',
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      user_type TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Drop any stale indexes that may exist from a previous broken schema
  // Create indexes if not exists
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_affiliates_merchant  ON affiliates(merchant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_affiliates_code      ON affiliates(affiliate_code)`,
    `CREATE INDEX IF NOT EXISTS idx_programs_merchant    ON programs(merchant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_clicks_merchant      ON clicks(merchant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_clicks_affiliate     ON clicks(affiliate_id)`,
    `CREATE INDEX IF NOT EXISTS idx_clicks_visitor       ON clicks(visitor_id)`,
    `CREATE INDEX IF NOT EXISTS idx_conversions_merchant ON conversions(merchant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_conversions_affiliate ON conversions(affiliate_id)`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_key         ON merchant_api_keys(api_key)`,
    `CREATE INDEX IF NOT EXISTS idx_merchants_slug       ON merchants(slug)`,
    `CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token)`,
  ];
  for (const sql of indexes) {
    try { await query(sql); } catch(e) { console.warn('Index warning (non-fatal):', e.message); }
  }

  // Seed super admin
  const admin = await queryOne('SELECT id FROM super_admins LIMIT 1');
  if (!admin) {
    const hash = bcrypt.hashSync(process.env.SUPER_ADMIN_PASSWORD || 'admin123', 10);
    await query(
      `INSERT INTO super_admins (name, email, password_hash, status) VALUES ($1, $2, $3, 'active')`,
      ['Super Admin', process.env.SUPER_ADMIN_EMAIL || 'admin@magictracker.cc', hash]
    );
    console.log('Super admin created:', process.env.SUPER_ADMIN_EMAIL);
  }

  console.log('Database initialized successfully!');
}

function generateApiKey() {
  return 'mwt_' + crypto.randomBytes(24).toString('hex');
}

function generateApiSecret() {
  return 'mwts_' + crypto.randomBytes(32).toString('hex');
}

function generateMerchantSlug(companyName) {
  return companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

module.exports = { query, queryOne, queryAll, initDB, generateApiKey, generateApiSecret, generateMerchantSlug };