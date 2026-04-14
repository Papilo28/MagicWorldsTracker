const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, queryOne, queryAll } = require('../database/init');
const { generateResetToken } = require('../utils/helpers');
const { sendPasswordReset } = require('../emails');

const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://magictracker.cc';

function authenticateSuperAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    if (decoded.type !== 'superadmin') return res.status(401).json({ error: 'Invalid token type' });
    req.superAdmin = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// POST /api/superadmin/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const admin = await queryOne('SELECT * FROM super_admins WHERE email = $1', [email.toLowerCase()]);
    if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
    if (admin.status !== 'active') return res.status(403).json({ error: 'Account is inactive' });
    if (!bcrypt.compareSync(password, admin.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: admin.id, email: admin.email, type: 'superadmin' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ message: 'Login successful', admin: { id: admin.id, name: admin.name, email: admin.email }, token });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/superadmin/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const admin = await queryOne(`SELECT * FROM super_admins WHERE email = $1 AND status = 'active'`, [email.toLowerCase()]);
    if (!admin) return res.json({ message: 'If an account exists, a reset email has been sent.' });
    const token = generateResetToken();
    const expires = new Date(Date.now() + 3600000);
    await query('DELETE FROM password_resets WHERE email = $1 AND user_type = $2', [email.toLowerCase(), 'superadmin']);
    await query('INSERT INTO password_resets (email, user_type, token, expires_at) VALUES ($1,$2,$3,$4)', [email.toLowerCase(), 'superadmin', token, expires]);
    const resetLink = `${FRONTEND_URL}/reset-password?token=${token}&type=superadmin`;
    await sendPasswordReset({ to: email.toLowerCase(), resetLink, userType: 'superadmin' });
    res.json({ message: 'If an account exists, a reset email has been sent.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// POST /api/superadmin/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const reset = await queryOne(`SELECT * FROM password_resets WHERE token = $1 AND user_type = 'superadmin' AND used = FALSE AND expires_at > NOW()`, [token]);
    if (!reset) return res.status(400).json({ error: 'Invalid or expired reset token' });
    const hash = bcrypt.hashSync(password, 10);
    await query('UPDATE super_admins SET password_hash = $1 WHERE email = $2', [hash, reset.email]);
    await query('UPDATE password_resets SET used = TRUE WHERE id = $1', [reset.id]);
    res.json({ message: 'Password reset successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// GET /api/superadmin/stats
router.get('/stats', authenticateSuperAdmin, async (req, res) => {
  try {
    const merchants = await queryOne(`SELECT COUNT(*) as total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active FROM merchants`);
    const affiliates = await queryOne('SELECT COUNT(*) as total FROM affiliates');
    const conversions = await queryOne(`SELECT COUNT(*) as total, COALESCE(SUM(conversion_value),0) as total_value FROM conversions`);
    const clicks = await queryOne('SELECT COUNT(*) as total FROM clicks');
    res.json({ merchants: { total: parseInt(merchants.total), active: parseInt(merchants.active || 0) }, affiliates: { total: parseInt(affiliates.total) }, conversions: { total: parseInt(conversions.total), total_value: parseFloat(conversions.total_value) }, clicks: { total: parseInt(clicks.total) } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/superadmin/merchants
router.get('/merchants', authenticateSuperAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', status } = req.query;
    const offset = (page - 1) * limit;
    const conditions = ['1=1']; const params = []; let i = 1;
    if (search) { conditions.push(`(m.company_name ILIKE $${i} OR m.email ILIKE $${i})`); params.push(`%${search}%`); i++; }
    if (status) { conditions.push(`m.status = $${i++}`); params.push(status); }
    const where = conditions.join(' AND ');
    const merchants = await queryAll(
      `SELECT m.id, m.company_name, m.slug, m.email, m.website_url, m.status, m.created_at, (SELECT COUNT(*) FROM affiliates WHERE merchant_id = m.id) as affiliate_count, (SELECT COUNT(*) FROM conversions WHERE merchant_id = m.id) as conversion_count, (SELECT COALESCE(SUM(conversion_value),0) FROM conversions WHERE merchant_id = m.id) as total_revenue FROM merchants m WHERE ${where} ORDER BY m.created_at DESC LIMIT $${i} OFFSET $${i+1}`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    const total = await queryOne(`SELECT COUNT(*) as count FROM merchants m WHERE ${where}`, params);
    res.json({ merchants, pagination: { page: parseInt(page), limit: parseInt(limit), total: parseInt(total.count), pages: Math.ceil(total.count / limit) } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch merchants' });
  }
});

// PUT /api/superadmin/merchants/:id
router.put('/merchants/:id', authenticateSuperAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'inactive', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    await query('UPDATE merchants SET status = $1, updated_at = NOW() WHERE id = $2', [status, req.params.id]);
    const merchant = await queryOne('SELECT id, company_name, email, status FROM merchants WHERE id = $1', [req.params.id]);
    res.json({ message: 'Merchant updated', merchant });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update merchant' });
  }
});

// DELETE /api/superadmin/merchants/:id
router.delete('/merchants/:id', authenticateSuperAdmin, async (req, res) => {
  try {
    const merchant = await queryOne('SELECT * FROM merchants WHERE id = $1', [req.params.id]);
    if (!merchant) return res.status(404).json({ error: 'Merchant not found' });
    await query('DELETE FROM merchants WHERE id = $1', [req.params.id]);
    res.json({ message: 'Merchant deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete merchant' });
  }
});

module.exports = router;
