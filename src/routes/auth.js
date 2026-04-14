const express = require('express');
const router = express.Router();
const { queryOne, query } = require('../database/init');
const bcrypt = require('bcryptjs');

// POST /api/auth/reset-password (universal handler for all user types)
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password, type } = req.body;
    if (!token || !password || !type) return res.status(400).json({ error: 'Token, password, and type are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    if (!['affiliate', 'merchant', 'superadmin'].includes(type)) return res.status(400).json({ error: 'Invalid user type' });

    const reset = await queryOne(`SELECT * FROM password_resets WHERE token = $1 AND user_type = $2 AND used = FALSE AND expires_at > NOW()`, [token, type]);
    if (!reset) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const hash = bcrypt.hashSync(password, 10);

    if (type === 'affiliate') await query('UPDATE affiliates SET password_hash = $1 WHERE email = $2', [hash, reset.email]);
    else if (type === 'merchant') await query('UPDATE merchants SET password_hash = $1 WHERE email = $2', [hash, reset.email]);
    else if (type === 'superadmin') await query('UPDATE super_admins SET password_hash = $1 WHERE email = $2', [hash, reset.email]);

    await query('UPDATE password_resets SET used = TRUE WHERE id = $1', [reset.id]);
    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
