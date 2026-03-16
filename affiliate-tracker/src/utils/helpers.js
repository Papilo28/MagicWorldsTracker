const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// Generate a unique affiliate code (8 characters, uppercase alphanumeric)
function generateAffiliateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Generate a visitor ID for cookie-based tracking
function generateVisitorId() {
  return uuidv4();
}

// Encrypt sensitive data (like wallet private keys)
function encrypt(text) {
  const key = process.env.ENCRYPTION_KEY || 'your-32-character-encryption-key!';
  const paddedKey = key.padEnd(32, '0').slice(0, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(paddedKey), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

// Decrypt sensitive data
function decrypt(text) {
  const key = process.env.ENCRYPTION_KEY || 'your-32-character-encryption-key!';
  const paddedKey = key.padEnd(32, '0').slice(0, 32);
  const parts = text.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(paddedKey), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

// Calculate date range for attribution window
function getAttributionWindowStart(days = 30) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

// Format date for SQLite
function formatDateForDB(date = new Date()) {
  return date.toISOString();
}

// Get start and end of current week (for payout reports)
function getCurrentWeekRange() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  
  // Start of week (Sunday)
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - dayOfWeek);
  startOfWeek.setHours(0, 0, 0, 0);
  
  // End of week (Saturday)
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);
  
  return { startOfWeek, endOfWeek };
}

// Get last week's range
function getLastWeekRange() {
  const { startOfWeek } = getCurrentWeekRange();
  
  const lastWeekEnd = new Date(startOfWeek);
  lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);
  lastWeekEnd.setHours(23, 59, 59, 999);
  
  const lastWeekStart = new Date(lastWeekEnd);
  lastWeekStart.setDate(lastWeekEnd.getDate() - 6);
  lastWeekStart.setHours(0, 0, 0, 0);
  
  return { startOfWeek: lastWeekStart, endOfWeek: lastWeekEnd };
}

module.exports = {
  generateAffiliateCode,
  generateVisitorId,
  encrypt,
  decrypt,
  getAttributionWindowStart,
  formatDateForDB,
  getCurrentWeekRange,
  getLastWeekRange
};
