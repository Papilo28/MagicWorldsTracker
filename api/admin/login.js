// api/admin/login.js
const { handleCors } = require('../../lib/cors');
const { signToken } = require('../../lib/auth');
const bcrypt = require('bcryptjs');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const adminEmail    = process.env.ADMIN_EMAIL    || 'admin@yourcompany.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  const emailMatch = email.toLowerCase() === adminEmail.toLowerCase();
  // Support both plaintext (env) and bcrypt hashes
  const passwordMatch = adminPassword.startsWith('$2')
    ? await bcrypt.compare(password, adminPassword)
    : password === adminPassword;

  if (!emailMatch || !passwordMatch) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken({ email: adminEmail, role: 'admin' }, '12h');
  res.json({ token, role: 'admin' });
};
