// api/admin/destinations.js
const { handleCors } = require('../../lib/cors');
const { query } = require('../../lib/db');
const { requireAdmin } = require('../../lib/auth');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const admin = requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const rows = await query('SELECT * FROM redirect_destinations ORDER BY created_at DESC');
    return res.json({ destinations: rows.rows });
  }

  if (req.method === 'POST') {
    const { name, url, is_default = false } = req.body || {};
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });

    if (is_default) {
      await query('UPDATE redirect_destinations SET is_default=FALSE');
    }

    const result = await query(
      'INSERT INTO redirect_destinations (name, url, is_default) VALUES ($1,$2,$3) RETURNING *',
      [name, url, is_default]
    );
    return res.status(201).json({ destination: result.rows[0] });
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id is required' });
    await query('DELETE FROM redirect_destinations WHERE id=$1', [id]);
    return res.json({ message: 'Destination deleted' });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
