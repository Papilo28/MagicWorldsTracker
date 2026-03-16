// api/track/conversion.js
const { handleCors } = require('../../lib/cors');
const { query } = require('../../lib/db');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    affiliate_code,
    conversion_type = 'purchase',
    conversion_value = 0,
    currency = 'USD',
    metadata = {},
    session_id
  } = req.body || {};

  if (!affiliate_code) return res.status(400).json({ error: 'affiliate_code is required' });

  try {
    const aff = await query(
      `SELECT id, commission_rate FROM affiliates WHERE affiliate_code=$1 AND status='active'`,
      [affiliate_code.toUpperCase()]
    );

    if (aff.rows.length === 0) return res.status(404).json({ error: 'Affiliate not found or inactive' });

    const { id: affiliateId, commission_rate } = aff.rows[0];
    const commissionAmount = parseFloat(conversion_value) * parseFloat(commission_rate);

    // Try to find matching click for attribution
    let clickId = null;
    if (session_id) {
      const click = await query(
        `SELECT id FROM clicks WHERE affiliate_code=$1 AND session_id=$2
         ORDER BY clicked_at DESC LIMIT 1`,
        [affiliate_code.toUpperCase(), session_id]
      );
      if (click.rows.length > 0) clickId = click.rows[0].id;
    }

    const result = await query(
      `INSERT INTO conversions
         (affiliate_id, affiliate_code, click_id, conversion_type, conversion_value,
          currency, commission_amount, status, metadata, session_id, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10)
       RETURNING id, created_at`,
      [
        affiliateId,
        affiliate_code.toUpperCase(),
        clickId,
        conversion_type,
        conversion_value,
        currency,
        commissionAmount,
        JSON.stringify(metadata),
        session_id || null,
        req.headers['x-forwarded-for']?.split(',')[0] || ''
      ]
    );

    res.status(201).json({
      success: true,
      conversion_id: result.rows[0].id,
      commission_amount: commissionAmount,
      currency
    });
  } catch (err) {
    console.error('conversion error:', err);
    res.status(500).json({ error: 'Failed to record conversion' });
  }
};
