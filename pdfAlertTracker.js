/*
  pdfAlertTracker.js

  Fixed, cleaned CommonJS version of your tracker.
  - Uses require() consistently (CommonJS) so you can run with `node pdfAlertTracker.js` without package.json:type module.
  - Removes duplicate/nested function definitions and illegal return statements.
  - Properly imports fs.promises, path, node-fetch, cheerio, pdf-parse and nodemailer.
  - Handles relative PDF URLs, keeps a seen-file, downloads PDF to DOWNLOAD_DIR and extracts text.
  - Optional price fetch (via PRICE_URL_TEMPLATE + PRICE_SELECTOR).
  - Sends mail via SMTP when configured; otherwise logs and skips sending.

  Usage: node pdfAlertTracker.js
  Make sure to install dependencies: npm i node-fetch@2 cheerio pdf-parse nodemailer dotenv
  (Or use built-in global fetch on Node >=18 if you prefer — this file uses node-fetch v2 require.)
*/

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const fetch = require('node-fetch'); // v2 require
const cheerio = require('cheerio');
const pdf = require('pdf-parse');
const nodemailer = require('nodemailer');
require('dotenv').config();

// --- Configuration ---
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

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
const ALERTS_FILE = process.env.ALERTS_FILE || path.join(process.cwd(), 'alerts.json');
const SEEN_FILE = process.env.SEEN_FILE || path.join(process.cwd(), 'pdf_seen_tracker.json');
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(process.cwd(), 'pdfs');
const PRICE_URL_TEMPLATE = process.env.PRICE_URL_TEMPLATE || '';
const PRICE_SELECTOR = process.env.PRICE_SELECTOR || '';
const FROM_EMAIL = process.env.FROM_EMAIL || (process.env.SMTP_USER || 'no-reply@example.com');

// optional list of tickers to restrict matching (comma-separated env var)
const TRACK_TICKERS = (process.env.TRACK_TICKERS || '').split(',').map(t => t.trim()).filter(Boolean);

// --- helper functions ---
async function ensureDir(dir) {
  try { await fsp.mkdir(dir, { recursive: true }); } catch (e) { /* ignore */ }
}

async function readJSON(filePath, fallback = {}) {
  try { const txt = await fsp.readFile(filePath, 'utf8'); return JSON.parse(txt); } catch (e) { return fallback; }
}

async function writeJSON(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

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
  const m = text && text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\.?/);
  if (!m) return null;
  return { day: parseInt(m[1], 10), month: parseInt(m[2], 10), year: parseInt(m[3], 10) };
}

function getTodayPartsInBelgrade() {
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
  try { const data = await pdf(buffer); return data && data.text ? data.text : null; } catch (e) { console.warn('pdf-parse failed', e && e.message); return null; }
}

async function fetchPriceForTicker(ticker) {
  if (!ticker || !PRICE_URL_TEMPLATE || !PRICE_SELECTOR) return null;
  try {
    const url = PRICE_URL_TEMPLATE.replace('{TICKER}', encodeURIComponent(ticker));
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);
    const el = $(PRICE_SELECTOR).first();
    return el && el.text() ? el.text().trim() : null;
  } catch (e) { console.warn('fetchPriceForTicker', e && e.message); return null; }
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

// nodemailer transporter (created only if SMTP info provided)
let transporter = null;
function createTransporterIfConfigured() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST && !process.env.SMTP_USER) {
    console.warn('SMTP not configured (SMTP_HOST or SMTP_USER missing). Emails will not be sent.');
    return null;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true' || false,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

async function sendEmail(toAddresses, subject, htmlBody, attachments = []) {
  const t = createTransporterIfConfigured();
  if (!t) {
    console.log('Would send email to:', toAddresses, 'subject:', subject);
    return null; // If you prefer to fail hard, throw here
  }
  if (!toAddresses || toAddresses.length === 0) throw new Error('No recipients');
  const mail = { from: FROM_EMAIL, to: toAddresses.join(','), subject, html: htmlBody, attachments };
  return await t.sendMail(mail);
}

// --- main processing for a single news list page ---
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
    // not today's item
    return;
  }

  const linkEl = tr.find('a[href$=".pdf"]').first();
  if (!linkEl || !linkEl.length) return;

  const href = linkEl.attr('href');
  const pdfUrl = new URL(href, url).href;
  if (seenSet.has(pdfUrl)) return; // already processed

  // try to detect ticker
  const alertKeys = Object.keys(alerts || {});
  let ticker = tr.attr('data-ticker') || findTickerFromText(tr.text(), alertKeys);
  if (!ticker) ticker = findTickerFromText(path.basename(new URL(pdfUrl).pathname), alertKeys);

  try {
    const { localPath, buffer } = await downloadPDF(pdfUrl);
    const extracted = await extractTextFromPDFBuffer(buffer);
    const price = ticker ? await fetchPriceForTicker(ticker) : null;
    const recipients = ticker ? (alerts[ticker] || []) : [];

    if (!recipients || recipients.length === 0) {
      // mark seen but do not send
      seenSet.add(pdfUrl);
      await writeJSON(SEEN_FILE, { seen: Array.from(seenSet) });
      console.log('No recipients for ticker', ticker, '— marked as seen.');
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
    console.log('Alert sent for', pdfUrl, 'ticker', ticker);
  } catch (e) {
    console.error('Processing failed for', pdfUrl, e && e.message);
  }
}

// --- orchestrator ---
async function startPdfTracker() {
  await ensureDir(DOWNLOAD_DIR);
  const alerts = await loadAlerts();
  const seen = await readJSON(SEEN_FILE, { seen: [] });
  const seenSet = new Set(seen.seen || []);

  async function checkAllTickersOnce() {
    for (const url of NEWS_LIST_URLS) {
      try {
        await processFirstItemIfToday(alerts, seenSet, url);
      } catch (e) {
        console.error('Error processing', url, e && e.message);
      }
    }
  }

  // run immediately
  try {
    await checkAllTickersOnce();
  } catch (e) {
    console.error('Initial check failed', e && e.message);
  }

  // schedule interval
  const timer = setInterval(checkAllTickersOnce, POLL_INTERVAL_MS);
  console.log('pdfAlertTracker running, polling every', POLL_INTERVAL_MS, 'ms');

  return { stop: () => clearInterval(timer) };
}

// entry
if (require.main === module) {
  (async () => {
    try {
      await startPdfTracker();
    } catch (e) {
      console.error('startPdfTracker error', e && e.message);
      process.exit(1);
    }
  })();
}

module.exports = { startPdfTracker };
