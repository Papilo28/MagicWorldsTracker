const express = require('express');
const router = express.Router();
const db = require('../database/init');
const { generateAffiliateCode } = require('../utils/helpers');
const { createAffiliateWallet, isValidAddress } = require('../utils/wallet');
const { 
  generateToken, 
  authenticateAffiliate,
  generateMagicLinkToken,
  verifyMagicLinkToken 
} = require('../middleware/auth');

// POST /api/affiliates/signup - Public signup
router.post('/signup', (req, res) => {
  try {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    // Check if email already exists
    const existing = db.prepare('SELECT id FROM affiliates WHERE email = ?').get(email);
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Generate unique affiliate code
    let affiliateCode;
    let codeExists = true;
    while (codeExists) {
      affiliateCode = generateAffiliateCode();
      codeExists = db.prepare('SELECT id FROM affiliates WHERE affiliate_code = ?').get(affiliateCode);
    }

    // Generate wallet for the affiliate
    const wallet = createAffiliateWallet();

    // Insert new affiliate
    const result = db.prepare(`
      INSERT INTO affiliates (name, email, affiliate_code, wallet_address, wallet_private_key_encrypted)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, email.toLowerCase(), affiliateCode, wallet.address, wallet.privateKeyEncrypted);

    const affiliate = db.prepare('SELECT * FROM affiliates WHERE id = ?').get(result.lastInsertRowid);

    // Generate login token
    const token = generateToken(affiliate);

    // Generate magic link for future logins
    const magicLinkToken = generateMagicLinkToken(email);
    const baseUrl = `http://${process.env.HOST || 'localhost'}:${process.env.PORT || 3000}`;
    const magicLink = `${baseUrl}/api/affiliates/login/magic?token=${magicLinkToken}`;

    res.status(201).json({
      message: 'Affiliate account created successfully!',
      affiliate: {
        id: affiliate.id,
        name: affiliate.name,
        email: affiliate.email,
        affiliate_code: affiliate.affiliate_code,
        wallet_address: affiliate.wallet_address,
        tracking_link: `${baseUrl}/r/${affiliate.affiliate_code}`
      },
      token,
      magic_link: magicLink,
      note: 'Save this magic link to login later, or request a new one via /api/affiliates/login'
    });

  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Failed to create affiliate account' });
  }
});

// POST /api/affiliates/login - Request magic link
router.post('/login', (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const affiliate = db.prepare('SELECT * FROM affiliates WHERE email = ? AND status = ?')
      .get(email.toLowerCase(), 'active');

    if (!affiliate) {
      // Don't reveal if email exists or not
      return res.json({ message: 'If this email is registered, a login link will be sent.' });
    }

    const magicLinkToken = generateMagicLinkToken(email);
    const baseUrl = `http://${process.env.HOST || 'localhost'}:${process.env.PORT || 3000}`;
    const magicLink = `${baseUrl}/api/affiliates/login/magic?token=${magicLinkToken}`;

    // In production, you'd email this link. For now, we return it directly.
    res.json({
      message: 'Login link generated (in production, this would be emailed)',
      magic_link: magicLink,
      expires_in: '15 minutes'
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to generate login link' });
  }
});

// GET /api/affiliates/login/magic - Verify magic link and return token
router.get('/login/magic', (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const decoded = verifyMagicLinkToken(token);
    if (!decoded) {
      return res.status(400).json({ error: 'Invalid or expired magic link' });
    }

    const affiliate = db.prepare('SELECT * FROM affiliates WHERE email = ? AND status = ?')
      .get(decoded.email.toLowerCase(), 'active');

    if (!affiliate) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }

    const authToken = generateToken(affiliate);
    const baseUrl = `http://${process.env.HOST || 'localhost'}:${process.env.PORT || 3000}`;

    // Redirect to dashboard with token, or return JSON
    if (req.headers.accept?.includes('text/html')) {
      res.redirect(`/dashboard?token=${authToken}`);
    } else {
      res.json({
        message: 'Login successful',
        token: authToken,
        affiliate: {
          id: affiliate.id,
          name: affiliate.name,
          email: affiliate.email,
          affiliate_code: affiliate.affiliate_code,
          wallet_address: affiliate.wallet_address,
          tracking_link: `${baseUrl}/r/${affiliate.affiliate_code}`
        }
      });
    }

  } catch (error) {
    console.error('Magic link error:', error);
    res.status(500).json({ error: 'Failed to verify login link' });
  }
});

// GET /api/affiliates/me - Get own profile (authenticated)
router.get('/me', authenticateAffiliate, (req, res) => {
  const baseUrl = `http://${process.env.HOST || 'localhost'}:${process.env.PORT || 3000}`;
  
  res.json({
    id: req.affiliate.id,
    name: req.affiliate.name,
    email: req.affiliate.email,
    affiliate_code: req.affiliate.affiliate_code,
    wallet_address: req.affiliate.wallet_address,
    payment_method: req.affiliate.payment_method,
    status: req.affiliate.status,
    tracking_link: `${baseUrl}/r/${req.affiliate.affiliate_code}`,
    created_at: req.affiliate.created_at
  });
});

// PUT /api/affiliates/me - Update own profile (authenticated)
router.put('/me', authenticateAffiliate, (req, res) => {
  try {
    const { name, wallet_address, payment_method } = req.body;
    const updates = [];
    const params = [];

    if (name) {
      updates.push('name = ?');
      params.push(name);
    }

    if (wallet_address) {
      if (!isValidAddress(wallet_address)) {
        return res.status(400).json({ error: 'Invalid wallet address' });
      }
      updates.push('wallet_address = ?');
      params.push(wallet_address);
    }

    if (payment_method && ['crypto', 'fiat', 'both'].includes(payment_method)) {
      updates.push('payment_method = ?');
      params.push(payment_method);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.affiliate.id);

    db.prepare(`UPDATE affiliates SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM affiliates WHERE id = ?').get(req.affiliate.id);
    const baseUrl = `http://${process.env.HOST || 'localhost'}:${process.env.PORT || 3000}`;

    res.json({
      message: 'Profile updated successfully',
      affiliate: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        affiliate_code: updated.affiliate_code,
        wallet_address: updated.wallet_address,
        payment_method: updated.payment_method,
        tracking_link: `${baseUrl}/r/${updated.affiliate_code}`
      }
    });

  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// GET /api/affiliates/stats - Get own statistics (authenticated)
router.get('/stats', authenticateAffiliate, (req, res) => {
  try {
    const affiliateId = req.affiliate.id;
    const { period } = req.query; // 'today', 'week', 'month', 'all'

    let dateFilter = '';
    const now = new Date();
    
    switch (period) {
      case 'today':
        dateFilter = `AND date(created_at) = date('now')`;
        break;
      case 'week':
        dateFilter = `AND created_at >= datetime('now', '-7 days')`;
        break;
      case 'month':
        dateFilter = `AND created_at >= datetime('now', '-30 days')`;
        break;
      default:
        dateFilter = '';
    }

    // Get click stats
    const clickStats = db.prepare(`
      SELECT 
        COUNT(*) as total_clicks,
        COUNT(DISTINCT visitor_id) as unique_visitors
      FROM clicks 
      WHERE affiliate_id = ? ${dateFilter}
    `).get(affiliateId);

    // Get conversion stats
    const conversionStats = db.prepare(`
      SELECT 
        COUNT(*) as total_conversions,
        SUM(conversion_value) as total_value,
        conversion_type,
        COUNT(*) as count
      FROM conversions 
      WHERE affiliate_id = ? ${dateFilter}
      GROUP BY conversion_type
    `).all(affiliateId);

    // Get total earnings
    const earnings = db.prepare(`
      SELECT 
        SUM(conversion_value) as total_earnings,
        currency
      FROM conversions 
      WHERE affiliate_id = ? ${dateFilter}
      GROUP BY currency
    `).all(affiliateId);

    // Get pending payouts
    const pendingPayouts = db.prepare(`
      SELECT SUM(total_amount) as pending
      FROM payouts 
      WHERE affiliate_id = ? AND status = 'pending'
    `).get(affiliateId);

    // Calculate conversion rate
    const conversionRate = clickStats.unique_visitors > 0 
      ? ((conversionStats.reduce((sum, c) => sum + c.count, 0) / clickStats.unique_visitors) * 100).toFixed(2)
      : 0;

    res.json({
      period: period || 'all',
      clicks: {
        total: clickStats.total_clicks,
        unique_visitors: clickStats.unique_visitors
      },
      conversions: {
        total: conversionStats.reduce((sum, c) => sum + c.count, 0),
        by_type: conversionStats.map(c => ({
          type: c.conversion_type,
          count: c.count
        }))
      },
      earnings: earnings.map(e => ({
        amount: e.total_earnings || 0,
        currency: e.currency
      })),
      pending_payout: pendingPayouts.pending || 0,
      conversion_rate: `${conversionRate}%`
    });

  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// GET /api/affiliates/conversions - Get own conversions list (authenticated)
router.get('/conversions', authenticateAffiliate, (req, res) => {
  try {
    const { page = 1, limit = 20, type } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE affiliate_id = ?';
    const params = [req.affiliate.id];

    if (type) {
      whereClause += ' AND conversion_type = ?';
      params.push(type);
    }

    const conversions = db.prepare(`
      SELECT 
        id,
        conversion_type,
        conversion_value,
        currency,
        metadata,
        created_at
      FROM conversions 
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM conversions ${whereClause}
    `).get(...params);

    res.json({
      conversions: conversions.map(c => ({
        ...c,
        metadata: c.metadata ? JSON.parse(c.metadata) : null
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total.count,
        pages: Math.ceil(total.count / limit)
      }
    });

  } catch (error) {
    console.error('Conversions error:', error);
    res.status(500).json({ error: 'Failed to fetch conversions' });
  }
});

module.exports = router;
