const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
require('dotenv').config();

const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;

function getBasePath() {
  if (PLAID_ENV === 'production') return PlaidEnvironments.production;
  if (PLAID_ENV === 'development') return PlaidEnvironments.development;
  return PlaidEnvironments.sandbox;
}

let plaidClient = null;

if (PLAID_CLIENT_ID && PLAID_SECRET) {
  const configuration = new Configuration({
    basePath: getBasePath(),
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
        'PLAID-SECRET': PLAID_SECRET,
      },
    },
  });
  plaidClient = new PlaidApi(configuration);
}

async function getAccountBalance(accessToken) {
  if (!plaidClient) {
    return { available: 1250.75, current: 1280.40, iso_currency_code: 'USD', source: 'demo' };
  }
  if (!accessToken) {
    throw new Error('accessToken required when Plaid credentials are configured');
  }
  const response = await plaidClient.accountsGet({ access_token: accessToken });
  const account = response.data.accounts[0];
  return {
    available: account.balances.available,
    current: account.balances.current,
    iso_currency_code: account.balances.iso_currency_code,
    source: 'plaid',
    account_id: account.account_id,
    name: account.name,
  };
}

async function getTransactions(accessToken, days = 30) {
  if (!plaidClient || !accessToken) {
    return [];
  }
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);
  const response = await plaidClient.transactionsGet({
    access_token: accessToken,
    start_date: start.toISOString().split('T')[0],
    end_date: end.toISOString().split('T')[0],
    options: { count: 100 },
  });
  return response.data.transactions || [];
}

module.exports = { plaidClient, getAccountBalance, getTransactions, isConfigured: !!plaidClient };
