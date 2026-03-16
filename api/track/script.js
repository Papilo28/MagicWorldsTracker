// api/track/script.js — serves the client-side JS snippet
const { handleCors } = require('../../lib/cors');

module.exports = (req, res) => {
  if (handleCors(req, res)) return;

  const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;

  const script = `
(function() {
  var BASE_URL = '${base}';

  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? match[2] : null;
  }

  function getAffiliateCode() {
    var params = new URLSearchParams(window.location.search);
    return params.get('ref') || params.get('aff') || getCookie('aff_code');
  }

  function getSessionId() {
    return getCookie('aff_session');
  }

  function post(endpoint, data) {
    return fetch(BASE_URL + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(data)
    }).catch(function(e) { console.warn('AffiliateTracker error:', e); });
  }

  window.AffiliateTracker = {
    trackWalletConnect: function(walletAddress, chain) {
      var code = getAffiliateCode();
      if (!code) return;
      return post('/api/track/conversion', {
        affiliate_code: code,
        conversion_type: 'wallet_connect',
        conversion_value: 0,
        currency: 'USD',
        session_id: getSessionId(),
        metadata: { wallet_address: walletAddress, chain: chain || 'unknown' }
      });
    },

    trackPurchase: function(value, currency, orderId) {
      var code = getAffiliateCode();
      if (!code) return;
      return post('/api/track/conversion', {
        affiliate_code: code,
        conversion_type: 'purchase',
        conversion_value: value || 0,
        currency: currency || 'USD',
        session_id: getSessionId(),
        metadata: { order_id: orderId }
      });
    },

    convert: function(type, metadata, value, currency) {
      var code = getAffiliateCode();
      if (!code) return;
      return post('/api/track/conversion', {
        affiliate_code: code,
        conversion_type: type || 'custom',
        conversion_value: value || 0,
        currency: currency || 'USD',
        session_id: getSessionId(),
        metadata: metadata || {}
      });
    },

    getCode: getAffiliateCode,
    getSession: getSessionId
  };

  // Auto-persist ref param to cookie
  var ref = new URLSearchParams(window.location.search).get('ref');
  if (ref) {
    var days = 30;
    var expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = 'aff_code=' + ref + '; path=/; expires=' + expires + '; SameSite=Lax';
  }
})();
`.trim();

  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(script);
};
