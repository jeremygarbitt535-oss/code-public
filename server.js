const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { getAccountBalance, getTransactions, isConfigured } = require('./plaidClient');
require('dotenv').config();
const GUIDE_HTML = require('./guide');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// The one Payment Link shown on the site ($19 one-time, live mode).
const PREMIUM_URL = process.env.PREMIUM_URL || 'https://buy.stripe.com/4gM4gs9F55BA4GK3D59bO04';
const APP_URL = process.env.APP_URL || 'https://venmo-arbitrageur-jeremygarbitt535-4478.vercel.app';
const FREE_SCANS_PER_DAY = 3;
const CRON_SECRET = process.env.CRON_SECRET || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.CRON_SECRET || '';
const ALERT_THRESHOLD = Number(process.env.ALERT_THRESHOLD) || 1.0;

// Stripe: a *restricted* key with read access to Checkout Sessions is enough.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
// Signs the premium cookie and the free-scan counter cookie.
const COOKIE_SECRET = process.env.PREMIUM_COOKIE_SECRET || '';
// Payment Links whose completed purchases unlock Premium (all links on the account
// that sell this product). Override with a comma-separated env var if you add more.
const PREMIUM_PAYMENT_LINKS = (process.env.PREMIUM_PAYMENT_LINKS ||
  'plink_1UTiJ82eNj7zDnseMjBBX4D3,plink_1UTVm32eNj7zDnsehhrlEwbB,plink_1UTVm22eNj7zDnseSL986kbl,plink_1UTVm12eNj7zDnseBUa4lAQE,plink_1UTVm12eNj7zDnseQ4BZe0g0')
  .split(',').map(s => s.trim()).filter(Boolean);
const PREMIUM_COOKIE = 'va_premium';
const SCAN_COOKIE = 'va_scans';
const PREMIUM_DAYS = 365;

const ALERT_WEBHOOKS = (process.env.ALERT_WEBHOOKS || process.env.ALERT_WEBHOOK || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const scanCounts = new Map(); // best-effort per-IP counter (per server instance)
const recentResults = [];
const subscribers = []; // in-memory only; also logged + forwarded to ALERT_WEBHOOKS

// ---------------------------------------------------------------------------
// Signed cookies (no extra dependencies)
// ---------------------------------------------------------------------------
function sign(value) {
  return crypto.createHmac('sha256', COOKIE_SECRET).update(value).digest('base64url');
}
function encodeSigned(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${body}.${sign(body)}`;
}
function decodeSigned(token) {
  if (!COOKIE_SECRET || !token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, name, value, maxAgeSeconds) {
  const cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
}

function getPremium(req) {
  const data = decodeSigned(parseCookies(req)[PREMIUM_COOKIE]);
  if (!data || !data.exp || data.exp < Date.now()) return null;
  return data;
}
function isPremium(req) {
  return !!getPremium(req);
}

// ---------------------------------------------------------------------------
// Free scan limit: max(signed cookie counter, per-IP counter)
// ---------------------------------------------------------------------------
function getClientKey(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}
function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}
function getScansUsed(req) {
  const today = getTodayKey();
  const ipRecord = scanCounts.get(getClientKey(req));
  const ipCount = ipRecord && ipRecord.date === today ? ipRecord.count : 0;
  const c = decodeSigned(parseCookies(req)[SCAN_COOKIE]);
  const cookieCount = c && c.date === today ? c.count : 0;
  return Math.max(ipCount, cookieCount);
}
function incrementScans(req, res) {
  const today = getTodayKey();
  const count = getScansUsed(req) + 1;
  scanCounts.set(getClientKey(req), { date: today, count });
  if (COOKIE_SECRET) setCookie(res, SCAN_COOKIE, encodeSigned({ date: today, count }), 60 * 60 * 26);
  return count;
}

function storeResult(result) {
  recentResults.unshift({ ...result, at: new Date().toISOString() });
  if (recentResults.length > 50) recentResults.pop();
}

async function sendToWebhook(url, text, high) {
  try {
    if (url.includes('api.telegram.org')) {
      const full = url.includes('?')
        ? `${url}&text=${encodeURIComponent(text)}`
        : `${url}?text=${encodeURIComponent(text)}`;
      await fetch(full);
    } else if (url.includes('discord.com/api/webhooks') || url.includes('hooks.slack.com')) {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, text }),
      });
    } else {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, opportunities: high }),
      });
    }
  } catch (e) {
    console.error(`Webhook failed (${url.slice(0, 40)}...):`, e.message);
  }
}

async function sendAlert(opportunities) {
  const high = opportunities.filter(o => o.net >= ALERT_THRESHOLD);
  if (!high.length || !ALERT_WEBHOOKS.length) return;
  const lines = high.map(o => `${o.name}: +$${o.net.toFixed(2)}${o.illustrative ? ' (illustrative example)' : ''}`);
  const text = `Venmo Arbitrageur calculator results:\n${lines.join('\n')}\n\nOpen: ${APP_URL}`;
  await Promise.all(ALERT_WEBHOOKS.map(url => sendToWebhook(url, text, high)));
}

// ---------------------------------------------------------------------------
// Stripe Checkout Session verification (REST, no SDK needed)
// ---------------------------------------------------------------------------
async function retrieveCheckoutSession(sessionId) {
  const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body?.error?.message || `Stripe error ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return body;
}

function sessionUnlocksPremium(session) {
  if (!session || session.object !== 'checkout.session') return false;
  if (session.status !== 'complete') return false;
  if (session.payment_status !== 'paid') return false;
  if (!session.livemode && process.env.ALLOW_TEST_PURCHASES !== 'true') return false;
  if (PREMIUM_PAYMENT_LINKS.length && !PREMIUM_PAYMENT_LINKS.includes(session.payment_link)) return false;
  return true;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`));
  next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(payload) {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(message);
  });
}

// ---------------------------------------------------------------------------
// Calculator. NOTE: this does not fetch live promotions from Venmo or Cash App
// (neither offers a public API for that). Built-in scenarios are illustrative
// examples; real results come from numbers the user enters.
// ---------------------------------------------------------------------------
class VenmoArbitrageur {
  constructor() {
    this.threshold = Number(process.env.YIELD_THRESHOLD) || 0.5;
    this.riskPenalty = { Low: 0, Medium: 0.15, High: 0.4 };
  }

  calculateYield({ cashback = 0, referralBonus = 0, fees = 0, timingBonus = 0, riskLevel = 'Low' }) {
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const gross = n(cashback) + n(referralBonus) + n(timingBonus) - n(fees);
    const penalty = this.riskPenalty[riskLevel] || 0;
    const net = gross - penalty;
    return { gross: Number(gross.toFixed(2)), net: Number(net.toFixed(2)), penalty: Number(penalty.toFixed(2)), profitable: net > this.threshold };
  }

  exampleScenarios() {
    const base = [
      { id: 'example-referral', name: 'Example: referral bonus minus transfer fee', method: 'Venmo + Bank', cashback: 0, referralBonus: 5.0, fees: 0.25, timingBonus: 0, riskLevel: 'Low', description: 'Illustrative numbers. Check the Venmo or Cash App app for any referral offer actually available to you and its terms.' },
      { id: 'example-standard-transfer', name: 'Example: standard vs instant transfer on $100', method: 'Standard Transfer', cashback: 0, referralBonus: 0, fees: -1.75, timingBonus: 0, riskLevel: 'Low', description: 'Venmo charges 1.75% (min $0.25, max $25) for Instant Transfer; standard transfer is free (1-3 business days). Choosing standard on $100 avoids $1.75.' },
      { id: 'example-cashback', name: 'Example: card cashback offer', method: 'Venmo Debit/Credit Card', cashback: 1.5, referralBonus: 0, fees: 0, timingBonus: 0, riskLevel: 'Low', description: 'Illustrative numbers. Merchant cashback offers vary by account; confirm in the app before purchasing.' },
    ];
    return base.map((opp) => ({ ...opp, illustrative: true }));
  }

  async scanForOpportunities(customOpps) {
    const custom = Array.isArray(customOpps) && customOpps.length;
    const opportunities = custom
      ? customOpps.slice(0, 25).map((o, i) => ({
          id: String(o.id || `custom-${i + 1}`).slice(0, 60),
          name: String(o.name || `Your offer ${i + 1}`).slice(0, 120),
          method: String(o.method || 'Custom').slice(0, 60),
          cashback: o.cashback, referralBonus: o.referralBonus, fees: o.fees, timingBonus: o.timingBonus,
          riskLevel: ['Low', 'Medium', 'High'].includes(o.riskLevel) ? o.riskLevel : 'Low',
          description: String(o.description || 'Entered by you').slice(0, 300),
          illustrative: false,
        }))
      : this.exampleScenarios();
    const results = opportunities.map((opp) => ({ ...opp, ...this.calculateYield(opp) }));
    return { all: results.sort((a, b) => b.net - a.net), illustrative: !custom };
  }
}

const arbitrageur = new VenmoArbitrageur();

// ---------------------------------------------------------------------------
// Email capture
// ---------------------------------------------------------------------------
app.post('/subscribe', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return res.status(400).json({ error: 'Valid email required' });
  if (!subscribers.includes(email)) {
    subscribers.push(email);
    console.log('New subscriber:', email);
    ALERT_WEBHOOKS.forEach(url => sendToWebhook(url, `New Venmo Arbitrageur subscriber: ${email}`, []).catch(() => {}));
  }
  res.json({ ok: true, message: 'Subscribed' });
});

app.get('/subscribers', (req, res) => {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.secret;
  if (!ADMIN_SECRET || auth !== ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ count: subscribers.length, emails: subscribers.slice(-50), note: 'In-memory list for this server instance only.' });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    version: '2.0.0',
    plaid: isConfigured,
    freeScansPerDay: FREE_SCANS_PER_DAY,
    stripeVerification: !!STRIPE_SECRET_KEY,
    cookieSigning: !!COOKIE_SECRET,
    alertWebhooks: ALERT_WEBHOOKS.length,
  });
});

app.get('/scans-remaining', (req, res) => {
  if (isPremium(req)) return res.json({ used: 0, remaining: null, limit: null, premium: true });
  const used = getScansUsed(req);
  res.json({ used, remaining: Math.max(0, FREE_SCANS_PER_DAY - used), limit: FREE_SCANS_PER_DAY, premium: false });
});

app.get('/premium-status', (req, res) => {
  const p = getPremium(req);
  res.json({ premium: !!p, expires: p ? new Date(p.exp).toISOString() : null });
});

// Stripe Payment Links redirect here after a completed checkout:
//   /premium?session_id={CHECKOUT_SESSION_ID}
app.get('/premium', async (req, res) => {
  const sessionId = String(req.query.session_id || '');
  const page = (title, msg, ok) => res.status(ok ? 200 : 400).type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex"><title>${title}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:40px 16px;background:#0f172a;color:#e2e8f0;text-align:center}.card{max-width:460px;margin:0 auto;background:#1e293b;border-radius:16px;padding:28px;border:1px solid ${ok ? '#22c55e' : '#f59e0b'}}h1{margin:0 0 8px;color:${ok ? '#22c55e' : '#fbbf24'}}p{color:#cbd5e1}a.btn{display:inline-block;background:#22c55e;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600;margin:8px 4px 0}a.sec{background:#475569}code{word-break:break-all;font-size:12px;color:#94a3b8}</style></head><body><div class="card"><h1>${title}</h1>${msg}</div></body></html>`);

  if (!sessionId) return res.redirect(302, '/premium.html');
  if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId)) {
    return page('Invalid link', '<p>This activation link is not valid.</p><a class="btn sec" href="/premium.html">See Premium</a>', false);
  }
  if (!STRIPE_SECRET_KEY || !COOKIE_SECRET) {
    console.error('Premium activation unavailable: STRIPE_SECRET_KEY or PREMIUM_COOKIE_SECRET not set');
    return page('Activation pending',
      `<p>We can't confirm purchases automatically right now. If you just paid, your payment is safe with Stripe. Please bookmark this page and reload it later, or contact support with your Stripe receipt.</p><p><code>${sessionId}</code></p><a class="btn sec" href="/premium?session_id=${encodeURIComponent(sessionId)}">Try again</a>`, false);
  }
  try {
    const session = await retrieveCheckoutSession(sessionId);
    if (!sessionUnlocksPremium(session)) {
      return page('Payment not confirmed', '<p>We couldn\'t confirm a completed payment for this checkout. If you were charged, contact support with your Stripe receipt.</p><a class="btn sec" href="/premium.html">See Premium</a>', false);
    }
    const exp = Date.now() + PREMIUM_DAYS * 24 * 60 * 60 * 1000;
    setCookie(res, PREMIUM_COOKIE, encodeSigned({ sid: session.id, exp }), PREMIUM_DAYS * 24 * 60 * 60);
    console.log(`Premium activated for session ${session.id}`);
    const link = `${APP_URL}/premium?session_id=${encodeURIComponent(session.id)}`;
    return page('Premium unlocked',
      `<p>Thanks for your purchase. Unlimited calculations, CSV export and the guide are now unlocked in this browser.</p><p style="font-size:13px">To unlock another device, open this private link there (don't share it):<br><code>${link}</code></p><a class="btn" href="/">Open the app</a><a class="btn sec" href="/guide">Read the guide</a>`, true);
  } catch (err) {
    console.error('Stripe verification failed:', err.message);
    const notFound = err.status === 404;
    return page(notFound ? 'Payment not found' : 'Activation error',
      notFound ? '<p>We couldn\'t find that checkout.</p><a class="btn sec" href="/premium.html">See Premium</a>'
        : `<p>We couldn't reach Stripe to confirm your payment. Please try again in a minute.</p><a class="btn sec" href="/premium?session_id=${encodeURIComponent(sessionId)}">Try again</a>`, false);
  }
});

// Premium-only guide
app.get('/guide', (req, res) => {
  if (!isPremium(req)) return res.redirect(302, '/premium.html');
  res.type('html').send(GUIDE_HTML);
});

// Premium-only CSV export of the caller's results (sent in the body)
app.post('/export.csv', (req, res) => {
  if (!isPremium(req)) return res.status(402).json({ error: 'Premium required', premiumUrl: PREMIUM_URL });
  const rows = Array.isArray(req.body?.results) ? req.body.results.slice(0, 200) : [];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['name', 'method', 'cashback', 'referralBonus', 'fees', 'timingBonus', 'riskLevel', 'gross', 'penalty', 'net', 'illustrative'];
  const csv = [header.join(',')].concat(rows.map(r => header.map(h => esc(r[h])).join(','))).join('\n');
  res.type('text/csv').attachment('venmo-arbitrageur-results.csv').send(csv);
});

app.get('/results', (_req, res) => res.json({ results: recentResults.slice(0, 20) }));

app.get('/balance', async (req, res) => {
  try {
    const accessToken = req.query.accessToken || req.headers['x-access-token'];
    const balance = await getAccountBalance(accessToken);
    res.json(balance);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/scan', async (req, res) => {
  const premium = isPremium(req);
  const used = getScansUsed(req);

  if (!premium && used >= FREE_SCANS_PER_DAY) {
    return res.status(402).json({ error: 'Free limit reached', message: `You've used all ${FREE_SCANS_PER_DAY} free calculations today. Premium removes the limit.`, premiumUrl: PREMIUM_URL, remaining: 0 });
  }

  try {
    const { all, illustrative } = await arbitrageur.scanForOpportunities(req.body?.opportunities);
    const newUsed = premium ? used : incrementScans(req, res);
    storeResult({ count: all.length, illustrative });
    all.forEach((opp) => broadcast({ type: 'opportunity', data: opp }));

    res.json({
      results: all,
      yields: all.filter(r => r.profitable),
      illustrative,
      note: illustrative
        ? 'These are illustrative examples, not live offers. Enter real offers you see in your Venmo or Cash App app to calculate them.'
        : 'Calculated from the numbers you entered. Always verify offer terms in the app.',
      scansUsed: premium ? null : newUsed,
      scansRemaining: premium ? null : Math.max(0, FREE_SCANS_PER_DAY - newUsed),
      premium,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vercel Cron calls this with GET + "Authorization: Bearer $CRON_SECRET"
async function cronScan(req, res) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const provided = bearer || req.headers['x-cron-secret'] || req.query.secret;
  if (!CRON_SECRET || provided !== CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { all } = await arbitrageur.scanForOpportunities(null);
    storeResult({ count: all.length, illustrative: true, source: 'cron' });
    await sendAlert(all.filter(r => r.profitable));
    res.json({ ok: true, results: all.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
app.get('/cron/scan', cronScan);
app.post('/cron/scan', cronScan);

app.post('/execute', async (req, res) => {
  const { opportunityId } = req.body || {};
  if (!opportunityId) return res.status(400).json({ error: 'opportunityId required' });
  res.json({ ok: true, opportunityId, status: 'simulated', message: 'Nothing was executed. This app never moves money.' });
});

app.get('/transactions', async (req, res) => {
  try {
    const accessToken = req.query.accessToken;
    const txs = await getTransactions(accessToken);
    res.json({ transactions: txs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'connected', plaid: isConfigured })));

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`Venmo Arbitrageur listening on ${port}`);
  console.log(`Stripe verification: ${!!STRIPE_SECRET_KEY}, cookie signing: ${!!COOKIE_SECRET}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));

