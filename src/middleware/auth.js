const jwt = require('jsonwebtoken');
const { queryOne } = require('../database/init');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

function generateToken(payload, expiresIn = '7d') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function generateMagicLinkToken(email, merchantId = null) {
  const payload = { email, type: 'magic', purpose: 'magic-link' };
  if (merchantId) payload.merchant_id = merchantId;
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '15m' });
}

function verifyMagicLinkToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.purpose !== 'magic-link') return null;
    return decoded;
  } catch {
    return null;
  }
}

function generateAdminToken(admin) {
  return jwt.sign({ email: admin.email, type: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
}

async function authenticateAffiliate(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'affiliate') return res.status(403).json({ error: 'Invalid token type' });

    const affiliate = await queryOne('SELECT * FROM affiliates WHERE id = $1 AND status = $2', [decoded.id, 'active']);
    if (!affiliate) return res.status(401).json({ error: 'Affiliate not found or inactive' });

    req.affiliate = affiliate;
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

function authenticateAdmin(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    req.admin = decoded;
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

function authenticateMerchant(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'merchant') return res.status(403).json({ error: 'Merchant access required' });
    req.merchant = decoded;
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

function authenticateSuperAdmin(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'superadmin') return res.status(403).json({ error: 'Super admin access required' });
    req.superAdmin = decoded;
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

module.exports = {
  generateToken,
  generateMagicLinkToken,
  verifyMagicLinkToken,
  generateAdminToken,
  authenticateAffiliate,
  authenticateAdmin,
  authenticateMerchant,
  authenticateSuperAdmin,
};
