const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { getAccountBalance } = require('./plaidClient');

class VenmoArbitrageur {
  constructor() {
    this.threshold = 0.5;
  }

  async calculateYield(cashback, referralBonus, fees) {
    return cashback + referralBonus - fees;
  }

  async scanForOpportunities(opportunities) {
    const checked = await Promise.all(opportunities.map(async (opp) => {
      const yieldValue = await this.calculateYield(opp.potentialYield, 0, 0);
      return yieldValue > this.threshold ? opp : null;
    }));
    return checked.filter(Boolean);
  }
}

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const arbitrageur = new VenmoArbitrageur();

function broadcast(payload) {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(message);
  });
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, plaid: Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET) });
});

app.post('/scan', async (req, res) => {
  const opportunities = req.body.opportunities || [
    { id: 'sandbox-1', potentialYield: 1.25, riskLevel: 'Low', method: 'sandbox' },
  ];
  const profitable = await arbitrageur.scanForOpportunities(opportunities);
  const yields = [];
  for (const opp of profitable) {
    const yieldValue = await arbitrageur.calculateYield(opp.potentialYield, 0, 0);
    const payload = { ...opp, yield: yieldValue };
    yields.push(payload);
    broadcast(payload);
  }
  res.json({ yields });
});

app.post('/execute', async (_req, res) => {
  res.json({ ok: true });
});

app.get('/balance', async (req, res) => {
  const available = await getAccountBalance(req.query.accessToken);
  res.json({ available });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log('listening on ' + port);
});
