const express = require('express');
const app = express();
const path = require('path');
const pool = require('../db/init'); // Adjusted to your folder structure

app.use(express.json());

// 1. Tracking Route (e.g., /api/click?id=123)
app.get('/api/click', async (req, res) => {
    const { affiliate_id, dest_id } = req.query;
    try {
        // Log click to Postgres
        await pool.query(
            'INSERT INTO clicks (affiliate_id, visitor_id, user_agent, ip_address) VALUES ($1, $2, $3, $4)',
            [affiliate_id, 'visitor_' + Date.now(), req.headers['user-agent'], req.ip]
        );
        
        // Get redirect URL
        const result = await pool.query('SELECT url FROM destinations WHERE id = $1', [dest_id]);
        const targetUrl = result.rows[0]?.url || 'https://themagicworlds.org';
        
        res.redirect(targetUrl);
    } catch (err) {
        console.error(err);
        res.status(500).send('Tracking Error');
    }
});

// 2. Conversion Route (Postback)
app.post('/api/conversion', async (req, res) => {
    const { affiliate_id, value, type } = req.body;
    try {
        await pool.query(
            'INSERT INTO conversions (affiliate_id, conversion_value, conversion_type) VALUES ($1, $2, $3)',
            [affiliate_id, value, type]
        );
        res.status(200).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Conversion failed' });
    }
});

// 3. Health Check
app.get('/api/status', (req, res) => {
    res.json({ status: 'Tracker Online', database: 'Postgres' });
});

module.exports = app;