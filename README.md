# Venmo Arbitrageur

Opportunity scanner and net yield calculator with Plaid integration.

## Run

```bash
npm install
cp .env.example .env   # optional — works in demo mode without keys
npm start
```

Open http://localhost:3000

## Features

- Generates and scores Venmo-related opportunities (cashback, referrals, fee avoidance, timing)
- Net yield calculation with risk adjustment
- Plaid balance + transactions when credentials are set
- Demo mode when Plaid keys are absent
- Real-time WebSocket updates
- Simple UI

Set `PLAID_CLIENT_ID` and `PLAID_SECRET` (and optional `PLAID_ENV=sandbox|development|production`) for live Plaid.
