// api/health.js
const { handleCors } = require('../lib/cors');
const { query } = require('../lib/db');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    await query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString(), version: '2.0.0' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected', error: err.message });
  }
};
