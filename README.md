# Venmo Arbitrageur

Opportunity scanner and net yield calculator for Venmo and Cash App. Finds cashback, referral bonuses, fee avoidance, and timing windows. Demo mode works without keys.

**Live:** https://venmo-arbitrageur-jeremygarbitt535-4478.vercel.app

## Features

- Scan for yield opportunities (cashback, referrals, fee arbitrage, timing)
- Risk-adjusted net yield scoring
- Free daily scan limit with Premium unlock ($19 one-time / $49 lifetime)
- Soft paywall that blurs locked higher-yield windows
- Persist last scan results in the browser
- Activity log of scans, exports, and simulated executes
- Share / referral link
- PWA (installable on iOS and Android)
- Real-time WebSocket updates
- Daily cron scan with Telegram, Discord, and Slack alerts (deep links included)
- Plaid balance and transactions when credentials are set
- Open Graph share card for social links

## Local run

```bash
npm install
cp .env.example .env   # optional
npm start
```

Open http://localhost:3000

## Environment variables

See `.env.example`. Key ones:

| Variable | Purpose |
|----------|---------|
| `PLAID_CLIENT_ID` / `PLAID_SECRET` | Live Plaid (optional — demo works without) |
| `PLAID_ENV` | `sandbox` or `production` |
| `YIELD_THRESHOLD` | Minimum net yield to show (default 0.5) |
| `CRON_SECRET` | Protects the `/cron/scan` endpoint |
| `ALERT_WEBHOOKS` | Comma-separated Telegram / Discord / Slack webhook URLs |
| `ALERT_THRESHOLD` | Minimum net to trigger an alert |
| `PREMIUM_URL` | Stripe Payment Link for upgrades |
| `APP_URL` | Public URL used in alert deep links |

## Deploy

### Vercel (current production)

1. Connect the repo
2. Set environment variables in the project settings
3. Deploy — `vercel.json` configures the daily cron

### Render

1. New Web Service from the repo
2. It picks up `render.yaml` and the `Dockerfile`
3. Set the same env vars

### Docker

```bash
docker build -t venmo-arbitrageur .
docker run -p 3000:3000 venmo-arbitrageur
```

## API

| Endpoint | Method | Notes |
|----------|--------|-------|
| `/` | GET | Main UI |
| `/scan` | POST | Run a scan (rate-limited for free) |
| `/scans-remaining` | GET | Free scans left today |
| `/balance` | GET | Plaid balance (or demo) |
| `/execute` | POST | Simulate an opportunity |
| `/cron/scan` | POST | Protected daily scan (needs `CRON_SECRET`) |
| `/premium` | GET | Premium status JSON |
| `/health` | GET | Health check |

## Notes

This is a scanner and calculator. Real money movement requires additional payment rails, compliance, and capital — not included here.

Free users get 3 scans per day. Premium removes the limit and enables alerts.
