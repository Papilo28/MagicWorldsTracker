const jwt = require('jsonwebtoken');
const db = require('../database/init');

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production-abc123';

// Generate JWT token for affiliate
function generateToken(affiliate) {
  return jwt.sign(
    { 
      id: affiliate.id, 
      email: affiliate.email,
      type: 'affiliate'
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// Generate JWT token for admin
function generateAdminToken(admin) {
  return jwt.sign(
    { 
      email: admin.email,
      type: 'admin'
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

// Middleware: Verify affiliate token
function authenticateAffiliate(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    if (decoded.type !== 'affiliate') {
      return res.status(403).json({ error: 'Invalid token type' });
    }

    // Get fresh affiliate data
    const affiliate = db.prepare('SELECT * FROM affiliates WHERE id = ? AND status = ?')
      .get(decoded.id, 'active');

    if (!affiliate) {
      return res.status(401).json({ error: 'Affiliate not found or inactive' });
    }

    req.affiliate = affiliate;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// Middleware: Verify admin token
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    if (decoded.type !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.admin = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// Generate magic link token (for passwordless login)
function generateMagicLinkToken(email) {
  return jwt.sign(
    { email, purpose: 'magic-link' },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

// Verify magic link token
function verifyMagicLinkToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.purpose !== 'magic-link') {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

module.exports = {
  generateToken,
  generateAdminToken,
  authenticateAffiliate,
  authenticateAdmin,
  generateMagicLinkToken,
  verifyMagicLinkToken
};
