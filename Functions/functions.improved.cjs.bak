// functions.improved.cjs
// Full corrected version with xpath support, autodetect, atomic prices.json and helpful logging.

const fs = require('fs');
const path = require('path');
const util = require('util');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const imaps = require('imap-simple');

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const rename = util.promisify(fs.rename);

// --- internal state ---
let browser = null;
let pagePool = [];
let transporter = null;

// --- terminal log helper ---
function logPriceSimple(ticker, price) {
  const now = new Date();
  const ts = now.toLocaleString('sr-RS', { hour12: false });
  console.log(`${ts} | ${ticker} | ${price}`);
}


// --- defaults ---
const DEFAULTS = {
  PRICE_URL_TEMPLATE: process.env.PRICE_URL_TEMPLATE || 'https://www.belex.rs/eng/trgovanje/hartija/dnevni/{TICKER}',
  PRICE_SELECTOR: process.env.PRICE_SELECTOR || null,
  CHECK_INTERVAL_SECONDS: parseInt(process.env.CHECK_INTERVAL_SECONDS || '90', 10),
  ALERT_UP_PERCENT: parseFloat(process.env.ALERT_UP_PERCENT || '5'),
  ALERT_DOWN_PERCENT: parseFloat(process.env.ALERT_DOWN_PERCENT || '5'),
  ALERT_RECEIVER: process.env.ALERT_RECEIVER || process.env.SMTP_USER,
  PUPPETEER_MAX_PAGES: parseInt(process.env.PUPPETEER_MAX_PAGES || '4', 10),
};

// --- persistence helper ---
function makePricesFilePath(filename = 'prices.json') {
  return path.resolve(process.cwd(), filename);
}

async function loadPrices(filename = 'prices.json') {
  const f = makePricesFilePath(filename);
  try {
    if (!fs.existsSync(f)) {
      await writeFile(f, JSON.stringify({}, null, 2), 'utf8');
      return {};
    }
    const txt = await readFile(f, 'utf8');
    try {
      return JSON.parse(txt) || {};
    } catch (parseErr) {
      console.warn('Warning: could not parse JSON in', f, '- backing up and starting fresh');
      const backup = f + '.bak.' + Date.now();
      try { await writeFile(backup, txt, 'utf8'); } catch (e) {}
      await writeFile(f, JSON.stringify({}, null, 2), 'utf8');
      return {};
    }
  } catch (e) {
    console.warn('loadPrices error', e.message || e);
    return {};
  }
}

async function savePrices(data, filename = 'prices.json') {
  const f = makePricesFilePath(filename);
  const tmp = f + '.tmp';
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, f);
  } catch (e) {
    console.error('savePrices error', e.message || e);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
  }
}

// --- nodemailer setup ---
function ensureTransport(opts = {}) {
  if (transporter) return transporter;
  const transportOpts = {
    host: opts.SMTP_HOST || process.env.SMTP_HOST,
    port: parseInt(opts.SMTP_PORT || process.env.SMTP_PORT || '587', 10),
    secure: (opts.SMTP_SECURE === 'true') || (process.env.SMTP_SECURE === 'true') || false,
    auth: {
      user: opts.SMTP_USER || process.env.SMTP_USER,
      pass: opts.SMTP_PASS || process.env.SMTP_PASS,
    },
  };
  transporter = nodemailer.createTransport(transportOpts);
  return transporter;
}

async function sendMail(to, subject, text, opts = {}) {
  const tr = ensureTransport(opts);
  const mail = {
    from: opts.SMTP_USER || process.env.SMTP_USER,
    to,
    subject,
    text,
  };
  return tr.sendMail(mail);
}

// --- Puppeteer browser + page pool ---
async function ensureBrowser(opts = {}) {
  if (browser) return browser;
  browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  pagePool = [];
  return browser;
}

async function getPage(opts = {}) {
  await ensureBrowser(opts);
  if (pagePool.length > 0) return pagePool.pop();
  const p = await browser.newPage();
  p.setDefaultNavigationTimeout(20000);
  return p;
}

async function releasePage(p, opts = {}) {
  if (!p) return;
  try {
    if (pagePool.length < (opts.PUPPETEER_MAX_PAGES || DEFAULTS.PUPPETEER_MAX_PAGES)) {
      await p.goto('about:blank');
      pagePool.push(p);
    } else {
      await p.close();
    }
  } catch (e) {
    try { await p.close(); } catch (e2) {}
  }
}

async function closeBrowser() {
  try {
    if (browser) await browser.close();
  } catch (e) {
    // ignore
  } finally {
    browser = null;
    pagePool = [];
  }
}

// --- parsing helpers ---
function parseTickersFromSubject(subject) {
  if (!subject || typeof subject !== 'string') return [];
  const parts = subject.split(/[ ,;|]+/).map(s => s.trim()).filter(Boolean);
  return parts.map(p => p.toUpperCase());
}

function extractNumberFromString(txt) {
  if (!txt) return NaN;

  let cleaned = txt.trim()
    .replace(/\s+/g, ' ')
    .replace(',', '.');

  // pokušaj da pronađe broj sa tačkom ili zarezom
  const match = cleaned.match(/(\d+[.,]?\d*)/);
  if (!match) return NaN;

  let numStr = match[1];
  let value = parseFloat(numStr.replace(',', '.'));

  // slučaj 8.400 → 8400
  if (/^\d{1,3}\.\d{3}$/.test(numStr)) {
    value = parseFloat(numStr.replace('.', ''));
  }

  // slučaj 8.4 (ali realno znači 8400)
  if (value < 50 && /\d\.\d{1,3}/.test(numStr)) {
    value *= 1000;
  }

  // slučaj 1.020442 → 1020.442
  if (value < 50 && numStr.includes('.') && numStr.split('.')[1].length > 2) {
    value *= 1000;
  }

  return value;
}


async function autodetectPriceFromPage(page) {
  // strategy 1: find table labels (th or td) exact 'cena'/'price' and pick sibling td
  const xpathRow = "//*[self::th or self::td][translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')='price' or translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')='cena']/following-sibling::td[1] | //*[self::th or self::td][translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')='price' or translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')='cena']/parent::tr/td[2]";
  try {
    const els = await page.$x(xpathRow);
    if (els && els.length > 0) {
      for (const el of els) {
        const text = await page.evaluate(e => e.textContent.trim(), el);
        const num = extractNumberFromString(text);
        if (!isNaN(num)) {
          console.log('autodetect: matched xpathRow, value=', num);
          return num;
        }
      }
    }
  } catch (e) { /* ignore */ }

  // strategy 2: label then next sibling element
  const xpathLabelNext = "//*[translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')='price' or translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')='cena']/following-sibling::*[1]";
  try {
    const els2 = await page.$x(xpathLabelNext);
    if (els2 && els2.length > 0) {
      for (const el of els2) {
        const text = await page.evaluate(e => e.textContent.trim(), el);
        const num = extractNumberFromString(text);
        if (!isNaN(num)) {
          console.log('autodetect: matched xpathLabelNext, value=', num);
          return num;
        }
      }
    }
  } catch (e) {}

  // strategy 3: container contains word and contains numbers
  const xpathContainer = "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'price') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'cena')]";
  try {
    const els3 = await page.$x(xpathContainer);
    if (els3 && els3.length > 0) {
      for (const el of els3) {
        const text = await page.evaluate(e => e.textContent.trim(), el);
        const num = extractNumberFromString(text);
        if (!isNaN(num)) {
          console.log('autodetect: matched xpathContainer, value=', num);
          return num;
        }
      }
    }
  } catch (e) {}

  return null;
}

// --- price fetcher ---
async function fetchPriceForTicker(ticker, opts = {}) {
  const urlTemplate = opts.PRICE_URL_TEMPLATE || DEFAULTS.PRICE_URL_TEMPLATE;
  let selector = (opts.PRICE_SELECTOR !== undefined) ? opts.PRICE_SELECTOR : DEFAULTS.PRICE_SELECTOR;
  const url = urlTemplate.replace('{TICKER}', encodeURIComponent(ticker));
  //console.log(`fetchPriceForTicker: ${ticker} -> ${url} (selector=${String(selector)})`);

  const p = await getPage(opts);
  try {
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });

    if (selector) {
      // support xpath: prefix
      if (typeof selector === 'string' && selector.startsWith('xpath:')) {
        const xp = selector.slice(6);
        try {
          // wait a short while for the xpath to appear (handles dynamically rendered pages)
          try {
            await p.waitForXPath(xp, { timeout: 6000 });
          } catch (waitErr) {
            // ignore - we'll still try to query $x immediately
          }

          // --- enhanced handling: try parsing number from matched element, try inside-element regex and page-level regex ---
          const els = await p.$x(xp);
          if (els && els.length > 0) {
            // try the first matched element
            const txt = await p.evaluate(e => e.textContent.trim(), els[0]);
            console.log(`Cena za ${ticker} je: "${txt}"`);
            // 1) try direct numeric parse from the element text (existing)
            let num = extractNumberFromString(txt);
            if (!isNaN(num)) {
              //console.log('fetchPrice: xpath selector succeeded (direct), value=', num);
              return num;
            }

            // 2) if direct parse failed, try to find number inside the element text with regex
            //    this handles cases like "Price5.002" (no whitespace) or "Price:5.002"
            try {
              const candidateInside = await p.evaluate(el => {
                const t = el.textContent || '';
                // regex allows immediate adjacency (no space) or optional separators
                const re = /(?:Price|Cena)[:\s]*([0-9]+[.,][0-9]{1,6})/i;
                const m = t.match(re);
                return m ? m[1] : null;
              }, els[0]);

              if (candidateInside) {
                const val = parseFloat(candidateInside.replace(',', '.'));
                if (!isNaN(val)) {
                  //console.log('fetchPrice: xpath selector succeeded (inside element regex), value=', val);
                  return val;
                }
              }
            } catch (eInner) {
              // ignore and try body-level search next
            }

            // 3) as a fallback, search the whole page text for "Price" or "Cena" followed by a number
            try {
              const pageCandidate = await p.evaluate(() => {
                const body = document.body.innerText || '';
                // try patterns with optional spaces/separators and also immediate adjacency
                const patterns = [
                  /(?:Price|Cena)[:\s]*([0-9]+[.,][0-9]{1,6})/i,
                  /(?:Price|Cena)([0-9]+[.,][0-9]{1,6})/i
                ];
                for (const re of patterns) {
                  const m = body.match(re);
                  if (m) return m[1];
                }
                return null;
              });

              if (pageCandidate) {
                const val2 = parseFloat(pageCandidate.replace(',', '.'));
                if (!isNaN(val2)) {
                  //console.log('fetchPrice: xpath selector fallback -> found in page text, value=', val2);
                  return val2;
                }
              }
            } catch (ePage) {
              // ignore and fallthrough to throwing below
            }

            // if we reach here, couldn't parse a number from the matched element or page
            throw new Error('XPath found element but text could not be parsed as number: ' + txt);
          } else {
            throw new Error('XPath did not match any elements: ' + xp);
          }
        } catch (e) {
          throw new Error(`Failed to extract price using xpath selector '${selector}' on ${url}: ${e.message || e}`);
        }
      } else {
        // treat as CSS selector
        try {
          await p.waitForSelector(selector, { timeout: 5000 });
          const txt = await p.$eval(selector, el => el.textContent.trim());
          const num = extractNumberFromString(txt);
          if (!isNaN(num)) {
            //console.log('fetchPrice: css selector succeeded, value=', num);
            return num;
          }
          throw new Error('Parsed selector text but could not convert to number: "' + txt + '"');
        } catch (selErr) {
          throw new Error(`Failed to extract price using selector '${selector}' on ${url}: ${selErr.message || selErr}`);
        }
      }
    }

    // if no selector provided, try autodetect
    //console.log('fetchPrice: no selector provided - attempting autodetect strategies');
    const auto = await autodetectPriceFromPage(p);
    if (auto != null) return auto;

    // --- enhanced fallback: try to find a number right after the words 'Price' or 'Cena' in the page text
    const body = await p.evaluate(() => document.body.innerText || '');

    // look for patterns like "Price 5.002" or "Cena 5,002"
    const nearPattern = /(?:Price|Cena)[^\d\n\r]{0,30}([0-9]+[.,][0-9]{1,6})/i;
    let m = body.match(nearPattern);
    if (m) {
      const val = parseFloat(m[1].replace(',', '.'));
      if (!isNaN(val)) {
        //console.log('fetchPrice: body near-word regex succeeded, value=', val);
        return val;
      }
    }

    // if not found, as before, take the first number-like token anywhere in the body
    const m2 = body.match(/([0-9]+[.,][0-9]{1,6})/);
    if (m2) {
      const val2 = parseFloat(m2[1].replace(',', '.'));
      //console.log('fetchPrice: fallback body regex succeeded, value=', val2);
      return val2;
    }

    throw new Error('Could not extract price for ' + ticker + ' (no selector matched and fallback failed)');
  } finally {
    await releasePage(p, opts);
  }
}

function pctChange(oldP, newP) {
  if (oldP == null || newP == null) return null;
  if (oldP === 0) return null;
  return ((newP - oldP) / oldP) * 100;
}

// --- alert checker for list of tickers ---
async function checkTickersAndAlert(tickers, pricesState = {}, opts = {}) {
  const results = {};
  const up = parseFloat(opts.ALERT_UP_PERCENT || DEFAULTS.ALERT_UP_PERCENT);
  const down = parseFloat(opts.ALERT_DOWN_PERCENT || DEFAULTS.ALERT_DOWN_PERCENT);
  const receiver = opts.ALERT_RECEIVER || DEFAULTS.ALERT_RECEIVER;

  for (const t of tickers) {
    try {
      const price = await fetchPriceForTicker(t, opts);
      const prev = pricesState[t] ? pricesState[t].price : null;
      const change = (prev != null) ? pctChange(prev, price) : null;

      results[t] = { price, prev, change };

      if (prev != null && change != null) {
        if (change >= up) {
          await sendMail(receiver, `ALERT +${up}% ${t} (${change.toFixed(2)}%)`, `${t} jumped from ${prev} to ${price} (${change.toFixed(2)}%)`, opts);
          pricesState[t] = { price, updated: new Date().toISOString() };
          await savePrices(pricesState, opts.PRICES_FILE || 'prices.json');
        } else if (change <= -down) {
          await sendMail(receiver, `ALERT -${down}% ${t} (${change.toFixed(2)}%)`, `${t} dropped from ${prev} to ${price} (${change.toFixed(2)}%)`, opts);
          pricesState[t] = { price, updated: new Date().toISOString() };
          await savePrices(pricesState, opts.PRICES_FILE || 'prices.json');
        } else {
          pricesState[t] = { price, updated: new Date().toISOString() };
          await savePrices(pricesState, opts.PRICES_FILE || 'prices.json');
        }
      } else {
        pricesState[t] = { price, updated: new Date().toISOString() };
        await savePrices(pricesState, opts.PRICES_FILE || 'prices.json');
      }

    } catch (e) {
      results[t] = { error: e.message || String(e) };
    }
  }

  return results;
}

// --- IMAP listener (polling) ---
// --- IMAP listener (polling) --- (REPLACE existing startImapPolling with this version)
async function startImapPolling(onMailCallback, opts = {}) {
  const imapConfig = {
    imap: {
      user: opts.IMAP_USER || process.env.IMAP_USER,
      password: opts.IMAP_PASSWORD || process.env.IMAP_PASSWORD,
      host: opts.IMAP_HOST || process.env.IMAP_HOST,
      port: parseInt(opts.IMAP_PORT || process.env.IMAP_PORT || '993', 10),
      tls: (process.env.IMAP_TLS || 'true').toLowerCase() !== 'false',
      authTimeout: 30000,
    },
  };

  if ((process.env.IMAP_TLS_REJECT_UNAUTHORIZED || '').toLowerCase() === 'false') {
    imapConfig.imap.tlsOptions = { rejectUnauthorized: false };
  }

  const pollMs = parseInt(opts.IMAP_POLL_MS || process.env.IMAP_POLL_MS || '30000', 10);

  let stopped = false;
  let connection = null;
  let pollInterval = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 10;

  function clearPoll() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  async function safeEndConnection() {
    try {
      if (connection) {
        try { await connection.end(); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      // ignore
    } finally {
      connection = null;
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    clearPoll();
    // try to close if open
    safeEndConnection().catch(() => { /* ignore */ });

    reconnectAttempts++;
    let delay;
    if (reconnectAttempts > MAX_RECONNECT) {
      delay = 60000; // cooldown
      reconnectAttempts = 0;
    } else {
      delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts)); // 1s,2s,4s... cap 30s
    }

    console.warn(`IMAP: scheduling reconnect in ${delay}ms (attempt ${reconnectAttempts})`);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(err => console.error('IMAP reconnect failed:', err && err.message || err));
    }, delay);
  }

  async function connect() {
    if (stopped) return;
    try {
      connection = await imaps.connect(imapConfig);
      reconnectAttempts = 0;
      console.log('IMAP connected');

      // prevent uncaught errors from killing the process
      connection.on('error', (err) => {
        console.error('IMAP connection error:', err && err.message || err);
        scheduleReconnect();
      });

      connection.on('close', () => {
        console.warn('IMAP connection closed by server');
        scheduleReconnect();
      });

      connection.on('end', () => {
        console.warn('IMAP connection ended by server');
        scheduleReconnect();
      });

      // try attach to underlying socket errors (defensive - may not exist in all versions)
      try {
        if (connection.imap && connection.imap._sock && connection.imap._sock.on) {
          connection.imap._sock.on('error', (err) => {
            console.error('IMAP socket error:', err && err.message || err);
            scheduleReconnect();
          });
        }
      } catch (e) {
        // ignore if internals are different
      }

      // open INBOX
      await connection.openBox('INBOX');

      // start polling loop
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(async () => {
        if (stopped) return clearPoll();
        // guard: ensure connection seems authenticated
        const imapState = (connection && connection.imap && connection.imap.state) || connection && connection.state;
        if (!connection || (imapState && imapState !== 'authenticated')) {
          // skip this tick; schedule reconnect if socket clearly closed
          return;
        }
        try {
          const searchCriteria = ['UNSEEN'];
          const fetchOptions = { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'], markSeen: true };
          const results = await connection.search(searchCriteria, fetchOptions);
          for (const res of results) {
            const header = res.parts && res.parts[0] && res.parts[0].body;
            const subjectRaw = (header && header.subject && header.subject[0]) || '';
            const fromRaw = (header && header.from && header.from[0]) || '';
            const m = fromRaw.match(/<([^>]+)>/);
            const fromEmail = m ? m[1] : fromRaw;
            // call callback but do not await it here to avoid blocking other mail processing
            try {
              await onMailCallback({ subject: subjectRaw, from: fromEmail, raw: header });
            } catch (cbErr) {
              console.error('onMailCallback error:', cbErr && cbErr.message || cbErr);
            }
          }
        } catch (e) {
          console.error('IMAP poll error:', e && e.message || e);
          // attempt reconnect if search failed (server might have closed socket)
          scheduleReconnect();
        }
      }, pollMs);

      // connected & polling; return
      return;
    } catch (e) {
      console.error('IMAP connect failed:', e && e.message || e);
      scheduleReconnect();
    }
  }

  // start initial connect attempt
  connect().catch(err => console.error('IMAP initial connect error:', err && err.message || err));

  // return stop function
  return async function stop() {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearPoll();
    await safeEndConnection();
  };
}


// --- scheduler helper ---
function startPeriodicTask(taskFn, seconds = DEFAULTS.CHECK_INTERVAL_SECONDS) {
  let stopped = false;
  (async function loop() {
    while (!stopped) {
      try {
        await taskFn();
      } catch (e) {
        console.error('Periodic task error', e.message || e);
      }
      await new Promise(r => setTimeout(r, seconds * 1000));
    }
  })();

  return () => { stopped = true; };
}

// --- exports ---
module.exports = {
  defaults: DEFAULTS,
  ensureBrowser,
  closeBrowser,
  getPage,
  releasePage,
  fetchPriceForTicker,
  parseTickersFromSubject,
  pctChange,
  checkTickersAndAlert,
  loadPrices,
  savePrices,
  ensureTransport,
  sendMail,
  startImapPolling,
  startPeriodicTask,
};
