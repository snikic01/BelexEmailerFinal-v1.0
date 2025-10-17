// server.merged.js
// Merged server that uses Functions.improved.js (Functions folder)
// This variant ensures we use the PRICE_SELECTOR from .env (exact field) and robustly loads/saves prices.json

// SERVER: globalni safety handlers (sprečava crash zbog neuhvaćenih grešaka)
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (will log, consider restart):', err && err.stack || err);
  // Ne radimo process.exit ovde automatski - loguj i prepusti process manageru da restartuje ako treba.
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

require('dotenv').config();
const path = require('path');
const F = require('./Functions/functions.improved.js');

const PRICES_FILE = process.env.PRICES_FILE || 'prices.json';

(async function main() {
  try {
    console.log('Starting merged server...');

    // ensure puppeteer browser is launched
    await F.ensureBrowser();

    // load persisted prices (robust)
    const pricesState = await F.loadPrices(PRICES_FILE);

    // build initial tickers list from env or prices file
    const envTickers = (process.env.TRACK_TICKERS || '')
      .split(/[ ,;|]+/)
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);
    const fileTickers = Object.keys(pricesState || {});
    let trackedTickers = Array.from(new Set([...envTickers, ...fileTickers]));

    if (trackedTickers.length === 0) {
      console.warn('No initial tracked tickers found. The service will still reply to IMAP requests. Set TRACK_TICKERS in .env if you want automatic tracking.');
    } else {
      console.log('Tracking tickers:', trackedTickers.join(', '));
    }

    // periodic check function
    const checkFn = async () => {
      try {
        if (trackedTickers.length === 0) return;
        console.log(new Date().toISOString(), 'Periodic check for', trackedTickers.join(', '));
        await F.checkTickersAndAlert(trackedTickers, pricesState, {
          PRICE_SELECTOR: process.env.PRICE_SELECTOR || F.defaults.PRICE_SELECTOR,
          PRICE_URL_TEMPLATE: process.env.PRICE_URL_TEMPLATE || F.defaults.PRICE_URL_TEMPLATE,
          ALERT_UP_PERCENT: process.env.ALERT_UP_PERCENT || F.defaults.ALERT_UP_PERCENT,
          ALERT_DOWN_PERCENT: process.env.ALERT_DOWN_PERCENT || F.defaults.ALERT_DOWN_PERCENT,
          ALERT_RECEIVER: process.env.ALERT_RECEIVER || F.defaults.ALERT_RECEIVER,
          PRICES_FILE: PRICES_FILE,
        });
      } catch (e) {
        console.error('Error during periodic check', e.message || e);
      }
    };

    // start periodic task
    const intervalSeconds = parseInt(process.env.CHECK_INTERVAL_SECONDS || '90', 10);
    const stopPeriodic = F.startPeriodicTask(checkFn, intervalSeconds);

    // IMAP mail handler: parse subject for tickers and reply with current prices
    const onMail = async ({ subject, from }) => {
      try {
        console.log('Incoming mail from', from, 'subject:', subject);
        const tickers = F.parseTickersFromSubject(subject);
        if (!tickers || tickers.length === 0) {
          console.log('No tickers parsed from subject. Ignoring.');
          return;
        }

        // fetch prices concurrently with a small concurrency limit
        const results = {};
        const concurrency = parseInt(process.env.IMAP_FETCH_CONCURRENCY || '4', 10);
        // simple concurrency queue
        const queue = [...tickers];
        const workers = [];
        for (let i = 0; i < concurrency; i++) {
          workers.push((async () => {
            while (queue.length > 0) {
              const t = queue.shift();
              try {
                const price = await F.fetchPriceForTicker(t, {
                  PRICE_SELECTOR: process.env.PRICE_SELECTOR || F.defaults.PRICE_SELECTOR,
                  PRICE_URL_TEMPLATE: process.env.PRICE_URL_TEMPLATE || F.defaults.PRICE_URL_TEMPLATE,
                });
                results[t] = { price };
                // also ensure it's added to trackedTickers
                if (!trackedTickers.includes(t)) {
                  trackedTickers.push(t);
                }
                // update persisted state
                pricesState[t] = { price, updated: new Date().toISOString() };
                await F.savePrices(pricesState, PRICES_FILE);
              } catch (e) {
                results[t] = { error: e.message || String(e) };
              }
            }
          })());
        }
        await Promise.all(workers);

        // build reply
        const lines = [];
        for (const t of tickers) {
          const r = results[t];
          if (!r) lines.push(`${t}: no data`);
          else if (r.error) lines.push(`${t}: error (${r.error})`);
          else lines.push(`${t}: ${r.price}`);
        }

        const replyText = `Current prices for requested tickers:\n\n${lines.join('\\n')}`;
        await F.sendMail(from, `Re: ${subject} - prices`, replyText, {
          SMTP_USER: process.env.SMTP_USER,
          SMTP_HOST: process.env.SMTP_HOST,
          SMTP_PORT: process.env.SMTP_PORT,
        });

        console.log('Replied to', from);

      } catch (e) {
        console.error('onMail handler error', e.message || e);
      }
    };

    // start IMAP polling
    let stopImap = null;
    try {
      stopImap = await F.startImapPolling(onMail, {
        IMAP_USER: process.env.IMAP_USER,
        IMAP_PASSWORD: process.env.IMAP_PASSWORD,
        IMAP_HOST: process.env.IMAP_HOST,
        IMAP_PORT: process.env.IMAP_PORT,
        IMAP_POLL_MS: process.env.IMAP_POLL_MS,
      });
      console.log('IMAP polling started.');
    } catch (e) {
      console.error('Could not start IMAP polling:', e.message || e);
    }

    // graceful shutdown
    async function shutdown() {
      console.log('Shutdown initiated...');
      try {
        if (stopImap) await stopImap();
        stopPeriodic();
        await F.closeBrowser();
        console.log('Shutdown complete.');
      } catch (e) {
        console.error('Error during shutdown', e.message || e);
      } finally {
        process.exit(0);
      }
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (e) {
    console.error('Fatal error in main:', e.message || e);
    process.exit(1);
  }
})();