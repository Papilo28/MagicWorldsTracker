const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { queryOne, queryAll, query } = require('../database/init');
const { generateToken, generateMagicLinkToken, verifyMagicLinkToken, authenticateAffiliate } = require('../middleware/auth');
const { generateAffiliateCode, generateResetToken } = require('../utils/helpers');
const { createAffiliateWallet, isValidAddress } = require('../utils/wallet');
const { sendMagicLink, sendPasswordReset, sendWelcomeAffiliate } = require('../emails');

const BASE_URL = process.env.BASE_URL || 'https://api.magictracker.cc';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://magictracker.cc';


// GET /api/affiliates/join/:slug — returns merchant info for affiliate registration form
router.get('/join/:slug', async (req, res) => {
  try {
    const merchant = await queryOne(
      `SELECT id, company_name, slug, logo_url, website_url, commission_type, commission_value, currency, cookie_duration FROM merchants WHERE slug = $1 AND status = 'active'`,
      [req.params.slug]
    );
    if (!merchant) return res.status(404).json({ error: 'Campaign not found' });

    const programCount = await queryOne('SELECT COUNT(*) as count FROM programs WHERE merchant_id = $1 AND is_active = 1', [merchant.id]);
    const affiliateCount = await queryOne('SELECT COUNT(*) as count FROM affiliates WHERE merchant_id = $1 AND status = $2', [merchant.id, 'active']);

    res.json({
      merchant,
      stats: {
        programs: parseInt(programCount?.count || 0),
        affiliates: parseInt(affiliateCount?.count || 0),
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch campaign info' });
  }
});

// GET /api/affiliates/merchants
router.get('/merchants', async (req, res) => {
  try {
    const merchants = await queryAll(
      `SELECT id, company_name, slug, logo_url, commission_type, commission_value, currency FROM merchants WHERE status = 'active' ORDER BY company_name ASC`
    );
    res.json({ merchants });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch merchants' });
  }
});

// GET /api/affiliates/merchants/:slug
router.get('/merchants/:slug', async (req, res) => {
  try {
    const merchant = await queryOne(
      `SELECT id, company_name, slug, logo_url, website_url, commission_type, commission_value, currency, cookie_duration FROM merchants WHERE slug = $1 AND status = 'active'`,
      [req.params.slug]
    );
    if (!merchant) return res.status(404).json({ error: 'Merchant not found' });
    res.json({ merchant });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch merchant' });
  }
});

// POST /api/affiliates/signup
router.post('/signup', async (req, res) => {
  try {
    const { name, email, merchant_id, merchant_slug } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

    let merchant = null;
    if (merchant_id) {
      merchant = await queryOne(`SELECT * FROM merchants WHERE id = $1 AND status = 'active'`, [merchant_id]);
    } else if (merchant_slug) {
      merchant = await queryOne(`SELECT * FROM merchants WHERE slug = $1 AND status = 'active'`, [merchant_slug]);
    }
    if (!merchant) return res.status(400).json({ error: 'Please select a valid merchant to join' });

    const existing = await queryOne('SELECT * FROM affiliates WHERE email = $1 AND merchant_id = $2', [email.toLowerCase(), merchant.id]);
    if (existing) return res.status(400).json({ error: 'You are already registered with this merchant' });

    const affiliateCode = generateAffiliateCode();
    const wallet = createAffiliateWallet();

    const result = await query(
      `INSERT INTO affiliates (merchant_id, name, email, affiliate_code, wallet_address, wallet_private_key_encrypted, payment_method, status) VALUES ($1,$2,$3,$4,$5,$6,'crypto','active') RETURNING *`,
      [merchant.id, name, email.toLowerCase(), affiliateCode, wallet.address, wallet.privateKeyEncrypted]
    );
    const affiliate = result.rows[0];

    const defaultProgram = await queryOne('SELECT id FROM programs WHERE merchant_id = $1 AND is_default = 1', [merchant.id]);
    if (defaultProgram) {
      await query('INSERT INTO affiliate_programs (affiliate_id, program_id, status) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [affiliate.id, defaultProgram.id, 'active']);
    }

    const trackingLink = `${BASE_URL}/r/${affiliateCode}`;
    await sendWelcomeAffiliate({ to: email.toLowerCase(), name, affiliateCode, trackingLink, merchantName: merchant.company_name });

    const token = generateToken({ id: affiliate.id, email: affiliate.email, type: 'affiliate' });

    res.status(201).json({
      message: 'Affiliate account created successfully!',
      affiliate: { id: affiliate.id, name: affiliate.name, email: affiliate.email, affiliate_code: affiliateCode, wallet_address: wallet.address, tracking_link: trackingLink },
      merchant: { id: merchant.id, company_name: merchant.company_name, slug: merchant.slug },
      token,
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// POST /api/affiliates/login — sends magic link via email
router.post('/login', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    // Find ALL affiliate records for this email across all merchants
    const affiliates = await queryAll(
      `SELECT a.id, a.name, a.email, a.status FROM affiliates a WHERE a.email = $1`,
      [email.toLowerCase()]
    );

    if (!affiliates || affiliates.length === 0) {
      return res.status(404).json({ error: 'No affiliate account found with this email. Use a campaign signup link to register first.' });
    }

    const activeAff = affiliates.find(a => a.status === 'active');
    if (!activeAff) return res.status(403).json({ error: 'Your affiliate account is inactive.' });

    // Token scoped to email only — dashboard will load ALL campaigns for this email
    const magicToken = generateMagicLinkToken(activeAff.email, null);
    const magicLink = `${BASE_URL}/api/affiliates/login/magic?token=${magicToken}`;

    await sendMagicLink({ to: activeAff.email, magicLink, userName: activeAff.name });

    res.json({ message: 'Magic link sent! Check your email inbox.' });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/affiliates/login/magic
router.get('/login/magic', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  const decoded = verifyMagicLinkToken(token);
  if (!decoded) return res.redirect(`${FRONTEND_URL}/dashboard?error=invalid_token`);

  // Find any active affiliate record for this email
  const affiliate = await queryOne(
    `SELECT * FROM affiliates WHERE email = $1 AND status = 'active' LIMIT 1`,
    [decoded.email]
  );
  if (!affiliate) return res.redirect(`${FRONTEND_URL}/dashboard?error=not_found`);

  // Token carries email — dashboard uses /me/all to load all campaigns
  const authToken = generateToken({ id: affiliate.id, email: affiliate.email, type: 'affiliate' });
  res.redirect(`${FRONTEND_URL}/dashboard?token=${authToken}`);
});

// GET /api/affiliates/me — returns primary record + summary
router.get('/me', authenticateAffiliate, async (req, res) => {
  try {
    const affiliate = await queryOne(
      `SELECT a.*, m.company_name as merchant_name, m.slug as merchant_slug FROM affiliates a JOIN merchants m ON a.merchant_id = m.id WHERE a.id = $1`,
      [req.affiliate.id]
    );
    if (!affiliate) return res.status(404).json({ error: 'Affiliate not found' });
    delete affiliate.wallet_private_key_encrypted;
    delete affiliate.password_hash;
    delete affiliate.reset_token;
    res.json({ ...affiliate, tracking_link: `${BASE_URL}/r/${affiliate.affiliate_code}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// GET /api/affiliates/me/all — returns ALL campaigns for this email
router.get('/me/all', authenticateAffiliate, async (req, res) => {
  try {
    const email = req.affiliate.email;
    const campaigns = await queryAll(
      `SELECT
        a.id, a.name, a.email, a.affiliate_code, a.wallet_address,
        a.payment_method, a.status, a.created_at,
        m.id as merchant_id, m.company_name, m.slug as merchant_slug,
        m.website_url, m.commission_type, m.commission_value, m.currency,
        COUNT(DISTINCT cl.id) as total_clicks,
        COUNT(DISTINCT co.id) as total_conversions,
        COALESCE(SUM(co.commission_amount), 0) as total_earnings
       FROM affiliates a
       JOIN merchants m ON a.merchant_id = m.id
       LEFT JOIN clicks cl ON a.id = cl.affiliate_id
       LEFT JOIN conversions co ON a.id = co.affiliate_id
       WHERE a.email = $1 AND a.status = 'active'
       GROUP BY a.id, m.id
       ORDER BY total_earnings DESC`,
      [email]
    );

    const enriched = campaigns.map(c => ({
      ...c,
      tracking_link: `${BASE_URL}/r/${c.affiliate_code}`,
      wallet_private_key_encrypted: undefined,
      password_hash: undefined,
    }));

    res.json({
      email,
      name: campaigns[0]?.name || '',
      campaigns: enriched,
      total_campaigns: enriched.length,
      total_clicks: enriched.reduce((s, c) => s + parseInt(c.total_clicks || 0), 0),
      total_conversions: enriched.reduce((s, c) => s + parseInt(c.total_conversions || 0), 0),
      total_earnings: enriched.reduce((s, c) => s + parseFloat(c.total_earnings || 0), 0),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

// PUT /api/affiliates/me
router.put('/me', authenticateAffiliate, async (req, res) => {
  try {
    const { name, wallet_address, payment_method } = req.body;
    const updates = [];
    const params = [];
    let i = 1;

    if (name) { updates.push(`name = $${i++}`); params.push(name); }
    if (wallet_address) {
      if (!isValidAddress(wallet_address)) return res.status(400).json({ error: 'Invalid wallet address' });
      updates.push(`wallet_address = $${i++}`); params.push(wallet_address);
    }
    if (payment_method && ['crypto', 'fiat', 'both'].includes(payment_method)) {
      updates.push(`payment_method = $${i++}`); params.push(payment_method);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    updates.push(`updated_at = NOW()`);
    params.push(req.affiliate.id);

    const result = await query(`UPDATE affiliates SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`, params);
    const updated = result.rows[0];
    delete updated.wallet_private_key_encrypted;
    delete updated.password_hash;

    res.json({ message: 'Profile updated', affiliate: { ...updated, tracking_link: `${BASE_URL}/r/${updated.affiliate_code}` } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// GET /api/affiliates/stats
router.get('/stats', authenticateAffiliate, async (req, res) => {
  try {
    const { period = 'all' } = req.query;
    let dateFilter = '';
    if (period === 'today') dateFilter = `AND created_at >= CURRENT_DATE`;
    else if (period === 'week') dateFilter = `AND created_at >= NOW() - INTERVAL '7 days'`;
    else if (period === 'month') dateFilter = `AND created_at >= NOW() - INTERVAL '30 days'`;

    const clicks = await queryOne(`SELECT COUNT(*) as total, COUNT(DISTINCT visitor_id) as unique_visitors FROM clicks WHERE affiliate_id = $1 ${dateFilter}`, [req.affiliate.id]);
    const conversions = await queryOne(`SELECT COUNT(*) as total, COALESCE(SUM(conversion_value),0) as total_value, COALESCE(SUM(commission_amount),0) as total_commission FROM conversions WHERE affiliate_id = $1 ${dateFilter}`, [req.affiliate.id]);

    const total_clicks = parseInt(clicks.total);
    const total_conversions = parseInt(conversions.total);

    res.json({
      period,
      clicks: { total: total_clicks, unique: parseInt(clicks.unique_visitors) },
      conversions: { total: total_conversions, total_value: parseFloat(conversions.total_value), total_commission: parseFloat(conversions.total_commission) },
      conversion_rate: total_clicks > 0 ? ((total_conversions / total_clicks) * 100).toFixed(2) + '%' : '0%',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// GET /api/affiliates/programs
router.get('/programs', authenticateAffiliate, async (req, res) => {
  try {
    const aff = await queryOne('SELECT merchant_id FROM affiliates WHERE id = $1', [req.affiliate.id]);
    const programs = await queryAll(
      `SELECT p.id, p.name, p.slug, p.description, p.landing_page_url, p.commission_type, p.commission_value, p.cookie_duration, p.currency, ap.status as membership_status, ap.joined_at
       FROM affiliate_programs ap JOIN programs p ON ap.program_id = p.id
       WHERE ap.affiliate_id = $1 AND p.merchant_id = $2 AND p.is_active = 1 ORDER BY ap.joined_at DESC`,
      [req.affiliate.id, aff.merchant_id]
    );
    res.json({ programs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch programs' });
  }
});

// GET /api/affiliates/available-programs
router.get('/available-programs', authenticateAffiliate, async (req, res) => {
  try {
    const aff = await queryOne('SELECT merchant_id FROM affiliates WHERE id = $1', [req.affiliate.id]);
    const programs = await queryAll(
      `SELECT p.id, p.name, p.slug, p.description, p.commission_type, p.commission_value, p.currency,
       CASE WHEN ap.id IS NOT NULL AND ap.status = 'active' THEN 1 ELSE 0 END as is_member
       FROM programs p LEFT JOIN affiliate_programs ap ON p.id = ap.program_id AND ap.affiliate_id = $1
       WHERE p.merchant_id = $2 AND p.is_active = 1 ORDER BY p.is_default DESC, p.name ASC`,
      [req.affiliate.id, aff.merchant_id]
    );
    res.json({ programs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch programs' });
  }
});

// POST /api/affiliates/programs/:programId/join
router.post('/programs/:programId/join', authenticateAffiliate, async (req, res) => {
  try {
    const aff = await queryOne('SELECT merchant_id FROM affiliates WHERE id = $1', [req.affiliate.id]);
    const program = await queryOne('SELECT * FROM programs WHERE id = $1 AND merchant_id = $2 AND is_active = 1', [req.params.programId, aff.merchant_id]);
    if (!program) return res.status(404).json({ error: 'Program not found' });

    const existing = await queryOne('SELECT * FROM affiliate_programs WHERE affiliate_id = $1 AND program_id = $2', [req.affiliate.id, req.params.programId]);
    if (existing) {
      if (existing.status === 'active') return res.status(400).json({ error: 'Already a member of this program' });
      await query('UPDATE affiliate_programs SET status = $1 WHERE id = $2', ['active', existing.id]);
    } else {
      await query('INSERT INTO affiliate_programs (affiliate_id, program_id, status) VALUES ($1,$2,$3)', [req.affiliate.id, req.params.programId, 'active']);
    }
    res.json({ message: 'Successfully joined program', program: { id: program.id, name: program.name } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to join program' });
  }
});

// POST /api/affiliates/programs/:programId/leave
router.post('/programs/:programId/leave', authenticateAffiliate, async (req, res) => {
  try {
    const program = await queryOne('SELECT * FROM programs WHERE id = $1', [req.params.programId]);
    if (!program) return res.status(404).json({ error: 'Program not found' });
    if (program.is_default) return res.status(400).json({ error: 'Cannot leave the default program' });
    await query('UPDATE affiliate_programs SET status = $1 WHERE affiliate_id = $2 AND program_id = $3', ['inactive', req.affiliate.id, req.params.programId]);
    res.json({ message: 'Successfully left program' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to leave program' });
  }
});

// GET /api/affiliates/conversions
router.get('/conversions', authenticateAffiliate, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const conversions = await queryAll(
      `SELECT c.*, p.name as program_name FROM conversions c LEFT JOIN programs p ON c.program_id = p.id WHERE c.affiliate_id = $1 ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`,
      [req.affiliate.id, parseInt(limit), parseInt(offset)]
    );
    const total = await queryOne('SELECT COUNT(*) as count FROM conversions WHERE affiliate_id = $1', [req.affiliate.id]);
    res.json({ conversions, pagination: { page: parseInt(page), limit: parseInt(limit), total: parseInt(total.count), pages: Math.ceil(total.count / limit) } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch conversions' });
  }
});

// POST /api/affiliates/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const affiliate = await queryOne(`SELECT * FROM affiliates WHERE email = $1 AND status = 'active'`, [email.toLowerCase()]);
    // Always return success to avoid email enumeration
    if (!affiliate) return res.json({ message: 'If an account exists, a reset email has been sent.' });

    const token = generateResetToken();
    const expires = new Date(Date.now() + 3600000); // 1 hour
    await query('DELETE FROM password_resets WHERE email = $1 AND user_type = $2', [email.toLowerCase(), 'affiliate']);
    await query('INSERT INTO password_resets (email, user_type, token, expires_at) VALUES ($1,$2,$3,$4)', [email.toLowerCase(), 'affiliate', token, expires]);

    const FRONTEND_URL = process.env.FRONTEND_URL || 'https://magictracker.cc';
    const resetLink = `${FRONTEND_URL}/reset-password?token=${token}&type=affiliate`;
    await sendPasswordReset({ to: email.toLowerCase(), resetLink, userType: 'affiliate' });

    res.json({ message: 'If an account exists, a reset email has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// POST /api/affiliates/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const reset = await queryOne(`SELECT * FROM password_resets WHERE token = $1 AND user_type = 'affiliate' AND used = FALSE AND expires_at > NOW()`, [token]);
    if (!reset) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const hash = bcrypt.hashSync(password, 10);
    await query('UPDATE affiliates SET password_hash = $1 WHERE email = $2', [hash, reset.email]);
    await query('UPDATE password_resets SET used = TRUE WHERE id = $1', [reset.id]);

    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;

// ── POST /api/affiliates/bulk-create — generate N field agents at once ────
router.post('/bulk-create', async (req, res) => {
  try {
    const { merchant_slug, merchant_id, count, name_prefix, program_slug } = req.body;
    if (!count || count < 1 || count > 200) {
      return res.status(400).json({ error: 'Count must be between 1 and 200' });
    }

    let merchant = null;
    if (merchant_id) merchant = await queryOne(`SELECT * FROM merchants WHERE id=$1 AND status='active'`, [merchant_id]);
    else if (merchant_slug) merchant = await queryOne(`SELECT * FROM merchants WHERE slug=$1 AND status='active'`, [merchant_slug]);
    if (!merchant) return res.status(404).json({ error: 'Merchant not found' });

    let program = null;
    if (program_slug) {
      program = await queryOne(`SELECT * FROM programs WHERE merchant_id=$1 AND slug=$2`, [merchant.id, program_slug]);
    }
    if (!program) {
      program = await queryOne(`SELECT * FROM programs WHERE merchant_id=$1 AND is_default=1`, [merchant.id]);
    }

    const created = [];
    const prefix = name_prefix || 'Agent';
    const BASE_URL = process.env.BASE_URL || 'https://api.magictracker.cc';

    for (let i = 1; i <= count; i++) {
      const agentName = `${prefix} ${String(i).padStart(3,'0')}`;
      const agentEmail = `${prefix.toLowerCase().replace(/\s+/g,'-')}-${String(i).padStart(3,'0')}@field.${merchant.slug}.magictracker.cc`;
      const existingEmail = await queryOne(`SELECT id FROM affiliates WHERE email=$1 AND merchant_id=$2`, [agentEmail, merchant.id]);
      if (existingEmail) { created.push({ skipped: true, email: agentEmail }); continue; }

      const affiliateCode = generateAffiliateCode();
      const { createAffiliateWallet } = require('../utils/wallet');
      const wallet = createAffiliateWallet();

      const result = await query(
        `INSERT INTO affiliates (merchant_id, name, email, affiliate_code, wallet_address, wallet_private_key_encrypted, payment_method, status)
         VALUES ($1,$2,$3,$4,$5,$6,'crypto','active') RETURNING id`,
        [merchant.id, agentName, agentEmail, affiliateCode, wallet.address, wallet.privateKeyEncrypted]
      );
      const affId = result.rows[0].id;

      if (program) {
        await query(`INSERT INTO affiliate_programs (affiliate_id, program_id, status) VALUES ($1,$2,'active') ON CONFLICT DO NOTHING`, [affId, program.id]);
      }

      created.push({
        id: affId,
        name: agentName,
        email: agentEmail,
        affiliate_code: affiliateCode,
        tracking_link: `${BASE_URL}/r/${affiliateCode}`,
        lead_form_url: `https://magictracker.cc/solar-lead?aff=${affiliateCode}`,
      });
    }

    const successful = created.filter(a => !a.skipped);
    res.status(201).json({
      message: `Created ${successful.length} field agents`,
      total_requested: count,
      total_created: successful.length,
      merchant: { id: merchant.id, name: merchant.company_name, slug: merchant.slug },
      agents: created,
    });
  } catch (err) {
    console.error('Bulk create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/affiliates/solar-lead — submit a solar lead with full metadata ─
router.post('/solar-lead', async (req, res) => {
  try {
    const {
      aff_code, clickid,
      site_address, site_ownership, roof_type, asbestos_status,
      mpan_number, annual_kwh, payback_hurdle,
      contact_name, contact_phone, contact_email, company_name, notes
    } = req.body;

    if (!aff_code) return res.status(400).json({ error: 'Affiliate code is required' });
    if (!site_address) return res.status(400).json({ error: 'Site address is required' });

    const affiliate = await queryOne(`SELECT * FROM affiliates WHERE affiliate_code=$1 AND status='active'`, [aff_code]);
    if (!affiliate) return res.status(404).json({ error: 'Invalid affiliate code' });

    const merchant = await queryOne(`SELECT * FROM merchants WHERE id=$1`, [affiliate.merchant_id]);
    if (!merchant) return res.status(404).json({ error: 'Merchant not found' });

    const metadata = JSON.stringify({
      site_address, site_ownership, roof_type, asbestos_status,
      mpan_number, annual_kwh, payback_hurdle,
      contact_name, contact_phone, contact_email, company_name, notes,
      source: 'solar_lead_form', submitted_at: new Date().toISOString()
    });

    // Insert conversion record
    const convResult = await query(
      `INSERT INTO conversions (merchant_id, affiliate_id, visitor_id, conversion_type, conversion_value, commission_amount, currency, status, metadata)
       VALUES ($1,$2,$3,'solar_lead',5,0.50,'GBP','pending',$4) RETURNING id`,
      [merchant.id, affiliate.id, clickid || aff_code, metadata]
    );
    const convId = convResult.rows[0].id;

    // Insert detailed solar_leads record
    await query(
      `INSERT INTO solar_leads (conversion_id, affiliate_id, merchant_id, click_id, affiliate_code, site_address, site_ownership, roof_type, asbestos_status, mpan_number, annual_kwh, payback_hurdle, contact_name, contact_phone, contact_email, company_name, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pending')`,
      [convId, affiliate.id, merchant.id, clickid||'', aff_code, site_address, site_ownership||'', roof_type||'', asbestos_status||'unknown', mpan_number||'', parseFloat(annual_kwh)||0, parseFloat(payback_hurdle)||0, contact_name||'', contact_phone||'', contact_email||'', company_name||'', notes||'']
    );

    res.status(201).json({
      success: true,
      message: 'Solar lead submitted successfully',
      conversion_id: convId,
      affiliate_code: aff_code,
      postback_url: `https://api.magictracker.cc/api/track/postback?clickid=${clickid||''}&event=solar_lead&status=pending&aff_code=${aff_code}`
    });
  } catch (err) {
    console.error('Solar lead error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ── GET /api/affiliates/by-code/:code — look up affiliate by code ─────────
router.get('/by-code/:code', async (req, res) => {
  try {
    const aff = await queryOne(
      `SELECT a.id, a.name, a.email, a.affiliate_code, a.status,
              m.company_name, m.slug,
              COUNT(DISTINCT co.id) as total_conversions,
              COALESCE(SUM(co.commission_amount),0) as total_earnings
       FROM affiliates a
       JOIN merchants m ON a.merchant_id = m.id
       LEFT JOIN conversions co ON a.id = co.affiliate_id
       WHERE a.affiliate_code = $1 AND a.status = 'active'
       GROUP BY a.id, m.id`,
      [req.params.code.toUpperCase()]
    );
    if (!aff) return res.status(404).json({ error: 'Agent code not found' });

    // Status breakdown
    const qualified = await queryOne(
      `SELECT COUNT(*) as count FROM conversions WHERE affiliate_id=$1 AND status='qualified'`, [aff.id]
    );
    const converted = await queryOne(
      `SELECT COUNT(*) as count FROM conversions WHERE affiliate_id=$1 AND status='converted'`, [aff.id]
    );

    res.json({
      affiliate: { id: aff.id, name: aff.name, code: aff.affiliate_code, merchant: aff.company_name },
      stats: {
        total_conversions: parseInt(aff.total_conversions),
        qualified: parseInt(qualified?.count || 0),
        converted: parseInt(converted?.count || 0),
        total_earnings: parseFloat(aff.total_earnings),
      },
      lead_form_url: `https://magictracker.cc/solar-lead?aff=${aff.affiliate_code}`,
      tracking_link: `${BASE_URL}/r/${aff.affiliate_code}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/affiliates/leads/:code — get all solar leads for an agent ────
router.get('/leads/:code', async (req, res) => {
  try {
    const aff = await queryOne(`SELECT id FROM affiliates WHERE affiliate_code=$1`, [req.params.code.toUpperCase()]);
    if (!aff) return res.status(404).json({ error: 'Agent not found' });

    const leads = await queryAll(
      `SELECT sl.*, co.status, co.created_at, co.commission_amount
       FROM solar_leads sl
       LEFT JOIN conversions co ON sl.conversion_id = co.id
       WHERE sl.affiliate_id = $1
       ORDER BY sl.created_at DESC`,
      [aff.id]
    );

    res.json({ leads, total: leads.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

