const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, queryOne, queryAll, generateApiKey, generateApiSecret, generateMerchantSlug } = require('../database/init');
const { generateResetToken } = require('../utils/helpers');
const { sendPasswordReset, sendWelcomeMerchant } = require('../emails');

const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://magictracker.cc';

function authenticateMerchant(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    if (decoded.type !== 'merchant') return res.status(401).json({ error: 'Invalid token type' });
    req.merchant = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// POST /api/merchants/signup
router.post('/signup', async (req, res) => {
  try {
    const { company_name, email, password, website_url, default_redirect_url, plan } = req.body;
    if (!company_name || !email || !password) return res.status(400).json({ error: 'Company name, email, and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const existing = await queryOne('SELECT id FROM merchants WHERE email = $1', [email.toLowerCase()]);
    if (existing) return res.status(400).json({ error: 'An account with this email already exists' });

    let slug = generateMerchantSlug(company_name);
    let slugExists = await queryOne('SELECT id FROM merchants WHERE slug = $1', [slug]);
    let counter = 1;
    while (slugExists) { slug = generateMerchantSlug(company_name) + '-' + counter++; slugExists = await queryOne('SELECT id FROM merchants WHERE slug = $1', [slug]); }

    const passwordHash = bcrypt.hashSync(password, 10);
    const selectedPlan = plan || 'starter';
    const trialEnds = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const result = await query(
      `INSERT INTO merchants (company_name, slug, email, password_hash, website_url, default_redirect_url, status, plan, trial_started_at, trial_ends_at, trial_status)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,NOW(),$8,'active') RETURNING id`,
      [company_name, slug, email.toLowerCase(), passwordHash,
       website_url || '', default_redirect_url || website_url || 'https://magictracker.cc',
       selectedPlan, trialEnds]
    );
    const merchantId = result.rows[0].id;

    const apiKey = generateApiKey();
    const apiSecret = generateApiSecret();
    await query(`INSERT INTO merchant_api_keys (merchant_id, key_name, api_key, api_secret, permissions) VALUES ($1,'Default Key',$2,$3,'full')`, [merchantId, apiKey, apiSecret]);
    await query(`INSERT INTO programs (merchant_id, name, slug, description, landing_page_url, is_default, is_active) VALUES ($1,'Default Program','default','Main affiliate program',$2,1,1)`,
      [merchantId, default_redirect_url || website_url || 'https://magictracker.cc']);
    await query(`INSERT INTO destinations (merchant_id, name, url, is_default) VALUES ($1,'Default',$2,1)`,
      [merchantId, default_redirect_url || website_url || 'https://magictracker.cc']);

    // Add to Brevo with trial attributes
    const { addBrevoContact } = require('../emails');
    const nameParts = company_name.split(' ');
    await addBrevoContact({
      email: email.toLowerCase(),
      firstName: nameParts[0] || company_name,
      lastName: nameParts.slice(1).join(' ') || '',
      attributes: {
        ROLE: 'merchant',
        COMPANY: company_name,
        PLAN: selectedPlan,
        TRIAL_STARTED: new Date().toISOString().split('T')[0],
        TRIAL_ENDS: trialEnds.toISOString().split('T')[0],
        TRIAL_STATUS: 'active',
        DASHBOARD_URL: `${process.env.FRONTEND_URL || 'https://magictracker.cc'}/merchant`
      }
    });

    await sendWelcomeMerchant({ to: email.toLowerCase(), companyName: company_name, apiKey, apiSecret, plan: selectedPlan, trialEnds });

    const token = jwt.sign({ id: merchantId, email: email.toLowerCase(), slug, type: 'merchant' }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({
      message: 'Account created! Your 14-day free trial has started.',
      merchant: { id: merchantId, company_name, slug, email: email.toLowerCase(), plan: selectedPlan, trial_ends_at: trialEnds },
      api_credentials: { api_key: apiKey, api_secret: apiSecret },
      token
    });
  } catch (err) {
    console.error('Merchant signup error:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// POST /api/merchants/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const merchant = await queryOne('SELECT * FROM merchants WHERE email = $1', [email.toLowerCase()]);
    if (!merchant) return res.status(401).json({ error: 'Invalid credentials' });
    if (merchant.status !== 'active') return res.status(403).json({ error: 'Account is inactive or suspended' });
    if (!bcrypt.compareSync(password, merchant.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: merchant.id, email: merchant.email, slug: merchant.slug, type: 'merchant' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login successful', merchant: { id: merchant.id, company_name: merchant.company_name, slug: merchant.slug, email: merchant.email }, token });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/merchants/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const merchant = await queryOne(`SELECT * FROM merchants WHERE email = $1 AND status = 'active'`, [email.toLowerCase()]);
    if (!merchant) return res.json({ message: 'If an account exists, a reset email has been sent.' });
    const token = generateResetToken();
    const expires = new Date(Date.now() + 3600000);
    await query('DELETE FROM password_resets WHERE email = $1 AND user_type = $2', [email.toLowerCase(), 'merchant']);
    await query('INSERT INTO password_resets (email, user_type, token, expires_at) VALUES ($1,$2,$3,$4)', [email.toLowerCase(), 'merchant', token, expires]);
    const resetLink = `${FRONTEND_URL}/reset-password?token=${token}&type=merchant`;
    await sendPasswordReset({ to: email.toLowerCase(), resetLink, userType: 'merchant' });
    res.json({ message: 'If an account exists, a reset email has been sent.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// POST /api/merchants/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const reset = await queryOne(`SELECT * FROM password_resets WHERE token = $1 AND user_type = 'merchant' AND used = FALSE AND expires_at > NOW()`, [token]);
    if (!reset) return res.status(400).json({ error: 'Invalid or expired reset token' });
    const hash = bcrypt.hashSync(password, 10);
    await query('UPDATE merchants SET password_hash = $1 WHERE email = $2', [hash, reset.email]);
    await query('UPDATE password_resets SET used = TRUE WHERE id = $1', [reset.id]);
    res.json({ message: 'Password reset successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// GET /api/merchants/me
router.get('/me', authenticateMerchant, async (req, res) => {
  try {
    const merchant = await queryOne(`SELECT id, company_name, slug, email, website_url, logo_url, default_redirect_url, commission_type, commission_value, cookie_duration, currency, status, plan, trial_started_at, trial_ends_at, trial_status, subscribed_at, created_at FROM merchants WHERE id = $1`, [req.merchant.id]);
    if (!merchant) return res.status(404).json({ error: 'Merchant not found' });
    res.json({ merchant });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});


// GET /api/merchants/trial-status
router.get('/trial-status', authenticateMerchant, async (req, res) => {
  try {
    const merchant = await queryOne(
      `SELECT id, plan, trial_started_at, trial_ends_at, trial_status, subscribed_at FROM merchants WHERE id = $1`,
      [req.merchant.id]
    );
    if (!merchant) return res.status(404).json({ error: 'Merchant not found' });

    const now = new Date();
    const trialEnd = new Date(merchant.trial_ends_at);
    const daysLeft = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));
    const isExpired = now > trialEnd && merchant.trial_status === 'active';

    // Auto-expire in DB if past end date
    if (isExpired) {
      await query(`UPDATE merchants SET trial_status = 'expired' WHERE id = $1`, [req.merchant.id]);
      // Update Brevo contact
      const { addBrevoContact } = require('../emails');
      await addBrevoContact({
        email: merchant.email || req.merchant.email,
        firstName: '',
        attributes: { TRIAL_STATUS: 'expired' }
      });
    }

    res.json({
      plan: merchant.plan || 'starter',
      trial_started_at: merchant.trial_started_at,
      trial_ends_at: merchant.trial_ends_at,
      trial_status: isExpired ? 'expired' : (merchant.trial_status || 'active'),
      days_left: daysLeft,
      is_subscribed: !!merchant.subscribed_at,
      subscribed_at: merchant.subscribed_at
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch trial status' });
  }
});

// PUT /api/merchants/me
router.put('/me', authenticateMerchant, async (req, res) => {
  try {
    const { company_name, website_url, logo_url, default_redirect_url, commission_type, commission_value, cookie_duration, currency } = req.body;
    const updates = []; const params = []; let i = 1;
    if (company_name) { updates.push(`company_name = $${i++}`); params.push(company_name); }
    if (website_url !== undefined) { updates.push(`website_url = $${i++}`); params.push(website_url); }
    if (logo_url !== undefined) { updates.push(`logo_url = $${i++}`); params.push(logo_url); }
    if (default_redirect_url) { updates.push(`default_redirect_url = $${i++}`); params.push(default_redirect_url); }
    if (commission_type) { updates.push(`commission_type = $${i++}`); params.push(commission_type); }
    if (commission_value !== undefined) { updates.push(`commission_value = $${i++}`); params.push(commission_value); }
    if (cookie_duration !== undefined) { updates.push(`cookie_duration = $${i++}`); params.push(cookie_duration); }
    if (currency) { updates.push(`currency = $${i++}`); params.push(currency); }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    updates.push(`updated_at = NOW()`); params.push(req.merchant.id);
    await query(`UPDATE merchants SET ${updates.join(', ')} WHERE id = $${i}`, params);
    const merchant = await queryOne(`SELECT id, company_name, slug, email, website_url, logo_url, default_redirect_url, commission_type, commission_value, cookie_duration, currency, status FROM merchants WHERE id = $1`, [req.merchant.id]);
    res.json({ message: 'Profile updated', merchant });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// GET /api/merchants/api-keys
router.get('/api-keys', authenticateMerchant, async (req, res) => {
  try {
    const keys = await queryAll(`SELECT id, key_name, api_key, permissions, is_active, last_used_at, created_at FROM merchant_api_keys WHERE merchant_id = $1 ORDER BY created_at DESC`, [req.merchant.id]);
    const masked = keys.map(k => ({ ...k, api_key: k.api_key.substring(0, 8) + '...' + k.api_key.slice(-4) }));
    res.json({ api_keys: masked });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// POST /api/merchants/api-keys
router.post('/api-keys', authenticateMerchant, async (req, res) => {
  try {
    const { key_name = 'New Key', permissions = 'full' } = req.body;
    const apiKey = generateApiKey(); const apiSecret = generateApiSecret();
    const result = await query(`INSERT INTO merchant_api_keys (merchant_id, key_name, api_key, api_secret, permissions) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [req.merchant.id, key_name, apiKey, apiSecret, permissions]);
    res.status(201).json({ message: 'API key created', api_key: { id: result.rows[0].id, key_name, api_key: apiKey, api_secret: apiSecret, permissions } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// DELETE /api/merchants/api-keys/:id
router.delete('/api-keys/:id', authenticateMerchant, async (req, res) => {
  try {
    const key = await queryOne('SELECT * FROM merchant_api_keys WHERE id = $1 AND merchant_id = $2', [req.params.id, req.merchant.id]);
    if (!key) return res.status(404).json({ error: 'API key not found' });
    const count = await queryOne('SELECT COUNT(*) as count FROM merchant_api_keys WHERE merchant_id = $1', [req.merchant.id]);
    if (parseInt(count.count) <= 1) return res.status(400).json({ error: 'Cannot delete the last API key' });
    await query('DELETE FROM merchant_api_keys WHERE id = $1', [req.params.id]);
    res.json({ message: 'API key deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

// GET /api/merchants/stats
router.get('/stats', authenticateMerchant, async (req, res) => {
  try {
    const affiliates = await queryOne(`SELECT COUNT(*) as total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active FROM affiliates WHERE merchant_id = $1`, [req.merchant.id]);
    const clicks = await queryOne(`SELECT COUNT(*) as total_clicks, COUNT(DISTINCT visitor_id) as unique_visitors FROM clicks WHERE merchant_id = $1`, [req.merchant.id]);
    const conversions = await queryOne(`SELECT COUNT(*) as total, COALESCE(SUM(conversion_value),0) as total_value, COALESCE(SUM(commission_amount),0) as total_commission FROM conversions WHERE merchant_id = $1`, [req.merchant.id]);
    const conversionsByType = await queryAll(`SELECT conversion_type, COUNT(*) as count, COALESCE(SUM(conversion_value),0) as value FROM conversions WHERE merchant_id = $1 GROUP BY conversion_type`, [req.merchant.id]);
    const topAffiliates = await queryAll(`SELECT a.id, a.name, a.email, a.affiliate_code, COUNT(DISTINCT c.id) as conversions, COALESCE(SUM(c.conversion_value),0) as revenue, COALESCE(SUM(c.commission_amount),0) as earnings FROM affiliates a LEFT JOIN conversions c ON a.id = c.affiliate_id WHERE a.merchant_id = $1 GROUP BY a.id ORDER BY revenue DESC LIMIT 10`, [req.merchant.id]);
    res.json({ affiliates: { total: parseInt(affiliates.total), active: parseInt(affiliates.active || 0) }, clicks: { total_clicks: parseInt(clicks.total_clicks), unique_visitors: parseInt(clicks.unique_visitors) }, conversions: { total: parseInt(conversions.total), total_value: parseFloat(conversions.total_value), total_commission: parseFloat(conversions.total_commission), by_type: conversionsByType }, top_affiliates: topAffiliates });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});


// GET /api/merchants/assets
router.get('/assets', authenticateMerchant, async (req, res) => {
  try {
    const assets = await queryAll(
      `SELECT id, name, type, file_url, content, is_active, created_at FROM assets WHERE merchant_id = $1 ORDER BY created_at DESC`,
      [req.merchant.id]
    );
    res.json({ assets });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch assets' });
  }
});

// POST /api/merchants/assets
router.post('/assets', authenticateMerchant, async (req, res) => {
  try {
    const { name, type, file_url, content } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'Name and type are required' });
    const validTypes = ['image', 'pdf', 'banner', 'video', 'copy', 'link'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid asset type' });
    const result = await query(
      `INSERT INTO assets (merchant_id, name, type, file_url, content, is_active) VALUES ($1,$2,$3,$4,$5,1) RETURNING *`,
      [req.merchant.id, name, type, file_url || null, content || null]
    );
    res.status(201).json({ asset: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save asset' });
  }
});

// DELETE /api/merchants/assets/:id
router.delete('/assets/:id', authenticateMerchant, async (req, res) => {
  try {
    const asset = await queryOne('SELECT id FROM assets WHERE id = $1 AND merchant_id = $2', [req.params.id, req.merchant.id]);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    await query('DELETE FROM assets WHERE id = $1', [req.params.id]);
    res.json({ message: 'Asset deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete asset' });
  }
});

// POST /api/merchants/subscribe — verify Flutterwave payment then activate plan
router.post('/subscribe', authenticateMerchant, async (req, res) => {
  try {
    const { plan, tx_ref, transaction_id } = req.body;
    const validPlans = ['starter', 'pro', 'scale'];
    const planPrices = { starter: 1, pro: 2, scale: 3 };
    const selectedPlan = validPlans.includes(plan) ? plan : 'starter';
    const expectedAmount = planPrices[selectedPlan];

    // Verify payment with Flutterwave
    if (!transaction_id) {
      return res.status(400).json({ error: 'Payment transaction ID is required' });
    }

    const FLW_SECRET = process.env.FLW_SECRET_KEY || 'FLWSECK-971a049cc7c0894f38b371e0003e0010-19d43212983vt-X';
    const { default: fetch } = await import('node-fetch');
    const verifyRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, {
      headers: { Authorization: `Bearer ${FLW_SECRET}` }
    });
    const verifyData = await verifyRes.json();

    if (!verifyRes.ok || verifyData.status !== 'success') {
      console.error('[Payment] Flutterwave verification failed:', verifyData);
      return res.status(400).json({ error: 'Payment verification failed. Please try again.' });
    }

    const txData = verifyData.data;
    if (txData.status !== 'successful') {
      return res.status(400).json({ error: 'Payment was not successful: ' + txData.status });
    }
    if (parseFloat(txData.amount) < expectedAmount) {
      return res.status(400).json({ error: `Payment amount mismatch. Expected $${expectedAmount}, got $${txData.amount}` });
    }
    if (txData.currency !== 'USD') {
      return res.status(400).json({ error: 'Payment must be in USD' });
    }

    // Payment verified — activate plan
    await query(
      `UPDATE merchants SET plan = $1, trial_status = 'subscribed', subscribed_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [selectedPlan, req.merchant.id]
    );

    // Update Brevo
    try {
      const { addBrevoContact } = require('../emails');
      const m = await queryOne('SELECT email, company_name FROM merchants WHERE id = $1', [req.merchant.id]);
      if (m) await addBrevoContact({
        email: m.email, firstName: m.company_name,
        attributes: { TRIAL_STATUS: 'subscribed', PLAN: selectedPlan, SUBSCRIBED_AT: new Date().toISOString().split('T')[0] }
      });
    } catch(e) { console.warn('Brevo update failed:', e.message); }

    res.json({
      message: `Successfully subscribed to the ${selectedPlan} plan`,
      plan: selectedPlan,
      amount_paid: txData.amount,
      transaction_id: txData.id
    });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: 'Failed to activate subscription: ' + err.message });
  }
});

// POST /api/merchants/skip-trial — convert to free permanent tier
router.post('/skip-trial', authenticateMerchant, async (req, res) => {
  try {
    await query(
      `UPDATE merchants SET trial_status = 'skipped', subscribed_at = NOW(), plan = 'starter', updated_at = NOW() WHERE id = $1`,
      [req.merchant.id]
    );
    res.json({ message: 'Trial skipped. You are now on the free Starter plan.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to skip trial' });
  }
});

router.authenticateMerchant = authenticateMerchant;
module.exports = router;
