// test-fetch.js
require('dotenv').config();
const F = require('./Functions/functions.improved.js');

(async () => {
  try {
    await F.ensureBrowser();
    const price = await F.fetchPriceForTicker('INFM', {
      PRICE_URL_TEMPLATE: process.env.PRICE_URL_TEMPLATE,
      PRICE_SELECTOR: process.env.PRICE_SELECTOR // može biti prazan
    });
    console.log('INFM price ->', price);
    await F.closeBrowser();
  } catch (e) {
    console.error('Test fetch error:', e);
    try { await F.closeBrowser(); } catch (_) {}
  }
})();
