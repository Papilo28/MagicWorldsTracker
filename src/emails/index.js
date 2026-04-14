const BASE_URL = process.env.BASE_URL || 'https://api.magictracker.cc';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://magictracker.cc';
const FROM_EMAIL = process.env.EMAIL_FROM || 'noreply@magictracker.cc';
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'Magic Worlds Tracker';
const BREVO_KEY = process.env.BREVO_API_KEY;

// ── Add or update a contact in Brevo contacts list ───────────────────────────
async function addBrevoContact({ email, firstName, lastName, attributes = {} }) {
  if (!BREVO_KEY || BREVO_KEY.includes('your-brevo') || BREVO_KEY.length < 10) { console.error('[Brevo] API key not configured'); return; }
  try {
    const { default: fetch } = await import('node-fetch');
    const body = {
      email,
      updateEnabled: true,
      attributes: {
        FIRSTNAME: firstName || '',
        LASTNAME: lastName || '',
        ...attributes,
      },
    };
    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn('[Brevo Contacts] Could not add contact:', err);
    } else {
      console.log('[Brevo Contacts] Contact added/updated:', email);
    }
  } catch (err) {
    console.warn('[Brevo Contacts] Error:', err.message);
  }
}

async function sendEmail({ to, subject, html }) {
  if (!BREVO_KEY || BREVO_KEY.includes('your-brevo') || BREVO_KEY.length < 10) {
    console.error('[Email] BREVO_API_KEY is not configured. Key value:', BREVO_KEY ? '[set but invalid: ' + BREVO_KEY.substring(0,8) + '...]' : '[not set]');
    return { success: false, reason: 'no_api_key' };
  }
  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
      body: JSON.stringify({
        sender: { name: FROM_NAME, email: FROM_EMAIL },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[Email] Brevo error:', err);
      return { success: false, reason: err };
    }
    console.log('[Email] Sent to:', to);
    return { success: true };
  } catch (err) {
    console.error('[Email] Send error:', err.message);
    return { success: false, reason: err.message };
  }
}

const emailStyles = `
  body{margin:0;padding:0;background:#0a0a1a;font-family:'Inter',Arial,sans-serif;color:#fff}
  .wrapper{max-width:600px;margin:0 auto;padding:40px 20px}
  .card{background:rgba(255,255,255,.05);border:1px solid rgba(124,109,250,.3);border-radius:16px;padding:40px}
  .logo{text-align:center;margin-bottom:32px}
  .logo-box{display:inline-block;background:linear-gradient(135deg,#7c6dfa,#00d4ff);border-radius:12px;padding:12px 20px;font-weight:800;font-size:18px;letter-spacing:2px;color:#fff}
  h1{font-size:24px;font-weight:700;margin:0 0 16px;color:#fff}
  p{color:#d1d5db;line-height:1.7;margin:0 0 16px}
  .btn{display:inline-block;background:linear-gradient(135deg,#7c6dfa,#00d4ff);color:#fff;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:600;font-size:15px;margin:16px 0}
  .code{font-family:monospace;background:rgba(124,109,250,.2);color:#a78bfa;padding:12px 20px;border-radius:8px;font-size:14px;letter-spacing:1px;display:block;margin:16px 0;text-align:center;word-break:break-all}
  .footer{text-align:center;margin-top:32px;color:#6b7280;font-size:13px}
  .divider{border:none;border-top:1px solid rgba(124,109,250,.2);margin:24px 0}
`;

async function sendMagicLink({ to, magicLink, userName }) {
  return sendEmail({
    to,
    subject: 'Your Magic Worlds Tracker Login Link',
    html: `<!DOCTYPE html><html><head><style>${emailStyles}</style></head><body>
      <div class="wrapper"><div class="card">
        <div class="logo"><div class="logo-box">MW TRACKER</div></div>
        <h1>Login to your account</h1>
        <p>Hi ${userName || 'there'},</p>
        <p>Click the button below to log in to your affiliate dashboard. This link expires in 15 minutes.</p>
        <div style="text-align:center"><a href="${magicLink}" class="btn">Login to Dashboard</a></div>
        <hr class="divider">
        <p style="font-size:13px;color:#6b7280">If you did not request this, you can safely ignore this email.</p>
      </div><div class="footer">2025 Magic Worlds Tracker · <a href="${FRONTEND_URL}" style="color:#7c6dfa">${FRONTEND_URL}</a></div></div>
    </body></html>`,
  });
}

async function sendPasswordReset({ to, resetLink, resetUrl, userType, name }) {
  const url = resetLink || resetUrl;
  const role = userType === 'superadmin' ? 'Super Admin' : userType === 'merchant' ? 'Merchant' : 'Affiliate';
  return sendEmail({
    to,
    subject: 'Reset Your Magic Worlds Tracker Password',
    html: `<!DOCTYPE html><html><head><style>${emailStyles}</style></head><body>
      <div class="wrapper"><div class="card">
        <div class="logo"><div class="logo-box">MW TRACKER</div></div>
        <h1>Reset your password</h1>
        <p>Hi ${name || 'there'},</p>
        <p>We received a request to reset the password for your ${role} account. Click the button below. This link expires in 1 hour.</p>
        <div style="text-align:center"><a href="${url}" class="btn">Reset Password</a></div>
        <hr class="divider">
        <p style="font-size:13px;color:#6b7280">If you did not request a password reset, you can safely ignore this email.</p>
      </div><div class="footer">2025 Magic Worlds Tracker</div></div>
    </body></html>`,
  });
}

async function sendWelcomeAffiliate({ to, name, affiliateCode, trackingLink, merchantName }) {
  // Add to Brevo contacts
  const parts = (name || '').split(' ');
  await addBrevoContact({
    email: to,
    firstName: parts[0] || name,
    lastName: parts.slice(1).join(' ') || '',
    attributes: { ROLE: 'affiliate', MERCHANT: merchantName || '' },
  });
  return sendEmail({
    to,
    subject: `Welcome to ${merchantName}'s Affiliate Program!`,
    html: `<!DOCTYPE html><html><head><style>${emailStyles}</style></head><body>
      <div class="wrapper"><div class="card">
        <div class="logo"><div class="logo-box">MW TRACKER</div></div>
        <h1>Welcome, ${name}!</h1>
        <p>You have successfully joined <strong>${merchantName}</strong>'s affiliate program.</p>
        <p>Your unique affiliate code:</p>
        <span class="code">${affiliateCode}</span>
        <p>Your tracking link:</p>
        <span class="code" style="font-size:13px">${trackingLink}</span>
        <div style="text-align:center"><a href="${FRONTEND_URL}/dashboard" class="btn">View Your Dashboard</a></div>
        <p style="font-size:13px;color:#6b7280;margin-top:16px">Share your tracking link to start earning commissions.</p>
      </div><div class="footer">2025 Magic Worlds Tracker</div></div>
    </body></html>`,
  });
}

async function sendWelcomeMerchant({ to, companyName, apiKey, apiSecret, plan, trialEnds }) {
  // Add to Brevo contacts
  const parts = (companyName || '').split(' ');
  await addBrevoContact({
    email: to,
    firstName: parts[0] || companyName,
    lastName: parts.slice(1).join(' ') || '',
    attributes: { ROLE: 'merchant', COMPANY: companyName || '' },
  });
  return sendEmail({
    to,
    subject: 'Your Magic Worlds Tracker Campaign is Ready',
    html: `<!DOCTYPE html><html><head><style>${emailStyles}</style></head><body>
      <div class="wrapper"><div class="card">
        <div class="logo"><div class="logo-box">MW TRACKER</div></div>
        <h1>Welcome, ${companyName}!</h1>
        <p>Your campaign account has been created. Your <strong>14-day free trial</strong> started today${trialEnds ? ' and ends on <strong>' + new Date(trialEnds).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}) + '</strong>' : ''}.</p>
        <div style="background:rgba(0,255,163,.08);border:1px solid rgba(0,255,163,.2);border-radius:8px;padding:16px;margin:16px 0;text-align:center">
          <div style="font-size:13px;color:#6b7280;margin-bottom:4px">Your plan</div>
          <div style="font-size:20px;font-weight:700;color:#00ffa3;text-transform:capitalize">${plan || 'Starter'}</div>
        </div>
        <p><strong>API Key:</strong></p>
        <span class="code" style="font-size:12px">${apiKey}</span>
        <p><strong>API Secret (save this now):</strong></p>
        <span class="code" style="font-size:12px">${apiSecret}</span>
        <div style="text-align:center"><a href="${FRONTEND_URL}/merchant" class="btn">Open Dashboard</a></div>
        <hr class="divider">
        <p style="font-size:13px;color:#f97316">Store your API Secret securely. It cannot be retrieved later.</p>
        <p style="font-size:13px;color:#6b7280">Your trial will end on ${trialEnds ? new Date(trialEnds).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}) : '14 days from now'}. You will receive a reminder email before it expires.</p>
      </div><div class="footer">2025 Magic Worlds Tracker</div></div>
    </body></html>`,
  });
}

module.exports = { sendMagicLink, sendPasswordReset, sendWelcomeAffiliate, sendWelcomeMerchant, addBrevoContact };
