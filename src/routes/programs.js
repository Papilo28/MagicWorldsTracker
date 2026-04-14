const express = require('express');
const router = express.Router();
const { query, queryOne, queryAll } = require('../database/init');
const { authenticateAdmin } = require('../middleware/auth');

function generateSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// GET /api/programs
router.get('/', async (req, res) => {
  try {
    const programs = await queryAll(`SELECT id, name, slug, description, landing_page_url, commission_type, commission_value, currency, cookie_duration, is_default FROM programs WHERE is_active = 1 ORDER BY is_default DESC, name ASC`);
    res.json({ programs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch programs' });
  }
});

// GET /api/programs/:slug
router.get('/:slug', async (req, res) => {
  try {
    const program = await queryOne(`SELECT id, name, slug, description, landing_page_url, commission_type, commission_value, currency, cookie_duration FROM programs WHERE slug = $1 AND is_active = 1`, [req.params.slug]);
    if (!program) return res.status(404).json({ error: 'Program not found' });
    const stats = await queryOne(`SELECT COUNT(DISTINCT ap.affiliate_id) as total_affiliates, COUNT(DISTINCT c.id) as total_conversions, COALESCE(SUM(c.conversion_value),0) as total_revenue FROM programs p LEFT JOIN affiliate_programs ap ON p.id = ap.program_id AND ap.status = 'active' LEFT JOIN conversions c ON p.id = c.program_id WHERE p.id = $1`, [program.id]);
    res.json({ program, stats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch program' });
  }
});

// POST /api/programs
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const { name, description, landing_page_url, commission_type = 'percentage', commission_value = 10, cookie_duration = 30, currency = 'USD', is_default = false } = req.body;
    if (!name || !landing_page_url) return res.status(400).json({ error: 'Name and landing page URL are required' });
    const slug = generateSlug(name);
    const existing = await queryOne('SELECT id FROM programs WHERE slug = $1', [slug]);
    if (existing) return res.status(400).json({ error: 'A program with this name already exists' });
    if (is_default) await query('UPDATE programs SET is_default = 0');
    const result = await query(`INSERT INTO programs (name, slug, description, landing_page_url, commission_type, commission_value, cookie_duration, currency, is_default, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1) RETURNING *`, [name, slug, description || '', landing_page_url, commission_type, commission_value, cookie_duration, currency, is_default ? 1 : 0]);
    const program = result.rows[0];
    await query('INSERT INTO destinations (program_id, name, url, is_default) VALUES ($1,$2,$3,1)', [program.id, 'Default', landing_page_url]);
    res.status(201).json({ message: 'Program created successfully', program });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create program' });
  }
});

// PUT /api/programs/:id
router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    const { name, description, landing_page_url, commission_type, commission_value, cookie_duration, currency, is_default, is_active } = req.body;
    const updates = []; const params = []; let i = 1;
    if (name) { updates.push(`name = $${i++}`); params.push(name); updates.push(`slug = $${i++}`); params.push(generateSlug(name)); }
    if (description !== undefined) { updates.push(`description = $${i++}`); params.push(description); }
    if (landing_page_url) { updates.push(`landing_page_url = $${i++}`); params.push(landing_page_url); }
    if (commission_type) { updates.push(`commission_type = $${i++}`); params.push(commission_type); }
    if (commission_value !== undefined) { updates.push(`commission_value = $${i++}`); params.push(commission_value); }
    if (cookie_duration !== undefined) { updates.push(`cookie_duration = $${i++}`); params.push(cookie_duration); }
    if (currency) { updates.push(`currency = $${i++}`); params.push(currency); }
    if (is_active !== undefined) { updates.push(`is_active = $${i++}`); params.push(is_active ? 1 : 0); }
    if (is_default) { await query('UPDATE programs SET is_default = 0'); updates.push(`is_default = 1`); }
    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
    updates.push(`updated_at = NOW()`); params.push(req.params.id);
    const result = await query(`UPDATE programs SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`, params);
    res.json({ message: 'Program updated', program: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update program' });
  }
});

// DELETE /api/programs/:id
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const program = await queryOne('SELECT * FROM programs WHERE id = $1', [req.params.id]);
    if (!program) return res.status(404).json({ error: 'Program not found' });
    if (program.is_default) return res.status(400).json({ error: 'Cannot delete the default program' });
    await query('UPDATE programs SET is_active = 0 WHERE id = $1', [req.params.id]);
    res.json({ message: 'Program deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete program' });
  }
});

module.exports = router;
