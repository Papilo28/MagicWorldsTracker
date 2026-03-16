// db/migrate.js — run with: node db/migrate.js
require('dotenv').config();
const { query } = require('../lib/db');

async function migrate() {
  console.log('Running database migrations...');

  await query(`
    CREATE TABLE IF NOT EXISTS affiliates (
      id            SERIAL PRIMARY KEY,
      affiliate_code VARCHAR(20) UNIQUE NOT NULL,
      email         VARCHAR(255) UNIQUE NOT NULL,
      name          VARCHAR(255) NOT NULL,
      website       VARCHAR(500),
      wallet_address VARCHAR(255),
      payment_method VARCHAR(50) DEFAULT 'crypto',
      commission_rate DECIMAL(5,4) DEFAULT 0.10,
      status        VARCHAR(20) DEFAULT 'pending',
      magic_token   VARCHAR(255),
      magic_token_expires TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS clicks (
      id            SERIAL PRIMARY KEY,
      affiliate_id  INTEGER REFERENCES affiliates(id),
      affiliate_code VARCHAR(20) NOT NULL,
      ip_address    VARCHAR(45),
      user_agent    TEXT,
      referer       TEXT,
      destination   VARCHAR(500),
      session_id    VARCHAR(100),
      clicked_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS conversions (
      id              SERIAL PRIMARY KEY,
      affiliate_id    INTEGER REFERENCES affiliates(id),
      affiliate_code  VARCHAR(20) NOT NULL,
      click_id        INTEGER REFERENCES clicks(id),
      conversion_type VARCHAR(50) DEFAULT 'purchase',
      conversion_value DECIMAL(18,8) DEFAULT 0,
      currency        VARCHAR(10) DEFAULT 'USD',
      commission_amount DECIMAL(18,8) DEFAULT 0,
      status          VARCHAR(20) DEFAULT 'pending',
      metadata        JSONB DEFAULT '{}',
      session_id      VARCHAR(100),
      ip_address      VARCHAR(45),
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS redirect_destinations (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      url         VARCHAR(500) NOT NULL,
      is_default  BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Seed default destination if empty
  await query(`
    INSERT INTO redirect_destinations (name, url, is_default)
    SELECT 'Default', $1, TRUE
    WHERE NOT EXISTS (SELECT 1 FROM redirect_destinations WHERE is_default = TRUE);
  `, [process.env.DEFAULT_REDIRECT_URL || 'https://example.com']);

  // Indexes
  await query(`CREATE INDEX IF NOT EXISTS idx_clicks_affiliate_code    ON clicks(affiliate_code);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_clicks_session            ON clicks(session_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_conversions_affiliate     ON conversions(affiliate_code);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_conversions_session       ON conversions(session_id);`);

  console.log('✅ Migrations complete.');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
