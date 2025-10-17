/*
pdfAlertTracker.js

Watcher that polls a news list page and, when the first listed news item has today's date (Europe/Belgrade),
downloads its PDF, extracts text, fetches current price for the detected ticker and sends alert emails (with PDF attached)
for companies configured in alerts.json. Designed as a standalone module so it doesn't modify existing project files.

Behavior specific to the example row you sent (<td class="date">26.09.2025.</td> ... <td class="link"><a href="/data/2025/09/00143497.pdf">):
- It finds the first occurrence of a <td class="date"> and uses its parent <tr> as the "first item".
- It reads the date text and compares day/month/year with today's date in Europe/Belgrade timezone.
- If they match and the row contains a PDF link (an <a href="...pdf">), it processes the PDF exactly like pdfAlertSender:
  - download pdf
  - extract text (pdf-parse)
  - try to identify ticker from the row text or PDF filename using configured alerts mapping
  - fetch current price using PRICE_URL_TEMPLATE + PRICE_SELECTOR (optional)
  - send HTML email to addresses from alerts mapping for that ticker, with PDF attached

Configuration (env variables / .env):
- NEWS_LIST_URL             - required: URL of the news page (HTML)
- POLL_INTERVAL_MS          - optional: polling interval in ms (default 60000)
- ALERTS_FILE               - optional path to alerts.json (default ./alerts.json)
- SEEN_FILE                 - optional path to seen state (default ./pdf_seen_tracker.json)
- DOWNLOAD_DIR              - where to save PDFs (default ./pdfs)
- PRICE_URL_TEMPLATE        - template with {TICKER} placeholder to fetch price page (optional)
- PRICE_SELECTOR            - CSS selector to extract price on price page (optional)
- SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_EMAIL - for sending emails

Install: npm i node-fetch@2 cheerio pdf-parse nodemailer dotenv

Usage:
- node pdfAlertTracker.js
- or require and call startPdfTracker() from your server start code

*/

import 'dotenv/config';
import fetch from 'node-fetch';
import cheerio from 'cheerio';
import 'dotenv/config';



// tickers koje pratiš
const NEWS_LIST_URLS = [
  'https://www.belex.rs/trgovanje/vesti/hartija/JESV',
  'https://www.belex.rs/trgovanje/vesti/hartija/NIIS',
  'https://www.belex.rs/trgovanje/vesti/hartija/IMPL',
  'https://www.belex.rs/trgovanje/vesti/hartija/MTLC',
  'https://www.belex.rs/trgovanje/vesti/hartija/DNOS',
  'https://www.belex.rs/trgovanje/vesti/hartija/DINN',
  'https://www.belex.rs/trgovanje/vesti/hartija/DINNPB',
  'https://www.belex.rs/trgovanje/vesti/hartija/AERO',
  'https://www.belex.rs/trgovanje/vesti/hartija/TGAS',
  'https://www.belex.rs/trgovanje/vesti/hartija/FINT',
  'https://www.belex.rs/trgovanje/vesti/hartija/INFM',
  'https://www.belex.rs/trgovanje/vesti/hartija/ENHL',
  'https://www.belex.rs/trgovanje/vesti/hartija/ZTPK',
  'https://www.belex.rs/trgovanje/vesti/hartija/DNREM',
  'https://www.belex.rs/trgovanje/vesti/hartija/GFOM',
  'https://www.belex.rs/trgovanje/vesti/hartija/COKA'
];

async function checkAllTickers() {
  for (const url of NEWS_LIST_URLS) {
    try {
      console.log('Fetching', url);
      const res = await fetch(url);
      const text = await res.text();
      const $ = cheerio.load(text);
      const firstRow = $('table tr').first().text().trim();
      console.log(url, 'first row:', firstRow);
    } catch (e) {
      console.error('Error fetching', url, e);
    }
  }
}


// entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  startPdfTracker().catch(e => console.error('startPdfTracker error', e));
}

//port fs from 'fs/promises';
//nst path = require('path');
//nst pdf = require('pdf-parse');
//nst nodemailer = require('nodemailer');

// učitaj .env
require('dotenv').config({ path: path.join(__dirname, '.env') });

// debug
console.log('DEBUG | __dirname =', __dirname);
console.log('DEBUG | NEWS_LIST_URL =', process.env.NEWS_LIST_URL);

// Config
//const NEWS_LIST_URL = process.env.NEWS_LIST_URL || '';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
const ALERTS_FILE = process.env.ALERTS_FILE || path.join(process.cwd(), 'alerts.json');
const SEEN_FILE = process.env.SEEN_FILE || path.join(process.cwd(), 'pdf_seen_tracker.json');
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(process.cwd(), 'pdfs');
const PRICE_URL_TEMPLATE = process.env.PRICE_URL_TEMPLATE || '';
const PRICE_SELECTOR = process.env.PRICE_SELECTOR || null;
const FROM_EMAIL = process.env.FROM_EMAIL || (process.env.SMTP_USER || 'no-reply@example.com');

const TRACK_TICKERS = (process.env.TRACK_TICKERS || '').split(',').map(t => t.trim()).filter(Boolean);
const COMPANY_PAGE_TEMPLATE = process.env.COMPANY_PAGE_TEMPLATE;
console.log('DEBUG | NEWS_LIST_URLS =', NEWS_LIST_URLS);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.example.com',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true' || false,
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
});

async function ensureDir(dir) {
  try { await fsp.mkdir(dir, { recursive: true }); } catch (e) {}
}

async function readJSON(filePath, fallback = {}) {
  try { const txt = await fsp.readFile(filePath, 'utf8'); return JSON.parse(txt); } catch (e) { return fallback; }
}
async function writeJSON(filePath, data) { await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8'); }

async function loadAlerts() {
  const fromFile = await readJSON(ALERTS_FILE, null);
  if (fromFile && Object.keys(fromFile).length) return fromFile;
  if (process.env.DEFAULT_ALERTS) {
    try { return JSON.parse(process.env.DEFAULT_ALERTS); } catch (e) { console.warn('DEFAULT_ALERTS bad JSON'); }
  }
  return {};
}

async function fetchHTML(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch ${url} failed ${res.status}`);
  return await res.text();
}

function parseDateFromTd(text) {
  // matches formats like 26.09.2025.  OR 6.9.2025
  const m = text && text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\.?/);
  if (!m) return null;
  return { day: parseInt(m[1], 10), month: parseInt(m[2], 10), year: parseInt(m[3], 10) };
}

function getTodayPartsInBelgrade() {
  // use Intl to get correct date in Europe/Belgrade timezone
  const dt = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Belgrade', day: '2-digit', month: '2-digit', year: 'numeric' });
  const parts = fmt.formatToParts(dt);
  const day = parseInt(parts.find(p => p.type === 'day').value, 10);
  const month = parseInt(parts.find(p => p.type === 'month').value, 10);
  const year = parseInt(parts.find(p => p.type === 'year').value, 10);
  return { day, month, year };
}

async function downloadPDF(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('download failed ' + res.status);
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await ensureDir(DOWNLOAD_DIR);
  const filename = path.basename(new URL(url).pathname).split('?')[0] || `news-${Date.now()}.pdf`;
  const localPath = path.join(DOWNLOAD_DIR, `${Date.now()}-${filename}`);
  await fsp.writeFile(localPath, buffer);
  return { localPath, buffer };
}

async function extractTextFromPDFBuffer(buffer) {
  try { const data = await pdf(buffer); return data && data.text ? data.text : null; } catch (e) { console.warn('pdf-parse failed', e.message); return null; }
}

async function fetchPriceForTicker(ticker) {
  if (!ticker || !PRICE_URL_TEMPLATE || !PRICE_SELECTOR) return null;
  try {
    const url = PRICE_URL_TEMPLATE.replace('{TICKER}', encodeURIComponent(ticker));
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);
    const el = $(PRICE_SELECTOR).first();
    return el && el.text() ? el.text().trim() : null;
  } catch (e) { console.warn('fetchPriceForTicker', e.message); return null; }
}

async function sendEmail(toAddresses, subject, htmlBody, attachments = []) {
  if (!toAddresses || toAddresses.length === 0) throw new Error('No recipients');
  const mail = { from: FROM_EMAIL, to: toAddresses.join(','), subject, html: htmlBody, attachments };
  return await transporter.sendMail(mail);
}

function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return unsafe.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function findTickerFromText(text, tickers) {
  if (!text || !tickers || !tickers.length) return null;
  const upper = text.toUpperCase();
  for (const t of tickers) {
    if (!t) continue;
    const re = new RegExp(`\\b${t.toUpperCase()}\\b`);
    if (re.test(upper)) return t;
  }
  return null;
}

async function processFirstItemIfToday(alerts, seenSet, url) {
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  const dateTd = $('td.date').first();
  if (!dateTd || !dateTd.length) return;

  const tr = dateTd.closest('tr');
  const dateText = dateTd.text().trim();
  const parsedDate = parseDateFromTd(dateText);
  if (!parsedDate) return;

  const today = getTodayPartsInBelgrade();
  if (!(parsedDate.day === today.day && parsedDate.month === today.month && parsedDate.year === today.year)) {
    return; // nije današnja vest
  }

  const linkEl = tr.find('td.link a[href$=".pdf"]').first();
  if (!linkEl || !linkEl.length) return;

  const href = linkEl.attr('href');
  const pdfUrl = new URL(href, url).href;
  if (seenSet.has(pdfUrl)) return;

  let ticker = tr.attr('data-ticker') || findTickerFromText(tr.text(), Object.keys(alerts));
  if (!ticker) ticker = findTickerFromText(path.basename(new URL(pdfUrl).pathname), Object.keys(alerts));

  // preuzmi PDF, izveštaj i pošalji mail
  try {
    const { localPath, buffer } = await downloadPDF(pdfUrl);
    const extracted = await extractTextFromPDFBuffer(buffer);
    const price = ticker ? await fetchPriceForTicker(ticker) : null;
    const recipients = ticker ? alerts[ticker] || [] : [];

    if (!recipients.length) {
      seenSet.add(pdfUrl);
      await writeJSON(SEEN_FILE, { seen: Array.from(seenSet) });
      return;
    }

    const subject = `VEST: ${ticker ? ticker + ' - ' : ''}${escapeHtml(linkEl.attr('title') || linkEl.text() || localPath)}`;
    let htmlBody = `<h3>${escapeHtml(tr.find('td.tekst').text().trim() || subject)}</h3>`;
    if (price) htmlBody += `<p><strong>Trenutna cena za ${ticker}:</strong> ${escapeHtml(price)}</p>`;
    if (extracted) htmlBody += `<pre style="white-space:pre-wrap">${escapeHtml(extracted).slice(0, 10000)}</pre>`;
    htmlBody += `<p>U prilogu je originalni PDF.</p>`;

    const attachments = [{ filename: path.basename(localPath), content: buffer, contentType: 'application/pdf' }];
    await sendEmail(recipients, subject, htmlBody, attachments);

    seenSet.add(pdfUrl);
    await writeJSON(SEEN_FILE, { seen: Array.from(seenSet) });
  } catch (e) {
    console.error('Processing failed for', pdfUrl, e && e.message);
  }
}


async function startPdfTracker() {
  const alerts = await loadAlerts();
  const seen = await readJSON(SEEN_FILE, { seen: [] });
  const seenSet = new Set(seen.seen || []);


  // ✅ Definiši checkAllTickers ovde
  async function checkAllTickers() {
    for (const url of NEWS_LIST_URLS) {
      try {
        await processFirstItemIfToday(alerts, seenSet, url);
      } catch (e) {
        console.error('Error processing', url, e.message);
      }
    }
  }

  // Pokreni odmah
  await checkAllTickers();

  // Interval
  function startPdfTracker() {
  const timer = setInterval(someFunction, 1000);
  return { stop: () => clearInterval(timer) }; // ✅ ovde je legalno
}

// poziv
const tracker = startPdfTracker();


  console.log('pdfAlertTracker running');
  return { stop: () => clearInterval(timer) };
}

// Entry point
if (require.main === module) {
  (async () => {
    try {
      await startPdfTracker();
    } catch (e) {
      console.error('startPdfTracker error', e.message);
      process.exit(1);
    }
  })();
}

  // pokreni odmah
  (async () => {
  try {
    await checkAllTickers();
  } catch (e) {
    console.error('Initial check failed', e);
  }
})();

  // postavi interval
  const timer = setInterval(checkAllTickers, parseInt(process.env.POLL_INTERVAL_MS || '60000', 10));

  console.log('pdfAlertTracker running for all tickers');

  return { stop: () => clearInterval(timer) };

module.exports = { startPdfTracker };
