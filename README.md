# Affiliate Tracking Platform — Vercel Edition

Full-stack affiliate tracking platform with S2S tracking, Web3 wallet attribution, and Excel payout reports. Rewritten from Express + SQLite to **Vercel Serverless Functions + PostgreSQL**.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Hosting | Vercel (serverless) |
| Database | PostgreSQL (Neon / Supabase / Vercel Postgres) |
| Auth | JWT + magic links |
| Frontend | Vanilla HTML + Tailwind CDN |

---

## Deployment (5 steps)

### 1. Get a Postgres database

Pick any of:
- **[Neon](https://neon.tech)** — free tier, generous limits, serverless-native ✅ recommended
- **[Supabase](https://supabase.com)** — free tier, includes UI
- **[Vercel Postgres](https://vercel.com/docs/storage/vercel-postgres)** — native integration

Copy the **connection string** — it looks like:
```
postgresql://user:password@host.neon.tech/dbname?sslmode=require
```

### 2. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create affiliate-tracker --public --push
```

### 3. Deploy on Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your GitHub repo
3. In **Environment Variables**, add all variables from `.env.example`:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Your Postgres connection string |
| `JWT_SECRET` | Random 64-char hex string |
| `ADMIN_EMAIL` | Your admin email |
| `ADMIN_PASSWORD` | Strong password |
| `DEFAULT_REDIRECT_URL` | Your main website |
| `ATTRIBUTION_WINDOW_DAYS` | `30` |
| `NEXT_PUBLIC_BASE_URL` | `https://your-project.vercel.app` |

4. Click **Deploy**

### 4. Run the database migration

After your first deploy, run this once from your local machine (with `.env` set up):

```bash
npm install
node db/migrate.js
```

Or connect to your DB with `psql` and run the SQL in `db/migrate.js` manually.

### 5. Done ✅

Visit your deployment:
- `/` — Landing page
- `/dashboard` — Affiliate portal (sign up / magic link login)
- `/admin` — Admin panel
- `/api` — API documentation

---

## Local Development

```bash
# Install Vercel CLI
npm install -g vercel

# Install dependencies
npm install

# Copy env
cp .env.example .env
# Fill in DATABASE_URL etc.

# Run migrations
node db/migrate.js

# Start dev server
vercel dev
```

---

## API Reference

### Tracking

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/r/:affiliateCode` | Redirect link (tracks click) |
| POST | `/api/track/conversion` | S2S conversion postback |
| GET | `/api/track/script.js` | Client-side JS snippet |
| GET | `/api/track/info` | Current visitor attribution info |

### Affiliates (JWT required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/affiliates/signup` | Register new affiliate |
| POST | `/api/affiliates/login` | Request magic link |
| GET | `/api/affiliates/magic` | Verify magic link → JWT |
| GET | `/api/affiliates/me` | Own profile |
| PUT | `/api/affiliates/me` | Update profile |
| GET | `/api/affiliates/stats` | Own statistics |
| GET | `/api/affiliates/conversions` | Own conversions |

### Admin (Admin JWT required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/admin/login` | Admin login |
| GET | `/api/admin/stats` | Platform statistics |
| GET | `/api/admin/affiliates` | List affiliates |
| GET/PUT/DELETE | `/api/admin/affiliates/[id]` | Manage affiliate |
| GET/PUT | `/api/admin/conversions` | List & approve conversions |
| GET | `/api/admin/payout` | Download Excel payout report |
| GET/POST/DELETE | `/api/admin/destinations` | Manage redirect destinations |

---

## S2S Integration Example

```bash
curl -X POST https://your-project.vercel.app/api/track/conversion \
  -H "Content-Type: application/json" \
  -d '{
    "affiliate_code": "ABC12345",
    "conversion_type": "purchase",
    "conversion_value": 99.99,
    "currency": "USD",
    "metadata": { "order_id": "ORD-001" }
  }'
```

## JavaScript Snippet (partner sites)

```html
<script src="https://your-project.vercel.app/api/track/script.js"></script>
<script>
  // After wallet connect:
  AffiliateTracker.trackWalletConnect('0x...walletAddress', 'ethereum');

  // After purchase:
  AffiliateTracker.trackPurchase(99.99, 'USD', 'order-123');

  // Custom event:
  AffiliateTracker.convert('signup', { plan: 'pro' }, 0, 'USD');
</script>
```

---

## Adding Email for Magic Links

In `api/affiliates/login.js`, replace the `console.log` line with your email provider:

**Resend (recommended):**
```js
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
await resend.emails.send({
  from: 'noreply@yourdomain.com',
  to: email,
  subject: 'Your login link',
  html: `<a href="${magicUrl}">Click here to log in</a>`
});
```

**SendGrid / Mailgun / Postmark** — same pattern, swap the client.

---

## Security Notes

- Change `ADMIN_PASSWORD` — never use the default
- `JWT_SECRET` should be at least 64 random characters
- The `dev_magic_url` field in login responses is suppressed in `NODE_ENV=production`
- All Postgres queries use parameterized statements (no SQL injection)
