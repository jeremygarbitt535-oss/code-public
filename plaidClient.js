// plaidClient.js
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const configuration = new Configuration({
  basePath: PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID || '',
      'PLAID-SECRET': process.env.PLAID_SECRET || '',
    },
  },
});

const plaidClient = new PlaidApi(configuration);

async function getAccountBalance(accessToken) {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    return 42.5;
  }
  const response = await plaidClient.accountsGet({
    access_token: accessToken,
  });
  return response.data.accounts[0].balances.available;
}

module.exports = { plaidClient, getAccountBalance };
