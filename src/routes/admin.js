const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { query, queryOne, queryAll } = require('../database/init');
const { authenticateAdmin, generateAdminToken } = require('../middleware/auth');
const { getLastWeekRange, getCurrentWeekRange, generateResetToken } = require('../utils/helpers');
const { sendPasswordReset } = require('../emails');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SUPER_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.SUPER_ADMIN_PASSWORD;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://magictracker.cc';

// POST /api/admin/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    // Check env-var admin credentials (plain text comparison)
    const envMatch = email.toLowerCase() === (ADMIN_EMAIL || '').toLowerCase() && password === ADMIN_PASSWORD;

    // Also check super_admins table (bcrypt)
    let dbMatch = false;
    try {
      const sa = await queryOne('SELECT * FROM super_admins WHERE email = $1 AND status = $2', [email.toLowerCase(), 'active']);
      if (sa && bcrypt.compareSync(password, sa.password_hash)) dbMatch = true;
    } catch(e) {}

    if (!envMatch && !dbMatch) return res.status(401).json({ error: 'Invalid credentials' });

    const token = generateAdminToken({ email: email.toLowerCase() });
    res.json({ message: 'Admin login successful', token });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/admin/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    // Check super_admins table
    const sa = await queryOne('SELECT * FROM super_admins WHERE email = $1', [email.toLowerCase()]);
    if (sa) {
      const token = generateResetToken();
      const expires = new Date(Date.now() + 2 * 60 * 60 * 1000);
      await query(`DELETE FROM password_resets WHERE email = $1 AND user_type = 'admin'`, [email.toLowerCase()]);
      await query(`INSERT INTO password_resets (email, user_type, token, expires_at) VALUES ($1,'admin',$2,$3)`, [email.toLowerCase(), token, expires]);
      const resetUrl = `${FRONTEND_URL}/reset-password?token=${token}&type=admin`;
      await sendPasswordReset({ to: email.toLowerCase(), name: sa.name || 'Admin', resetUrl });
    }
    // Always return success to avoid email enumeration
    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('Admin forgot-password error:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// GET /api/admin/affiliates
router.get('/affiliates', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, search } = req.query;
    const offset = (page - 1) * limit;
    const conditions = ['1=1']; const params = [];
    let i = 1;
    if (status) { conditions.push(`a.status = $${i++}`); params.push(status); }
    if (search) {
      conditions.push(`(a.name ILIKE $${i} OR a.email ILIKE $${i} OR a.affiliate_code ILIKE $${i})`);
      params.push(`%${search}%`); i++;
    }
    const where = conditions.join(' AND ');
    const affiliates = await queryAll(
      `SELECT a.id, a.name, a.email, a.affiliate_code, a.wallet_address, a.payment_method, a.status, a.created_at, COUNT(DISTINCT cl.id) as total_clicks, COUNT(DISTINCT co.id) as total_conversions, COALESCE(SUM(co.conversion_value),0) as total_earnings FROM affiliates a LEFT JOIN clicks cl ON a.id = cl.affiliate_id LEFT JOIN conversions co ON a.id = co.affiliate_id WHERE ${where} GROUP BY a.id ORDER BY a.created_at DESC LIMIT $${i} OFFSET $${i+1}`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    const total = await queryOne(`SELECT COUNT(*) as count FROM affiliates a WHERE ${where}`, params);
    res.json({ affiliates, pagination: { page: parseInt(page), limit: parseInt(limit), total: parseInt(total.count), pages: Math.ceil(total.count / limit) } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch affiliates' });
  }
});

// GET /api/admin/affiliates/:id
router.get('/affiliates/:id', authenticateAdmin, async (req, res) => {
  try {
    const affiliate = await queryOne('SELECT * FROM affiliates WHERE id = $1', [req.params.id]);
    if (!affiliate) return res.status(404).json({ error: 'Affiliate not found' });
    const stats = await queryOne(`SELECT COUNT(DISTINCT cl.id) as total_clicks, COUNT(DISTINCT cl.visitor_id) as unique_visitors, COUNT(DISTINCT co.id) as total_conversions, COALESCE(SUM(co.conversion_value),0) as total_earnings FROM affiliates a LEFT JOIN clicks cl ON a.id = cl.affiliate_id LEFT JOIN conversions co ON a.id = co.affiliate_id WHERE a.id = $1`, [req.params.id]);
    delete affiliate.wallet_private_key_encrypted;
    delete affiliate.password_hash;
    res.json({ ...affiliate, stats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch affiliate' });
  }
});

// PUT /api/admin/affiliates/:id
router.put('/affiliates/:id', authenticateAdmin, async (req, res) => {
  try {
    const { name, email, status, wallet_address, payment_method } = req.body;
    const updates = []; const params = []; let i = 1;
    if (name) { updates.push(`name = $${i++}`); params.push(name); }
    if (email) { updates.push(`email = $${i++}`); params.push(email.toLowerCase()); }
    if (status && ['active', 'inactive'].includes(status)) { updates.push(`status = $${i++}`); params.push(status); }
    if (wallet_address) { updates.push(`wallet_address = $${i++}`); params.push(wallet_address); }
    if (payment_method) { updates.push(`payment_method = $${i++}`); params.push(payment_method); }
    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
    updates.push(`updated_at = NOW()`); params.push(req.params.id);
    const result = await query(`UPDATE affiliates SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`, params);
    const updated = result.rows[0];
    delete updated.wallet_private_key_encrypted; delete updated.password_hash;
    res.json({ message: 'Affiliate updated successfully', affiliate: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update affiliate' });
  }
});

// DELETE /api/admin/affiliates/:id
router.delete('/affiliates/:id', authenticateAdmin, async (req, res) => {
  try {
    await query(`UPDATE affiliates SET status = 'inactive' WHERE id = $1`, [req.params.id]);
    res.json({ message: 'Affiliate deactivated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate affiliate' });
  }
});

// GET /api/admin/stats
router.get('/stats', authenticateAdmin, async (req, res) => {
  try {
    const { period } = req.query;
    let dateFilter = '';
    if (period === 'today') dateFilter = `AND created_at >= CURRENT_DATE`;
    else if (period === 'week') dateFilter = `AND created_at >= NOW() - INTERVAL '7 days'`;
    else if (period === 'month') dateFilter = `AND created_at >= NOW() - INTERVAL '30 days'`;

    const affiliateStats = await queryOne(`SELECT COUNT(*) as total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active FROM affiliates`);
    const clickStats = await queryOne(`SELECT COUNT(*) as total_clicks, COUNT(DISTINCT visitor_id) as unique_visitors FROM clicks WHERE 1=1 ${dateFilter}`);
    const conversionStats = await queryOne(`SELECT COUNT(*) as total_conversions, COALESCE(SUM(conversion_value),0) as total_value FROM conversions WHERE 1=1 ${dateFilter}`);
    const conversionsByType = await queryAll(`SELECT conversion_type, COUNT(*) as count, COALESCE(SUM(conversion_value),0) as value FROM conversions WHERE 1=1 ${dateFilter} GROUP BY conversion_type`);
    const topAffiliates = await queryAll(`SELECT a.id, a.name, a.email, a.affiliate_code, COUNT(DISTINCT co.id) as conversions, COALESCE(SUM(co.conversion_value),0) as earnings FROM affiliates a LEFT JOIN conversions co ON a.id = co.affiliate_id WHERE a.status = 'active' GROUP BY a.id ORDER BY earnings DESC LIMIT 10`);

    res.json({ period: period || 'all', affiliates: { total: parseInt(affiliateStats.total), active: parseInt(affiliateStats.active || 0) }, clicks: { total_clicks: parseInt(clickStats.total_clicks), unique_visitors: parseInt(clickStats.unique_visitors) }, conversions: { total: parseInt(conversionStats.total_conversions), total_value: parseFloat(conversionStats.total_value), by_type: conversionsByType }, top_affiliates: topAffiliates });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// GET /api/admin/reports/payout
router.get('/reports/payout', authenticateAdmin, async (req, res) => {
  try {
    const { period = 'last_week', currency = 'USD' } = req.query;
    let startDate, endDate;
    if (period === 'this_week') { const r = getCurrentWeekRange(); startDate = r.startOfWeek; endDate = r.endOfWeek; }
    else { const r = getLastWeekRange(); startDate = r.startOfWeek; endDate = r.endOfWeek; }

    const rows = await queryAll(
      `SELECT a.id as affiliate_id, a.name, a.email, a.affiliate_code, a.wallet_address, a.payment_method, COUNT(DISTINCT co.id) as total_conversions, COUNT(DISTINCT cl.id) as total_clicks, COALESCE(SUM(co.conversion_value),0) as total_earnings FROM affiliates a LEFT JOIN conversions co ON a.id = co.affiliate_id AND co.created_at >= $1 AND co.created_at <= $2 LEFT JOIN clicks cl ON a.id = cl.affiliate_id AND cl.created_at >= $1 AND cl.created_at <= $2 WHERE a.status = 'active' GROUP BY a.id HAVING COUNT(DISTINCT co.id) > 0 OR COUNT(DISTINCT cl.id) > 0 ORDER BY total_earnings DESC`,
      [startDate.toISOString(), endDate.toISOString()]
    );

    let csv = ['Affiliate ID', 'Name', 'Email', 'Code', 'Wallet', 'Payment Method', 'Clicks', 'Conversions', `Earnings (${currency})`].join(',') + '\n';
    rows.forEach(r => {
      csv += [r.affiliate_id, `"${(r.name || '').replace(/"/g, '""')}"`, `"${(r.email || '').replace(/"/g, '""')}"`, r.affiliate_code, `"${(r.wallet_address || '').replace(/"/g, '""')}"`, r.payment_method, r.total_clicks, r.total_conversions, parseFloat(r.total_earnings).toFixed(2)].join(',') + '\n';
    });

    const filename = `payout-${startDate.toISOString().split('T')[0]}-to-${endDate.toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// GET /api/admin/destinations
router.get('/destinations', authenticateAdmin, async (req, res) => {
  try {
    const destinations = await queryAll('SELECT * FROM destinations ORDER BY is_default DESC, created_at DESC');
    res.json({ destinations });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch destinations' });
  }
});

// POST /api/admin/destinations
router.post('/destinations', authenticateAdmin, async (req, res) => {
  try {
    const { name, url, is_default = false } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'Name and URL are required' });
    if (is_default) await query('UPDATE destinations SET is_default = 0');
    const result = await query('INSERT INTO destinations (name, url, is_default) VALUES ($1,$2,$3) RETURNING *', [name, url, is_default ? 1 : 0]);
    res.status(201).json({ message: 'Destination added', destination: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add destination' });
  }
});

module.exports = router;
