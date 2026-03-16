const express = require('express');
const router = express.Router();
const db = require('../database/init');
const { generateVisitorId, getAttributionWindowStart } = require('../utils/helpers');

const ATTRIBUTION_WINDOW_DAYS = parseInt(process.env.ATTRIBUTION_WINDOW_DAYS) || 30;
const VISITOR_COOKIE_NAME = 'aff_vid';
const AFFILIATE_COOKIE_NAME = 'aff_code';

// GET /r/:affiliateCode - Redirect link tracking
router.get('/r/:affiliateCode', (req, res) => {
  try {
    const { affiliateCode } = req.params;
    const { dest } = req.query; // Optional custom destination

    // Find affiliate
    const affiliate = db.prepare('SELECT * FROM affiliates WHERE affiliate_code = ? AND status = ?')
      .get(affiliateCode, 'active');

    if (!affiliate) {
      // Redirect to default even if affiliate not found
      const defaultDest = db.prepare('SELECT url FROM destinations WHERE is_default = 1').get();
      return res.redirect(defaultDest?.url || 'https://example.com');
    }

    // Get or create visitor ID
    let visitorId = req.cookies[VISITOR_COOKIE_NAME];
    if (!visitorId) {
      visitorId = generateVisitorId();
    }

    // Record the click
    const clickResult = db.prepare(`
      INSERT INTO clicks (affiliate_id, visitor_id, ip_address, user_agent, referer, destination_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      affiliate.id,
      visitorId,
      req.ip || req.connection.remoteAddress,
      req.headers['user-agent'] || '',
      req.headers.referer || '',
      dest || null
    );

    // Determine destination URL
    let destinationUrl = dest;
    if (!destinationUrl) {
      const defaultDest = db.prepare('SELECT url FROM destinations WHERE is_default = 1').get();
      destinationUrl = defaultDest?.url || 'https://example.com';
    }

    // Set cookies for attribution (30 days)
    const cookieOptions = {
      maxAge: ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax'
    };

    res.cookie(VISITOR_COOKIE_NAME, visitorId, cookieOptions);
    res.cookie(AFFILIATE_COOKIE_NAME, affiliateCode, cookieOptions);

    // Redirect to destination
    res.redirect(destinationUrl);

  } catch (error) {
    console.error('Redirect tracking error:', error);
    const defaultDest = db.prepare('SELECT url FROM destinations WHERE is_default = 1').get();
    res.redirect(defaultDest?.url || 'https://example.com');
  }
});

// POST /api/track/conversion - S2S conversion tracking
router.post('/conversion', (req, res) => {
  try {
    const {
      affiliate_code,
      conversion_type,
      conversion_value = 0,
      currency = 'USD',
      visitor_id,
      external_visitor_id,
      metadata = {}
    } = req.body;

    // Validate required fields
    if (!conversion_type) {
      return res.status(400).json({ error: 'conversion_type is required' });
    }

    let affiliate = null;
    let clickId = null;
    let finalVisitorId = visitor_id || external_visitor_id;

    // Method 1: Direct affiliate code provided (S2S)
    if (affiliate_code) {
      affiliate = db.prepare('SELECT * FROM affiliates WHERE affiliate_code = ? AND status = ?')
        .get(affiliate_code, 'active');
      
      if (!affiliate) {
        return res.status(400).json({ error: 'Invalid affiliate code' });
      }
    }
    // Method 2: Look up from cookies (JS snippet)
    else if (req.cookies[AFFILIATE_COOKIE_NAME]) {
      const cookieCode = req.cookies[AFFILIATE_COOKIE_NAME];
      affiliate = db.prepare('SELECT * FROM affiliates WHERE affiliate_code = ? AND status = ?')
        .get(cookieCode, 'active');
      
      finalVisitorId = finalVisitorId || req.cookies[VISITOR_COOKIE_NAME];
    }
    // Method 3: Look up by visitor_id from recent click within attribution window
    else if (finalVisitorId) {
      const attributionStart = getAttributionWindowStart(ATTRIBUTION_WINDOW_DAYS);
      const recentClick = db.prepare(`
        SELECT c.*, a.* 
        FROM clicks c
        JOIN affiliates a ON c.affiliate_id = a.id
        WHERE c.visitor_id = ? 
          AND c.created_at >= ?
          AND a.status = 'active'
        ORDER BY c.created_at DESC
        LIMIT 1
      `).get(finalVisitorId, attributionStart);

      if (recentClick) {
        affiliate = {
          id: recentClick.affiliate_id,
          affiliate_code: recentClick.affiliate_code
        };
        clickId = recentClick.id;
      }
    }

    if (!affiliate) {
      return res.status(400).json({ 
        error: 'Could not attribute conversion. Provide affiliate_code or ensure visitor has clicked an affiliate link within attribution window.' 
      });
    }

    // Find associated click if we have visitor_id
    if (!clickId && finalVisitorId) {
      const click = db.prepare(`
        SELECT id FROM clicks 
        WHERE affiliate_id = ? AND visitor_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(affiliate.id, finalVisitorId);
      
      if (click) {
        clickId = click.id;
      }
    }

    // Record the conversion
    const result = db.prepare(`
      INSERT INTO conversions (
        affiliate_id, click_id, visitor_id, external_visitor_id,
        conversion_type, conversion_value, currency, metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      affiliate.id,
      clickId,
      finalVisitorId,
      external_visitor_id,
      conversion_type,
      conversion_value,
      currency,
      JSON.stringify(metadata)
    );

    res.status(201).json({
      success: true,
      conversion_id: result.lastInsertRowid,
      affiliate_code: affiliate.affiliate_code,
      conversion_type,
      conversion_value,
      currency
    });

  } catch (error) {
    console.error('Conversion tracking error:', error);
    res.status(500).json({ error: 'Failed to record conversion' });
  }
});

// GET /api/track/script.js - JavaScript snippet for non-tech partners
router.get('/script.js', (req, res) => {
  const baseUrl = `http://${process.env.HOST || 'localhost'}:${process.env.PORT || 3000}`;
  
  const script = `
(function() {
  'use strict';
  
  var AffiliateTracker = {
    baseUrl: '${baseUrl}',
    affiliateCode: null,
    visitorId: null,
    
    init: function() {
      // Extract affiliate code from URL
      var urlParams = new URLSearchParams(window.location.search);
      var refCode = urlParams.get('ref') || urlParams.get('aff') || urlParams.get('affiliate');
      
      if (refCode) {
        this.affiliateCode = refCode;
        this.setCookie('aff_code', refCode, 30);
      } else {
        this.affiliateCode = this.getCookie('aff_code');
      }
      
      // Get or create visitor ID
      this.visitorId = this.getCookie('aff_vid');
      if (!this.visitorId) {
        this.visitorId = this.generateId();
        this.setCookie('aff_vid', this.visitorId, 30);
      }
      
      // Track page view if affiliate code present
      if (this.affiliateCode) {
        this.trackPageView();
      }
      
      console.log('[AffiliateTracker] Initialized', { 
        affiliateCode: this.affiliateCode, 
        visitorId: this.visitorId 
      });
    },
    
    generateId: function() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    },
    
    setCookie: function(name, value, days) {
      var expires = '';
      if (days) {
        var date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = '; expires=' + date.toUTCString();
      }
      document.cookie = name + '=' + (value || '') + expires + '; path=/; SameSite=Lax';
    },
    
    getCookie: function(name) {
      var nameEQ = name + '=';
      var ca = document.cookie.split(';');
      for (var i = 0; i < ca.length; i++) {
        var c = ca[i];
        while (c.charAt(0) == ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
      }
      return null;
    },
    
    trackPageView: function() {
      // Silent page view tracking (optional)
    },
    
    convert: function(conversionType, metadata, value, currency) {
      if (!this.affiliateCode) {
        console.warn('[AffiliateTracker] No affiliate code found, conversion not tracked');
        return Promise.resolve({ success: false, error: 'No affiliate code' });
      }
      
      var data = {
        affiliate_code: this.affiliateCode,
        conversion_type: conversionType,
        visitor_id: this.visitorId,
        metadata: metadata || {},
        conversion_value: value || 0,
        currency: currency || 'USD'
      };
      
      return fetch(this.baseUrl + '/api/track/conversion', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(data),
        credentials: 'include'
      })
      .then(function(response) { return response.json(); })
      .then(function(result) {
        console.log('[AffiliateTracker] Conversion tracked:', result);
        return result;
      })
      .catch(function(error) {
        console.error('[AffiliateTracker] Conversion tracking failed:', error);
        return { success: false, error: error.message };
      });
    },
    
    // Convenience methods for common conversion types
    trackWalletConnect: function(walletAddress, chain) {
      return this.convert('wallet_connect', { 
        wallet_address: walletAddress, 
        chain: chain || 'ethereum' 
      });
    },
    
    trackPurchase: function(amount, currency, orderId, metadata) {
      return this.convert('purchase', 
        Object.assign({ order_id: orderId }, metadata || {}),
        amount,
        currency
      );
    },
    
    trackSignup: function(userId, metadata) {
      return this.convert('signup', 
        Object.assign({ user_id: userId }, metadata || {})
      );
    },
    
    trackAction: function(actionName, metadata, value) {
      return this.convert('in_game_action', 
        Object.assign({ action: actionName }, metadata || {}),
        value
      );
    },
    
    // Get current attribution info
    getAttribution: function() {
      return {
        affiliateCode: this.affiliateCode,
        visitorId: this.visitorId,
        hasAttribution: !!this.affiliateCode
      };
    }
  };
  
  // Auto-initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      AffiliateTracker.init();
    });
  } else {
    AffiliateTracker.init();
  }
  
  // Expose globally
  window.AffiliateTracker = AffiliateTracker;
})();
`;

  res.setHeader('Content-Type', 'application/javascript');
  res.send(script);
});

// GET /api/track/info - Get tracking info (for debugging)
router.get('/info', (req, res) => {
  res.json({
    visitor_id: req.cookies[VISITOR_COOKIE_NAME] || null,
    affiliate_code: req.cookies[AFFILIATE_COOKIE_NAME] || null,
    has_attribution: !!req.cookies[AFFILIATE_COOKIE_NAME],
    attribution_window_days: ATTRIBUTION_WINDOW_DAYS
  });
});

module.exports = router;
