const express = require('express');
const router = express.Router();
const { queryOne, queryAll, query } = require('../database/init');
const { generateVisitorId, getAttributionWindowStart, VALID_CONVERSION_TYPES } = require('../utils/helpers');

const ATTRIBUTION_WINDOW_DAYS = parseInt(process.env.ATTRIBUTION_WINDOW_DAYS) || 30;
const VISITOR_COOKIE = 'aff_vid';
const AFFILIATE_COOKIE = 'aff_code';
const PROGRAM_COOKIE = 'aff_prog';
const API_SECRET = process.env.TRACKING_API_SECRET;

const verifyApiSecret = (req, res, next) => {
  if (!API_SECRET) return next();
  const provided = req.headers['x-api-secret'] || req.query.api_secret;
  if (provided === API_SECRET) return next();
  if (req.body.affiliate_code || req.cookies[AFFILIATE_COOKIE]) return next();
  return res.status(401).json({ error: 'Invalid or missing API secret' });
};

// GET /r/:affiliateCode — redirect tracking
router.get('/r/:affiliateCode', async (req, res) => {
  try {
    const { affiliateCode } = req.params;
    const { dest, subid, program } = req.query;
    const DEFAULT_URL = process.env.DEFAULT_REDIRECT_URL || 'https://magictracker.cc';

    const affiliate = await queryOne(`SELECT * FROM affiliates WHERE affiliate_code = $1 AND status = 'active'`, [affiliateCode]);
    if (!affiliate) return res.redirect(DEFAULT_URL);

    let programRecord = null;
    if (program) programRecord = await queryOne(`SELECT * FROM programs WHERE slug = $1 AND merchant_id = $2 AND is_active = 1`, [program, affiliate.merchant_id]);
    if (!programRecord) programRecord = await queryOne(`SELECT * FROM programs WHERE merchant_id = $1 AND is_default = 1 AND is_active = 1`, [affiliate.merchant_id]);

    let visitorId = req.cookies[VISITOR_COOKIE] || generateVisitorId();

    await query(
      `INSERT INTO clicks (merchant_id, affiliate_id, program_id, visitor_id, ip_address, user_agent, referer, destination_url, sub_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [affiliate.merchant_id, affiliate.id, programRecord?.id || null, visitorId, req.ip, req.headers['user-agent'] || '', req.headers.referer || '', dest || null, subid || null]
    );

    const cookieDuration = programRecord?.cookie_duration || ATTRIBUTION_WINDOW_DAYS;
    const cookieOptions = { maxAge: cookieDuration * 86400000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' };

    res.cookie(VISITOR_COOKIE, visitorId, cookieOptions);
    res.cookie(AFFILIATE_COOKIE, affiliateCode, cookieOptions);
    if (programRecord) res.cookie(PROGRAM_COOKIE, programRecord.slug, cookieOptions);

    let destination = dest;
    if (!destination) {
      if (programRecord) destination = programRecord.landing_page_url;
      else {
        const merchant = await queryOne('SELECT default_redirect_url FROM merchants WHERE id = $1', [affiliate.merchant_id]);
        destination = merchant?.default_redirect_url || DEFAULT_URL;
      }
    }
    res.redirect(destination);
  } catch (err) {
    console.error('Redirect error:', err);
    res.redirect(process.env.DEFAULT_REDIRECT_URL || 'https://magictracker.cc');
  }
});

// POST /api/track/conversion
router.post('/conversion', verifyApiSecret, async (req, res) => {
  try {
    const { affiliate_code, program_slug, conversion_type, conversion_value = 0, currency = 'USD', visitor_id, external_visitor_id, order_id, metadata = {} } = req.body;

    if (!conversion_type) return res.status(400).json({ error: 'conversion_type is required' });
    if (!VALID_CONVERSION_TYPES.includes(conversion_type)) {
      return res.status(400).json({ error: `Invalid conversion_type. Must be one of: ${VALID_CONVERSION_TYPES.join(', ')}` });
    }

    let affiliate = null;
    let programRecord = null;
    let clickId = null;
    let finalVisitorId = visitor_id || external_visitor_id;

    if (program_slug) programRecord = await queryOne(`SELECT * FROM programs WHERE slug = $1 AND is_active = 1`, [program_slug]);
    else if (req.cookies[PROGRAM_COOKIE]) programRecord = await queryOne(`SELECT * FROM programs WHERE slug = $1 AND is_active = 1`, [req.cookies[PROGRAM_COOKIE]]);

    if (affiliate_code) {
      affiliate = await queryOne(`SELECT * FROM affiliates WHERE affiliate_code = $1 AND status = 'active'`, [affiliate_code]);
      if (!affiliate) return res.status(400).json({ error: 'Invalid affiliate code' });
    } else if (req.cookies[AFFILIATE_COOKIE]) {
      affiliate = await queryOne(`SELECT * FROM affiliates WHERE affiliate_code = $1 AND status = 'active'`, [req.cookies[AFFILIATE_COOKIE]]);
      finalVisitorId = finalVisitorId || req.cookies[VISITOR_COOKIE];
    } else if (finalVisitorId) {
      const attributionStart = getAttributionWindowStart(ATTRIBUTION_WINDOW_DAYS);
      const recentClick = await queryOne(
        `SELECT c.*, a.id as aff_id, a.affiliate_code as aff_code FROM clicks c JOIN affiliates a ON c.affiliate_id = a.id WHERE c.visitor_id = $1 AND c.created_at >= $2 AND a.status = 'active' ORDER BY c.created_at DESC LIMIT 1`,
        [finalVisitorId, attributionStart]
      );
      if (recentClick) {
        affiliate = { id: recentClick.aff_id, affiliate_code: recentClick.aff_code };
        clickId = recentClick.id;
        if (!programRecord && recentClick.program_id) programRecord = await queryOne('SELECT * FROM programs WHERE id = $1', [recentClick.program_id]);
      }
    }

    if (!affiliate) return res.status(400).json({ error: 'Could not attribute conversion. Provide affiliate_code or ensure visitor clicked an affiliate link.' });

    if (!clickId && finalVisitorId) {
      const click = await queryOne(`SELECT id FROM clicks WHERE affiliate_id = $1 AND visitor_id = $2 ORDER BY created_at DESC LIMIT 1`, [affiliate.id, finalVisitorId]);
      if (click) clickId = click.id;
    }

    let commissionAmount = 0;
    if (programRecord) {
      const affiliateProgram = await queryOne(`SELECT * FROM affiliate_programs WHERE affiliate_id = $1 AND program_id = $2`, [affiliate.id, programRecord.id]);
      const commType = affiliateProgram?.custom_commission_type || programRecord.commission_type;
      const commValue = affiliateProgram?.custom_commission_value || programRecord.commission_value;
      commissionAmount = commType === 'percentage' ? (conversion_value * commValue) / 100 : commValue;
    }

    const finalMeta = { ...metadata };
    if (order_id) finalMeta.order_id = order_id;

    // Get merchant_id
    const affRecord = await queryOne('SELECT merchant_id FROM affiliates WHERE id = $1', [affiliate.id]);

    const result = await query(
      `INSERT INTO conversions (merchant_id, affiliate_id, program_id, click_id, visitor_id, external_visitor_id, conversion_type, conversion_value, commission_amount, currency, status, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'approved',$11) RETURNING id`,
      [affRecord.merchant_id, affiliate.id, programRecord?.id || null, clickId, finalVisitorId, external_visitor_id, conversion_type, conversion_value, commissionAmount, currency, JSON.stringify(finalMeta)]
    );

    res.status(201).json({ success: true, conversion_id: result.rows[0].id, affiliate_code: affiliate.affiliate_code, program: programRecord?.slug || null, conversion_type, conversion_value, commission_amount: commissionAmount, currency });
  } catch (err) {
    console.error('Conversion error:', err);
    res.status(500).json({ error: 'Failed to record conversion' });
  }
});

// GET /api/track/script.js
router.get('/script.js', (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const script = `(function(){var T={baseUrl:'${baseUrl}',affiliateCode:null,programSlug:null,visitorId:null,init:function(){var p=new URLSearchParams(window.location.search);var r=p.get('ref')||p.get('aff')||p.get('affiliate');var pg=p.get('program');if(r){this.affiliateCode=r;this.setCookie('aff_code',r,30);}else{this.affiliateCode=this.getCookie('aff_code');}if(pg){this.programSlug=pg;this.setCookie('aff_prog',pg,30);}else{this.programSlug=this.getCookie('aff_prog');}this.visitorId=this.getCookie('aff_vid');if(!this.visitorId){this.visitorId=this.genId();this.setCookie('aff_vid',this.visitorId,30);}},genId:function(){return'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c=='x'?r:(r&0x3|0x8);return v.toString(16);});},setCookie:function(n,v,d){var e='';if(d){var dt=new Date();dt.setTime(dt.getTime()+(d*86400000));e='; expires='+dt.toUTCString();}var s=location.protocol==='https:'?'; Secure':'';document.cookie=n+'='+(v||'')+e+'; path=/; SameSite=Lax'+s;},getCookie:function(n){var eq=n+'=';var ca=document.cookie.split(';');for(var i=0;i<ca.length;i++){var c=ca[i].trim();if(c.indexOf(eq)===0)return c.substring(eq.length);}return null;},convert:function(type,meta,val,cur){if(!this.affiliateCode)return Promise.resolve({success:false,error:'No affiliate code'});return fetch(this.baseUrl+'/api/track/conversion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({affiliate_code:this.affiliateCode,program_slug:this.programSlug,conversion_type:type,visitor_id:this.visitorId,metadata:meta||{},conversion_value:val||0,currency:cur||'USD'}),credentials:'include'}).then(function(r){return r.json();}).catch(function(e){return{success:false,error:e.message};});},trackWalletConnect:function(addr,chain){return this.convert('wallet_connect',{wallet_address:addr,chain:chain||'ethereum'});},trackPurchase:function(amt,cur,oid,meta){return this.convert('purchase',Object.assign({order_id:oid},meta||{}),amt,cur);},trackSignup:function(uid,meta){return this.convert('signup',Object.assign({user_id:uid},meta||{}));},trackAction:function(name,meta,val){return this.convert('in_game_action',Object.assign({action:name},meta||{}),val);},trackReferral:function(referredId,meta){return this.convert('referral',Object.assign({referred_user_id:referredId},meta||{}));},trackSubscription:function(plan,amt,cur){return this.convert('subscription',{plan:plan},amt,cur);},trackNFTMint:function(tokenId,collection,meta){return this.convert('nft_mint',Object.assign({token_id:tokenId,collection:collection},meta||{}));},trackTokenSwap:function(fromToken,toToken,amt,meta){return this.convert('token_swap',Object.assign({from:fromToken,to:toToken},meta||{}),amt);},trackLevelUp:function(level,meta){return this.convert('level_up',Object.assign({level:level},meta||{}));},getAttribution:function(){return{affiliateCode:this.affiliateCode,programSlug:this.programSlug,visitorId:this.visitorId,hasAttribution:!!this.affiliateCode};}};if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',function(){T.init();});}else{T.init();}window.AffiliateTracker=T;})();`;
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(script);
});

// GET /api/track/info
router.get('/info', (req, res) => {
  res.json({
    visitor_id: req.cookies[VISITOR_COOKIE] || null,
    affiliate_code: req.cookies[AFFILIATE_COOKIE] || null,
    program_slug: req.cookies[PROGRAM_COOKIE] || null,
    has_attribution: !!req.cookies[AFFILIATE_COOKIE],
    attribution_window_days: ATTRIBUTION_WINDOW_DAYS,
    conversion_types: VALID_CONVERSION_TYPES,
  });
});

router.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

module.exports = router;

// ── GET /api/track/postback — S2S pixel/postback endpoint ─────────────────
// Called by: magictracker.cc lead form, Our Flame S2S, external redirects
// URL: /postback?clickid=XXX&event=solar_lead&status=pending&aff_id=XXX
router.get('/postback', async (req, res) => {
  try {
    const { clickid, event, status, aff_id, aff_code, value, currency: cur, ...meta } = req.query;

    // Always respond 200 to pixel fires immediately (async process)
    res.set('Content-Type', 'image/gif');
    res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'));

    if (!event) return;

    const convType = ['solar_lead','lead','qualified_lead','converted_lead'].includes(event)
      ? event : 'lead';
    const convStatus = ['pending','qualified','converted','rejected'].includes(status)
      ? status : 'pending';

    // Find affiliate by code or click
    let affiliate = null;
    if (aff_code) {
      affiliate = await queryOne(`SELECT * FROM affiliates WHERE affiliate_code = $1`, [aff_code]);
    } else if (aff_id) {
      affiliate = await queryOne(`SELECT * FROM affiliates WHERE id = $1`, [aff_id]);
    } else if (clickid) {
      const click = await queryOne(`SELECT * FROM clicks WHERE id = $1`, [clickid]);
      if (click) affiliate = await queryOne(`SELECT * FROM affiliates WHERE id = $1`, [click.affiliate_id]);
    }

    if (!affiliate) return;

    const merchant = await queryOne(`SELECT * FROM merchants WHERE id = $1`, [affiliate.merchant_id]);
    if (!merchant) return;

    const commVal = parseFloat(value || merchant.commission_value || 5);
    const metadata = JSON.stringify({ ...meta, source: 'postback', event });

    const result = await query(
      `INSERT INTO conversions (merchant_id, affiliate_id, visitor_id, conversion_type, conversion_value, commission_amount, currency, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [merchant.id, affiliate.id, clickid || '', convType, commVal,
       commVal * (merchant.commission_value / 100 || 0.1),
       cur || 'USD', convStatus, metadata]
    );

    console.log(`[Postback] ${convType} logged for affiliate ${affiliate.affiliate_code}, conversion_id=${result.rows[0].id}`);

  } catch (err) {
    console.error('[Postback] Error:', err.message);
    // Still return pixel even on error
    if (!res.headersSent) {
      res.set('Content-Type','image/gif');
      res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'));
    }
  }
});

// ── POST /api/track/postback — S2S JSON postback ──────────────────────────
router.post('/postback', async (req, res) => {
  try {
    const { clickid, event, status, aff_code, aff_id, value, currency: cur, metadata: meta } = req.body;
    const convType = ['solar_lead','lead','qualified_lead','converted_lead'].includes(event)
      ? event : 'lead';
    const convStatus = ['pending','qualified','converted','rejected'].includes(status)
      ? status : 'pending';

    let affiliate = null;
    if (aff_code) affiliate = await queryOne(`SELECT * FROM affiliates WHERE affiliate_code = $1`, [aff_code]);
    else if (aff_id) affiliate = await queryOne(`SELECT * FROM affiliates WHERE id = $1`, [aff_id]);
    else if (clickid) {
      const click = await queryOne(`SELECT * FROM clicks WHERE id = $1`, [clickid]);
      if (click) affiliate = await queryOne(`SELECT * FROM affiliates WHERE id = $1`, [click.affiliate_id]);
    }
    if (!affiliate) return res.status(404).json({ error: 'Affiliate not found' });

    const merchant = await queryOne(`SELECT * FROM merchants WHERE id = $1`, [affiliate.merchant_id]);
    if (!merchant) return res.status(404).json({ error: 'Merchant not found' });

    const commVal = parseFloat(value || 5);
    const result = await query(
      `INSERT INTO conversions (merchant_id, affiliate_id, visitor_id, conversion_type, conversion_value, commission_amount, currency, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [merchant.id, affiliate.id, clickid || '', convType, commVal,
       commVal * 0.1, cur || 'USD', convStatus, JSON.stringify(meta || {})]
    );

    res.json({ success: true, conversion_id: result.rows[0].id, status: convStatus });
  } catch (err) {
    console.error('[Postback POST] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/track/postback/:id — update lead status (qualified/converted) ─
router.put('/postback/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;
    const validStatuses = ['pending','qualified','converted','rejected'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const conv = await queryOne(`SELECT * FROM conversions WHERE id = $1`, [req.params.id]);
    if (!conv) return res.status(404).json({ error: 'Conversion not found' });
    const meta = JSON.parse(conv.metadata || '{}');
    meta.status_updated = new Date().toISOString();
    if (notes) meta.review_notes = notes;
    await query(`UPDATE conversions SET status=$1, metadata=$2 WHERE id=$3`, [status, JSON.stringify(meta), req.params.id]);
    res.json({ success: true, conversion_id: req.params.id, new_status: status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

