const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

function generateAffiliateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

function generateVisitorId() {
  return uuidv4();
}

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

function encrypt(text) {
  const key = (process.env.ENCRYPTION_KEY || '').padEnd(32, '0').slice(0, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
  const key = (process.env.ENCRYPTION_KEY || '').padEnd(32, '0').slice(0, 32);
  const parts = text.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

function getAttributionWindowStart(days = 30) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function getCurrentWeekRange() {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);
  return { startOfWeek, endOfWeek };
}

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

const VALID_CONVERSION_TYPES = [
  'wallet_connect', 'purchase', 'signup', 'in_game_action',
  'referral', 'subscription', 'nft_mint', 'token_swap', 'level_up',
  'solar_lead', 'lead', 'qualified_lead', 'converted_lead'
];

module.exports = {
  generateAffiliateCode,
  generateVisitorId,
  generateResetToken,
  encrypt,
  decrypt,
  getAttributionWindowStart,
  getCurrentWeekRange,
  getLastWeekRange,
  VALID_CONVERSION_TYPES,
};
