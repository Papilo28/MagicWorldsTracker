const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const db = require('../database/init');
const { authenticateAdmin, generateAdminToken } = require('../middleware/auth');
const { getLastWeekRange, getCurrentWeekRange } = require('../utils/helpers');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@yourcompany.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// POST /api/admin/login - Admin login
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;

    if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateAdminToken({ email });

    res.json({
      message: 'Admin login successful',
      token
    });

  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/admin/affiliates - List all affiliates
router.get('/affiliates', authenticateAdmin, (req, res) => {
  try {
    const { page = 1, limit = 50, status, search } = req.query;
    const offset = (page - 1) * limit;

    let whereConditions = [];
    let params = [];

    if (status) {
      whereConditions.push('status = ?');
      params.push(status);
    }

    if (search) {
      whereConditions.push('(name LIKE ? OR email LIKE ? OR affiliate_code LIKE ?)');
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    const whereClause = whereConditions.length > 0 
      ? 'WHERE ' + whereConditions.join(' AND ')
      : '';

    const affiliates = db.prepare(`
      SELECT 
        a.id, a.name, a.email, a.affiliate_code, a.wallet_address,
        a.payment_method, a.status, a.created_at,
        COUNT(DISTINCT cl.id) as total_clicks,
        COUNT(DISTINCT co.id) as total_conversions,
        COALESCE(SUM(co.conversion_value), 0) as total_earnings
      FROM affiliates a
      LEFT JOIN clicks cl ON a.id = cl.affiliate_id
      LEFT JOIN conversions co ON a.id = co.affiliate_id
      ${whereClause}
      GROUP BY a.id
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM affiliates ${whereClause}
    `).get(...params);

    res.json({
      affiliates,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total.count,
        pages: Math.ceil(total.count / limit)
      }
    });

  } catch (error) {
    console.error('List affiliates error:', error);
    res.status(500).json({ error: 'Failed to fetch affiliates' });
  }
});

// GET /api/admin/affiliates/:id - Get single affiliate details
router.get('/affiliates/:id', authenticateAdmin, (req, res) => {
  try {
    const affiliate = db.prepare(`
      SELECT * FROM affiliates WHERE id = ?
    `).get(req.params.id);

    if (!affiliate) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }

    // Get stats
    const stats = db.prepare(`
      SELECT 
        COUNT(DISTINCT cl.id) as total_clicks,
        COUNT(DISTINCT cl.visitor_id) as unique_visitors,
        COUNT(DISTINCT co.id) as total_conversions,
        COALESCE(SUM(co.conversion_value), 0) as total_earnings
      FROM affiliates a
      LEFT JOIN clicks cl ON a.id = cl.affiliate_id
      LEFT JOIN conversions co ON a.id = co.affiliate_id
      WHERE a.id = ?
    `).get(req.params.id);

    // Remove sensitive data
    delete affiliate.wallet_private_key_encrypted;

    res.json({
      ...affiliate,
      stats
    });

  } catch (error) {
    console.error('Get affiliate error:', error);
    res.status(500).json({ error: 'Failed to fetch affiliate' });
  }
});

// PUT /api/admin/affiliates/:id - Update affiliate
router.put('/affiliates/:id', authenticateAdmin, (req, res) => {
  try {
    const { name, email, status, wallet_address, payment_method } = req.body;
    const updates = [];
    const params = [];

    if (name) {
      updates.push('name = ?');
      params.push(name);
    }
    if (email) {
      updates.push('email = ?');
      params.push(email.toLowerCase());
    }
    if (status && ['active', 'inactive'].includes(status)) {
      updates.push('status = ?');
      params.push(status);
    }
    if (wallet_address) {
      updates.push('wallet_address = ?');
      params.push(wallet_address);
    }
    if (payment_method) {
      updates.push('payment_method = ?');
      params.push(payment_method);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.params.id);

    db.prepare(`UPDATE affiliates SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM affiliates WHERE id = ?').get(req.params.id);
    delete updated.wallet_private_key_encrypted;

    res.json({
      message: 'Affiliate updated successfully',
      affiliate: updated
    });

  } catch (error) {
    console.error('Update affiliate error:', error);
    res.status(500).json({ error: 'Failed to update affiliate' });
  }
});

// DELETE /api/admin/affiliates/:id - Delete affiliate (soft delete)
router.delete('/affiliates/:id', authenticateAdmin, (req, res) => {
  try {
    db.prepare(`UPDATE affiliates SET status = 'inactive' WHERE id = ?`).run(req.params.id);
    res.json({ message: 'Affiliate deactivated successfully' });
  } catch (error) {
    console.error('Delete affiliate error:', error);
    res.status(500).json({ error: 'Failed to deactivate affiliate' });
  }
});

// GET /api/admin/stats - Platform-wide statistics
router.get('/stats', authenticateAdmin, (req, res) => {
  try {
    const { period } = req.query;
    let dateFilter = '';
    
    switch (period) {
      case 'today':
        dateFilter = `AND date(created_at) = date('now')`;
        break;
      case 'week':
        dateFilter = `AND created_at >= datetime('now', '-7 days')`;
        break;
      case 'month':
        dateFilter = `AND created_at >= datetime('now', '-30 days')`;
        break;
      default:
        dateFilter = '';
    }

    const affiliateStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
      FROM affiliates
    `).get();

    const clickStats = db.prepare(`
      SELECT 
        COUNT(*) as total_clicks,
        COUNT(DISTINCT visitor_id) as unique_visitors
      FROM clicks
      WHERE 1=1 ${dateFilter}
    `).get();

    const conversionStats = db.prepare(`
      SELECT 
        COUNT(*) as total_conversions,
        SUM(conversion_value) as total_value
      FROM conversions
      WHERE 1=1 ${dateFilter}
    `).get();

    const conversionsByType = db.prepare(`
      SELECT 
        conversion_type,
        COUNT(*) as count,
        SUM(conversion_value) as value
      FROM conversions
      WHERE 1=1 ${dateFilter}
      GROUP BY conversion_type
    `).all();

    const topAffiliates = db.prepare(`
      SELECT 
        a.id, a.name, a.email, a.affiliate_code,
        COUNT(DISTINCT co.id) as conversions,
        COALESCE(SUM(co.conversion_value), 0) as earnings
      FROM affiliates a
      LEFT JOIN conversions co ON a.id = co.affiliate_id
      WHERE a.status = 'active'
      GROUP BY a.id
      ORDER BY earnings DESC
      LIMIT 10
    `).all();

    res.json({
      period: period || 'all',
      affiliates: affiliateStats,
      clicks: clickStats,
      conversions: {
        total: conversionStats.total_conversions || 0,
        total_value: conversionStats.total_value || 0,
        by_type: conversionsByType
      },
      top_affiliates: topAffiliates
    });

  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// GET /api/admin/reports/payout - Generate payout report Excel file
router.get('/reports/payout', authenticateAdmin, async (req, res) => {
  try {
    const { period = 'last_week', currency = 'USD' } = req.query;
    
    let startDate, endDate;
    
    if (period === 'last_week') {
      const range = getLastWeekRange();
      startDate = range.startOfWeek;
      endDate = range.endOfWeek;
    } else if (period === 'this_week') {
      const range = getCurrentWeekRange();
      startDate = range.startOfWeek;
      endDate = range.endOfWeek;
    } else if (req.query.start_date && req.query.end_date) {
      startDate = new Date(req.query.start_date);
      endDate = new Date(req.query.end_date);
    } else {
      const range = getLastWeekRange();
      startDate = range.startOfWeek;
      endDate = range.endOfWeek;
    }

    // Get payout data
    const payoutData = db.prepare(`
      SELECT 
        a.id as affiliate_id,
        a.name,
        a.email,
        a.affiliate_code,
        a.wallet_address,
        a.payment_method,
        COUNT(DISTINCT co.id) as total_conversions,
        SUM(CASE WHEN co.conversion_type = 'wallet_connect' THEN 1 ELSE 0 END) as wallet_connects,
        SUM(CASE WHEN co.conversion_type = 'purchase' THEN 1 ELSE 0 END) as purchases,
        SUM(CASE WHEN co.conversion_type = 'signup' THEN 1 ELSE 0 END) as signups,
        SUM(CASE WHEN co.conversion_type = 'in_game_action' THEN 1 ELSE 0 END) as in_game_actions,
        COALESCE(SUM(co.conversion_value), 0) as total_earnings,
        COUNT(DISTINCT cl.id) as total_clicks,
        COUNT(DISTINCT cl.visitor_id) as unique_visitors
      FROM affiliates a
      LEFT JOIN conversions co ON a.id = co.affiliate_id 
        AND co.created_at >= ? AND co.created_at <= ?
      LEFT JOIN clicks cl ON a.id = cl.affiliate_id
        AND cl.created_at >= ? AND cl.created_at <= ?
      WHERE a.status = 'active'
      GROUP BY a.id
      HAVING total_conversions > 0 OR total_clicks > 0
      ORDER BY total_earnings DESC
    `).all(
      startDate.toISOString(), endDate.toISOString(),
      startDate.toISOString(), endDate.toISOString()
    );

    // Create Excel workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Affiliate Tracker';
    workbook.created = new Date();

    // Summary sheet
    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.columns = [
      { header: 'Metric', key: 'metric', width: 25 },
      { header: 'Value', key: 'value', width: 20 }
    ];
    
    const totalEarnings = payoutData.reduce((sum, a) => sum + a.total_earnings, 0);
    const totalConversions = payoutData.reduce((sum, a) => sum + a.total_conversions, 0);
    
    summarySheet.addRows([
      { metric: 'Report Period', value: `${startDate.toDateString()} - ${endDate.toDateString()}` },
      { metric: 'Generated At', value: new Date().toISOString() },
      { metric: 'Total Affiliates', value: payoutData.length },
      { metric: 'Total Conversions', value: totalConversions },
      { metric: 'Total Payout Amount', value: `${totalEarnings.toFixed(2)} ${currency}` },
    ]);

    // Style the summary header
    summarySheet.getRow(1).font = { bold: true };
    summarySheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    summarySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Payout details sheet
    const payoutSheet = workbook.addWorksheet('Payout Details');
    payoutSheet.columns = [
      { header: 'Affiliate ID', key: 'affiliate_id', width: 12 },
      { header: 'Name', key: 'name', width: 20 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Affiliate Code', key: 'affiliate_code', width: 15 },
      { header: 'Wallet Address', key: 'wallet_address', width: 45 },
      { header: 'Payment Method', key: 'payment_method', width: 15 },
      { header: 'Clicks', key: 'total_clicks', width: 10 },
      { header: 'Unique Visitors', key: 'unique_visitors', width: 15 },
      { header: 'Wallet Connects', key: 'wallet_connects', width: 15 },
      { header: 'Purchases', key: 'purchases', width: 12 },
      { header: 'Signups', key: 'signups', width: 10 },
      { header: 'In-Game Actions', key: 'in_game_actions', width: 15 },
      { header: 'Total Conversions', key: 'total_conversions', width: 18 },
      { header: `Earnings (${currency})`, key: 'total_earnings', width: 15 }
    ];

    payoutSheet.addRows(payoutData);

    // Style the payout header
    payoutSheet.getRow(1).font = { bold: true };
    payoutSheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    payoutSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Format earnings column as currency
    payoutSheet.getColumn('total_earnings').numFmt = '#,##0.00';

    // Crypto payouts sheet (filtered by payment method)
    const cryptoPayouts = payoutData.filter(a => 
      a.payment_method === 'crypto' || a.payment_method === 'both'
    );
    
    if (cryptoPayouts.length > 0) {
      const cryptoSheet = workbook.addWorksheet('Crypto Payouts');
      cryptoSheet.columns = [
        { header: 'Wallet Address', key: 'wallet_address', width: 45 },
        { header: 'Name', key: 'name', width: 20 },
        { header: 'Email', key: 'email', width: 30 },
        { header: `Amount (${currency})`, key: 'total_earnings', width: 15 }
      ];
      
      cryptoSheet.addRows(cryptoPayouts);
      cryptoSheet.getRow(1).font = { bold: true };
      cryptoSheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF70AD47' }
      };
      cryptoSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cryptoSheet.getColumn('total_earnings').numFmt = '#,##0.00';
    }

    // Fiat payouts sheet
    const fiatPayouts = payoutData.filter(a => 
      a.payment_method === 'fiat' || a.payment_method === 'both'
    );
    
    if (fiatPayouts.length > 0) {
      const fiatSheet = workbook.addWorksheet('Fiat Payouts');
      fiatSheet.columns = [
        { header: 'Name', key: 'name', width: 20 },
        { header: 'Email', key: 'email', width: 30 },
        { header: `Amount (${currency})`, key: 'total_earnings', width: 15 }
      ];
      
      fiatSheet.addRows(fiatPayouts);
      fiatSheet.getRow(1).font = { bold: true };
      fiatSheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFED7D31' }
      };
      fiatSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      fiatSheet.getColumn('total_earnings').numFmt = '#,##0.00';
    }

    // Set response headers
    const filename = `payout-report-${startDate.toISOString().split('T')[0]}-to-${endDate.toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Write to response
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Report generation error:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// GET /api/admin/destinations - List redirect destinations
router.get('/destinations', authenticateAdmin, (req, res) => {
  try {
    const destinations = db.prepare('SELECT * FROM destinations ORDER BY is_default DESC, created_at DESC').all();
    res.json({ destinations });
  } catch (error) {
    console.error('List destinations error:', error);
    res.status(500).json({ error: 'Failed to fetch destinations' });
  }
});

// POST /api/admin/destinations - Add new destination
router.post('/destinations', authenticateAdmin, (req, res) => {
  try {
    const { name, url, is_default = false } = req.body;

    if (!name || !url) {
      return res.status(400).json({ error: 'Name and URL are required' });
    }

    // If setting as default, unset other defaults
    if (is_default) {
      db.prepare('UPDATE destinations SET is_default = 0').run();
    }

    const result = db.prepare(`
      INSERT INTO destinations (name, url, is_default)
      VALUES (?, ?, ?)
    `).run(name, url, is_default ? 1 : 0);

    const destination = db.prepare('SELECT * FROM destinations WHERE id = ?').get(result.lastInsertRowid);
    
    res.status(201).json({
      message: 'Destination added successfully',
      destination
    });

  } catch (error) {
    console.error('Add destination error:', error);
    res.status(500).json({ error: 'Failed to add destination' });
  }
});

module.exports = router;
