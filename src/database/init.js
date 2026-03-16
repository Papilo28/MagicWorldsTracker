const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', '..', 'data', 'affiliate-tracker.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  -- Affiliates table
  CREATE TABLE IF NOT EXISTS affiliates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    affiliate_code TEXT UNIQUE NOT NULL,
    wallet_address TEXT,
    wallet_private_key_encrypted TEXT,
    payment_method TEXT DEFAULT 'crypto',
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Clicks table (tracks redirect link clicks)
  CREATE TABLE IF NOT EXISTS clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    affiliate_id INTEGER NOT NULL,
    visitor_id TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    referer TEXT,
    destination_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(id)
  );

  -- Conversions table
  CREATE TABLE IF NOT EXISTS conversions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    affiliate_id INTEGER NOT NULL,
    click_id INTEGER,
    visitor_id TEXT,
    external_visitor_id TEXT,
    conversion_type TEXT NOT NULL,
    conversion_value REAL DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(id),
    FOREIGN KEY (click_id) REFERENCES clicks(id)
  );

  -- Payout records table
  CREATE TABLE IF NOT EXISTS payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    affiliate_id INTEGER NOT NULL,
    period_start DATETIME NOT NULL,
    period_end DATETIME NOT NULL,
    total_conversions INTEGER DEFAULT 0,
    total_amount REAL DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    status TEXT DEFAULT 'pending',
    exported_at DATETIME,
    paid_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(id)
  );

  -- Destinations table (where affiliate links redirect to)
  CREATE TABLE IF NOT EXISTS destinations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Create indexes for performance
  CREATE INDEX IF NOT EXISTS idx_clicks_affiliate_id ON clicks(affiliate_id);
  CREATE INDEX IF NOT EXISTS idx_clicks_visitor_id ON clicks(visitor_id);
  CREATE INDEX IF NOT EXISTS idx_clicks_created_at ON clicks(created_at);
  CREATE INDEX IF NOT EXISTS idx_conversions_affiliate_id ON conversions(affiliate_id);
  CREATE INDEX IF NOT EXISTS idx_conversions_visitor_id ON conversions(visitor_id);
  CREATE INDEX IF NOT EXISTS idx_conversions_created_at ON conversions(created_at);
  CREATE INDEX IF NOT EXISTS idx_affiliates_code ON affiliates(affiliate_code);
`);

// Insert default destination if none exists
const defaultDest = db.prepare('SELECT id FROM destinations WHERE is_default = 1').get();
if (!defaultDest) {
  db.prepare('INSERT INTO destinations (name, url, is_default) VALUES (?, ?, 1)')
    .run('Default', process.env.DEFAULT_REDIRECT_URL || 'https://example.com');
}

console.log('Database initialized successfully!');

module.exports = db;
