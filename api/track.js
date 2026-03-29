// api/track.js — handles all /api/track/* routes
const { handleCors } = require('../lib/cors');
const { query } = require('../lib/db');
const { v4: uuidv4 } = require('uuid');

async function conversion(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { affiliate_code, conversion_type='purchase', conversion_value=0, currency='USD', metadata={}, session_id } = req.body || {};
  if (!affiliate_code) return res.status(400).json({ error: 'affiliate_code is required' });

  const aff = await query(`SELECT id,commission_rate FROM affiliates WHERE affiliate_code=$1 AND status='active'`, [affiliate_code.toUpperCase()]);
  if (aff.rows.length === 0) return res.status(404).json({ error: 'Affiliate not found or inactive' });

  const { id: affiliateId, commission_rate } = aff.rows[0];
  const commissionAmount = parseFloat(conversion_value) * parseFloat(commission_rate);

  let clickId = null;
  if (session_id) {
    const click = await query(`SELECT id FROM clicks WHERE affiliate_code=$1 AND session_id=$2 ORDER BY clicked_at DESC LIMIT 1`, [affiliate_code.toUpperCase(), session_id]);
    if (click.rows.length > 0) clickId = click.rows[0].id;
  }

  const result = await query(
    `INSERT INTO conversions (affiliate_id,affiliate_code,click_id,conversion_type,conversion_value,currency,commission_amount,status,metadata,session_id,ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10) RETURNING id,created_at`,
    [affiliateId, affiliate_code.toUpperCase(), clickId, conversion_type, conversion_value, currency, commissionAmount, JSON.stringify(metadata), session_id||null, req.headers['x-forwarded-for']?.split(',')[0]||'']
  );
  res.status(201).json({ success:true, conversion_id: result.rows[0].id, commission_amount: commissionAmount, currency });
}

function scriptJs(req, res) {
  const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;
  const script = `(function(){var B='${base}';function gc(n){var m=document.cookie.match(new RegExp('(^| )'+n+'=([^;]+)'));return m?m[2]:null;}function getCode(){var p=new URLSearchParams(window.location.search);return p.get('ref')||p.get('aff')||gc('aff_code');}function getSid(){return gc('aff_session');}function post(e,d){return fetch(B+e,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(d)}).catch(function(e){console.warn('AffiliateTracker:',e);});}window.AffiliateTracker={trackWalletConnect:function(w,c){var code=getCode();if(!code)return;return post('/api/track/conversion',{affiliate_code:code,conversion_type:'wallet_connect',conversion_value:0,currency:'USD',session_id:getSid(),metadata:{wallet_address:w,chain:c||'unknown'}});},trackPurchase:function(v,c,o){var code=getCode();if(!code)return;return post('/api/track/conversion',{affiliate_code:code,conversion_type:'purchase',conversion_value:v||0,currency:c||'USD',session_id:getSid(),metadata:{order_id:o}});},convert:function(t,m,v,c){var code=getCode();if(!code)return;return post('/api/track/conversion',{affiliate_code:code,conversion_type:t||'custom',conversion_value:v||0,currency:c||'USD',session_id:getSid(),metadata:m||{}});},getCode:getCode,getSession:getSid};var ref=new URLSearchParams(window.location.search).get('ref');if(ref){var exp=new Date(Date.now()+30*864e5).toUTCString();document.cookie='aff_code='+ref+';path=/;expires='+exp+';SameSite=Lax';}})();`;
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(script);
}

function info(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const cookies = {};
  (req.headers.cookie||'').split(';').forEach(c => { const [k,v]=c.trim().split('='); if(k) cookies[k.trim()]=decodeURIComponent(v||''); });
  res.json({ affiliate_code: cookies.aff_code||null, session_id: cookies.aff_session||null, has_attribution: !!cookies.aff_code });
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  const path = (req.query.path || req.url.replace(/[?].*$/, '').split('/').pop() || '').split('/')[0];

  try {
    if (path === 'conversion') return await conversion(req, res);
    if (path === 'script.js')  return scriptJs(req, res);
    if (path === 'info')       return info(req, res);
    res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('track error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
