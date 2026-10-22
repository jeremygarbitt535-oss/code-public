const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { getAccountBalance, getTransactions, isConfigured } = require('./plaidClient');
require('dotenv').config();

const PREMIUM_URL = process.env.PREMIUM_URL || 'https://buy.stripe.com/test_5kQ6oIebw51vgdT8CC2ZO00';

const app = express();
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
    this.riskPenalty = {
      Low: 0,
      Medium: 0.15,
      High: 0.4,
    };
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
      {
        id: 'venmo-cashback-1',
        name: 'Venmo Instant Cashback Boost',
        method: 'Venmo',
        potentialYield: 1.25 * scale,
        cashback: 1.25 * scale,
        referralBonus: 0,
        fees: 0,
        timingBonus: 0.1,
        riskLevel: 'Low',
        description: 'Active cashback promotion on select merchants via Venmo',
      },
      {
        id: 'referral-stack',
        name: 'Referral Stack + Bank Link',
        method: 'Venmo + Bank',
        potentialYield: 2.0,
        cashback: 0,
        referralBonus: 2.0,
        fees: 0.25,
        timingBonus: 0,
        riskLevel: 'Low',
        description: 'Referral bonus when linking a bank account and completing first transfer',
      },
      {
        id: 'fee-arbitrage',
        name: 'Fee Avoidance Window',
        method: 'Standard Transfer',
        potentialYield: 0.75,
        cashback: 0,
        referralBonus: 0,
        fees: -0.5,
        timingBonus: 0.25,
        riskLevel: 'Medium',
        description: 'Use standard (free) transfer instead of instant to capture net yield',
      },
      {
        id: 'high-yield-timing',
        name: 'Weekend Timing Premium',
        method: 'Venmo',
        potentialYield: 1.8 * scale,
        cashback: 1.0 * scale,
        referralBonus: 0.5,
        fees: 0.1,
        timingBonus: 0.4,
        riskLevel: 'Medium',
        description: 'Higher effective yield during off-peak processing windows',
      },
      {
        id: 'risk-adjusted',
        name: 'High Volume Route',
        method: 'Multi-hop',
        potentialYield: 3.2,
        cashback: 2.5,
        referralBonus: 1.0,
        fees: 0.8,
        timingBonus: 0.5,
        riskLevel: 'High',
        description: 'Higher gross but elevated risk from volume and routing',
      },
    ];

    return base.map((opp) => {
      const yieldResult = this.calculateYield(opp);
      return {
        ...opp,
        ...yieldResult,
        balanceContext: available,
      };
    });
  }

  async scanForOpportunities(customOpps, balance) {
    const opportunities = customOpps && customOpps.length
      ? customOpps
      : this.generateOpportunities(balance);

    const results = opportunities.map((opp) => {
      const yieldResult = this.calculateYield(opp);
      return {
        ...opp,
        ...yieldResult,
      };
    });

    return results
      .filter((r) => r.profitable)
      .sort((a, b) => b.net - a.net);
  }
}

const arbitrageur = new VenmoArbitrageur();

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    plaid: isConfigured,
    threshold: arbitrageur.threshold,
    timestamp: new Date().toISOString(),
    version: '1.1.0',
  });
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

    profitable.forEach((opp) => broadcast({ type: 'opportunity', data: opp }));

    res.json({
      yields: profitable,
      scanned: (opportunities || arbitrageur.generateOpportunities(balance)).length,
      balance: balance?.available ?? null,
      plaid: isConfigured,
    });
  } catch (err) {
    console.error('Scan error:', err.message);
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
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
