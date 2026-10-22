# Venmo Arbitrageur

Opportunity scanner and net yield calculator with Plaid integration. Demo mode works without keys.

## Local run

```bash
npm install
cp .env.example .env   # optional
npm start
```

Open http://localhost:3000

## Deploy (one-click style)

### Render (recommended free tier)
1. Fork or use this repo
2. Go to https://render.com → New → Web Service
3. Connect the repo (or use Docker)
4. It picks up `render.yaml` and `Dockerfile`
5. Deploy — you get a public URL

### Docker
```bash
docker build -t venmo-arbitrageur .
docker run -p 3000:3000 venmo-arbitrageur
```

## Features
- Generates and scores opportunities (cashback, referrals, fee avoidance, timing)
- Net yield with risk adjustment
- Plaid balance + transactions when credentials are set
- Demo mode otherwise
- Real-time WebSocket updates
- Simple UI at `/`
- `/premium` stub ready for Stripe monetization

Set `PLAID_CLIENT_ID`, `PLAID_SECRET`, and optional `PLAID_ENV` for live Plaid.

This is a scanner and calculator. Real money movement requires additional payment rails, compliance, and capital — not included here.
