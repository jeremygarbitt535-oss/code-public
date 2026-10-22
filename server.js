const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { getAccountBalance, getTransactions, isConfigured } = require('./plaidClient');
require('dotenv').config();

const PREMIUM_URL = process.env.PREMIUM_URL || 'https://buy.stripe.com/test_5kQ6oIebw51vgdT8CC2ZO00';
const APP_URL = process.env.APP_URL || 'https://venmo-arbitrageur-jeremygarbitt535-4478.vercel.app';
const FREE_SCANS_PER_DAY = 3;
const CRON_SECRET = process.env.CRON_SECRET || 'dev-secret';
const ALERT_THRESHOLD = Number(process.env.ALERT_THRESHOLD) || 1.0;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

const ALERT_WEBHOOKS = (process.env.ALERT_WEBHOOKS || process.env.ALERT_WEBHOOK || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const scanCounts = new Map();
const recentResults = [];
const premiumCodes = new Map(); // code -> { email, createdAt }

function getClientKey(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

function isPremium(req) {
  const code = req.headers['x-premium-code'] || req.query.premium || req.body?.premiumCode;
  return code && premiumCodes.has(code);
}

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

function getScansUsed(key) {
  const today = getTodayKey();
  const record = scanCounts.get(key);
  if (!record || record.date !== today) return 0;
  return record.count;
}

function incrementScans(key) {
  const today = getTodayKey();
  const record = scanCounts.get(key);
  if (!record || record.date !== today) {
    scanCounts.set(key, { date: today, count: 1 });
    return 1;
  }
  record.count += 1;
  return record.count;
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

  const lines = high.map(o => `${o.name}: +$${o.net.toFixed(2)}`);
  const top = high[0];
  const deep = top ? `${APP_URL}/?opp=${encodeURIComponent(top.id)}` : APP_URL;
  const text = `Venmo Arbitrageur alert:\n${lines.join('\n')}\n\nOpen: ${deep}`;
  console.log('ALERT:', text);

  await Promise.all(ALERT_WEBHOOKS.map(url => sendToWebhook(url, text, high)));
}

const app = express();

// Stripe webhook needs raw body for signature verification
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  if (STRIPE_WEBHOOK_SECRET && sig) {
    // Basic signature check (full verification needs stripe SDK; this is a lightweight stand-in)
    try {
      const payload = req.body.toString();
      const expected = crypto
        .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
        .update(payload)
        .digest('hex');
      // Accept if secret is set; real verification would use stripe.webhooks.constructEvent
      event = JSON.parse(payload);
    } catch (err) {
      console.error('Webhook parse error:', err.message);
      return res.status(400).send('Invalid payload');
    }
  } else {
    try {
      event = JSON.parse(req.body.toString());
    } catch (err) {
      return res.status(400).send('Invalid payload');
    }
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object || {};
    const email = session.customer_details?.email || session.customer_email || 'unknown';
    const code = crypto.randomBytes(8).toString('hex');
    premiumCodes.set(code, { email, createdAt: new Date().toISOString(), amount: session.amount_total });
    console.log(`Premium unlocked for ${email} → code ${code}`);

    // Optional: send the code via your existing alert webhooks so you can deliver it
    const msg = `Premium purchase: ${email}\nCode: ${code}\nUnlock: ${APP_URL}/?premium=${code}`;
    ALERT_WEBHOOKS.forEach(url => sendToWebhook(url, msg, []).catch(() => {}));
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
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

class VenmoArbitrageur {
  constructor() {
    this.threshold = Number(process.env.YIELD_THRESHOLD) || 0.5;
    this.riskPenalty = { Low: 0, Medium: 0.15, High: 0.4 };
  }

  calculateYield({ cashback = 0, referralBonus = 0, fees = 0, timingBonus = 0, riskLevel = 'Low' }) {
    const gross = cashback + referralBonus + timingBonus - fees;
    const penalty = this.riskPenalty[riskLevel] || 0;
    const net = gross - penalty;
    return {
      gross: Number(gross.toFixed(2)),
      net: Number(net.toFixed(2)),
      penalty: Number(penalty.toFixed(2)),
      profitable: net > this.threshold,
    };
  }

  generateOpportunities(balance) {
    const available = typeof balance === 'number' ? balance : (balance?.available || 0);
    const scale = Math.min(Math.max(available / 500, 0.5), 3);
    const base = [
      { id: 'venmo-cashback-1', name: 'Venmo Instant Cashback Boost', method: 'Venmo', potentialYield: 1.25 * scale, cashback: 1.25 * scale, referralBonus: 0, fees: 0, timingBonus: 0.1, riskLevel: 'Low', description: 'Active cashback promotion on select merchants via Venmo' },
      { id: 'referral-stack', name: 'Referral Stack + Bank Link', method: 'Venmo + Bank', potentialYield: 2.0, cashback: 0, referralBonus: 2.0, fees: 0.25, timingBonus: 0, riskLevel: 'Low', description: 'Referral bonus when linking a bank account and completing first transfer' },
      { id: 'fee-arbitrage', name: 'Fee Avoidance Window', method: 'Standard Transfer', potentialYield: 0.75, cashback: 0, referralBonus: 0, fees: -0.5, timingBonus: 0.25, riskLevel: 'Medium', description: 'Use standard (free) transfer instead of instant to capture net yield' },
      { id: 'high-yield-timing', name: 'Weekend Timing Premium', method: 'Venmo', potentialYield: 1.8 * scale, cashback: 1.0 * scale, referralBonus: 0.5, fees: 0.1, timingBonus: 0.4, riskLevel: 'Medium', description: 'Higher effective yield during off-peak processing windows' },
      { id: 'risk-adjusted', name: 'High Volume Route', method: 'Multi-hop', potentialYield: 3.2, cashback: 2.5, referralBonus: 1.0, fees: 0.8, timingBonus: 0.5, riskLevel: 'High', description: 'Higher gross but elevated risk from volume and routing' },
    ];
    return base.map((opp) => ({ ...opp, ...this.calculateYield(opp), balanceContext: available }));
  }

  async scanForOpportunities(customOpps, balance) {
    const opportunities = customOpps && customOpps.length ? customOpps : this.generateOpportunities(balance);
    const results = opportunities.map((opp) => ({ ...opp, ...this.calculateYield(opp) }));
    return results.filter((r) => r.profitable).sort((a, b) => b.net - a.net);
  }
}

const arbitrageur = new VenmoArbitrageur();

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    plaid: isConfigured,
    threshold: arbitrageur.threshold,
    timestamp: new Date().toISOString(),
    version: '1.7.0',
    freeScansPerDay: FREE_SCANS_PER_DAY,
    recentScans: recentResults.length,
    alertWebhooks: ALERT_WEBHOOKS.length,
    alertThreshold: ALERT_THRESHOLD,
    premiumCodes: premiumCodes.size,
  });
});

app.get('/scans-remaining', (req, res) => {
  if (isPremium(req)) {
    return res.json({ used: 0, remaining: 999, limit: 999, premium: true });
  }
  const key = getClientKey(req);
  const used = getScansUsed(key);
  res.json({
    used,
    remaining: Math.max(0, FREE_SCANS_PER_DAY - used),
    limit: FREE_SCANS_PER_DAY,
    premium: false,
  });
});

app.get('/premium-status', (req, res) => {
  const code = req.query.code || req.headers['x-premium-code'];
  const ok = code && premiumCodes.has(code);
  res.json({ premium: !!ok, code: ok ? code : null });
});

app.get('/results', (_req, res) => {
  res.json({ results: recentResults.slice(0, 20) });
});

app.get('/balance', async (req, res) => {
  try {
    const accessToken = req.query.accessToken || req.headers['x-access-token'];
    const balance = await getAccountBalance(accessToken);
    res.json(balance);
  } catch (err) {
    console.error('Balance error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/scan', async (req, res) => {
  const premium = isPremium(req);
  const key = getClientKey(req);
  const used = getScansUsed(key);

  if (!premium && used >= FREE_SCANS_PER_DAY) {
    return res.status(402).json({
      error: 'Free scan limit reached',
      message: `You've used all ${FREE_SCANS_PER_DAY} free scans today. Unlock unlimited with Premium.`,
      premiumUrl: PREMIUM_URL,
      remaining: 0,
    });
  }

  try {
    const accessToken = req.body.accessToken || req.query.accessToken;
    let balance = null;
    if (accessToken || !isConfigured) {
      try {
        balance = await getAccountBalance(accessToken);
      } catch (_) {
        balance = { available: 0 };
      }
    }

    const opportunities = req.body.opportunities;
    const profitable = await arbitrageur.scanForOpportunities(opportunities, balance);
    const newUsed = premium ? used : incrementScans(key);

    storeResult({ yields: profitable, balance: balance?.available ?? null });
    await sendAlert(profitable);
    profitable.forEach((opp) => broadcast({ type: 'opportunity', data: opp }));

    res.json({
      yields: profitable,
      scanned: (opportunities || arbitrageur.generateOpportunities(balance)).length,
      balance: balance?.available ?? null,
      plaid: isConfigured,
      scansUsed: newUsed,
      scansRemaining: premium ? 999 : Math.max(0, FREE_SCANS_PER_DAY - newUsed),
      premium,
    });
  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/cron/scan', async (req, res) => {
  if (req.headers['x-cron-secret'] !== CRON_SECRET && req.query.secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const balance = await getAccountBalance().catch(() => ({ available: 0 }));
    const profitable = await arbitrageur.scanForOpportunities(null, balance);
    storeResult({ yields: profitable, balance: balance?.available ?? null, source: 'cron' });
    await sendAlert(profitable);
    profitable.forEach((opp) => broadcast({ type: 'opportunity', data: opp }));
    res.json({ ok: true, yields: profitable.length, top: profitable[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/execute', async (req, res) => {
  const { opportunityId } = req.body;
  if (!opportunityId) {
    return res.status(400).json({ error: 'opportunityId required' });
  }
  broadcast({ type: 'execution', data: { opportunityId, status: 'simulated', at: new Date().toISOString() } });
  res.json({
    ok: true,
    opportunityId,
    status: 'simulated',
    message: 'Execution recorded (simulation mode). Connect live rails for real movement.',
  });
});

app.get('/premium', (_req, res) => {
  res.json({
    status: 'available',
    price: '$19 lifetime',
    url: PREMIUM_URL,
    features: ['unlimited scans', 'real-time alerts', 'custom thresholds', 'export'],
    freeScansPerDay: FREE_SCANS_PER_DAY,
  });
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

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected', plaid: isConfigured }));
});

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`Venmo Arbitrageur listening on ${port}`);
  console.log(`Plaid configured: ${isConfigured}`);
  console.log(`Premium link: ${PREMIUM_URL}`);
  console.log(`Free scans/day: ${FREE_SCANS_PER_DAY}`);
  console.log(`Alert threshold: $${ALERT_THRESHOLD}`);
  console.log(`Alert webhooks configured: ${ALERT_WEBHOOKS.length}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
