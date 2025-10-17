// pdfAlertTracker.js (ESM) - fixed imports for cheerio & nodemailer + robust fetch + pdf-parse
import dotenv from 'dotenv';
dotenv.config();

import { promises as fsp } from 'fs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { load as cheerioLoad } from 'cheerio'; // <-- use named import
// nodemailer is CommonJS; import it dynamically so both CJS and ESM work
const nodemailerModule = await import('nodemailer');
const nodemailer = nodemailerModule && (nodemailerModule.default || nodemailerModule);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Config (from env) ----------
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
const ALERTS_FILE = process.env.ALERTS_FILE || path.join(process.cwd(), 'alerts.json');
const SEEN_FILE = process.env.SEEN_FILE || path.join(process.cwd(), 'pdf_seen_tracker.json');
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(process.cwd(), 'pdfs');
const PRICE_URL_TEMPLATE = process.env.PRICE_URL_TEMPLATE || '';
const PRICE_SELECTOR = process.env.PRICE_SELECTOR || '';
const FROM_EMAIL = process.env.FROM_EMAIL || (process.env.SMTP_USER || 'no-reply@example.com');

const TRACK_TICKERS = (process.env.TRACK_TICKERS || '').split(',').map(t => t.trim()).filter(Boolean);
const COMPANY_PAGE_TEMPLATE = process.env.COMPANY_PAGE_TEMPLATE || 'https://www.belex.rs/trgovanje/vesti/hartija/{TICKER}';

// Fetch tuning
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '15000', 10);
const MAX_FETCH_RETRIES = parseInt(process.env.MAX_FETCH_RETRIES || '3', 10);
const HTTP_USER_AGENT = process.env.HTTP_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// Build news-list URLs from TRACK_TICKERS if provided, otherwise fallback
const NEWS_LIST_URLS = TRACK_TICKERS.length
  ? TRACK_TICKERS.map(t => COMPANY_PAGE_TEMPLATE.replace('{TICKER}', t))
  : [ (process.env.NEWS_LIST_URL || 'https://www.belex.rs/trgovanje/vesti/hartija/JESV') ];

// ---------- Helpers ----------
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function ensureDir(dir) {
  try { await fsp.mkdir(dir, { recursive: true }); } catch (e) { /* ignore */ }
}

async function readJSON(filePath, fallback = {}) {
  try {
    const txt = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    return fallback;
  }
}

async function writeJSON(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
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

// ---------- robust fetch (timeout + retries + backoff) ----------
async function fetchWithRetries(url, { timeoutMs = FETCH_TIMEOUT_MS, retries = MAX_FETCH_RETRIES, accept = '*/*' } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': HTTP_USER_AGENT, 'Accept': accept },
        signal: controller.signal,
        redirect: 'follow'
      });
      clearTimeout(id);
      if (!res.ok) {
        const err = new Error(`fetch ${url} failed ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res;
    } catch (err) {
      clearTimeout(id);
      lastErr = err;
      const msg = (err && (err.message || '')).toString();
      const code = err && err.code;
      const isTransient = (
        code === 'ECONNRESET' ||
        code === 'EPIPE' ||
        code === 'ETIMEDOUT' ||
        msg.includes('socket hang up') ||
        msg.includes('network timeout') ||
        msg.includes('aborted') ||
        msg.includes('fetch')
      );
      console.warn(`fetchWithRetries attempt ${attempt}/${retries} for ${url} failed:`, msg);
      if (!isTransient || attempt === retries) throw lastErr;
      const backoffBase = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      const jitter = Math.floor(Math.random() * 500);
      const wait = backoffBase + jitter;
      console.log(`Retrying ${url} after ${wait}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function fetchHTML(url) {
  const res = await fetchWithRetries(url, { timeoutMs: FETCH_TIMEOUT_MS, retries: MAX_FETCH_RETRIES, accept: 'text/html' });
  return await res.text();
}

async function downloadPDF(url) {
  const res = await fetchWithRetries(url, { timeoutMs: Math.max(20000, FETCH_TIMEOUT_MS), retries: MAX_FETCH_RETRIES, accept: 'application/pdf' });
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await ensureDir(DOWNLOAD_DIR);
  const filename = path.basename(new URL(url).pathname).split('?')[0] || `news-${Date.now()}.pdf`;
  const localPath = path.join(DOWNLOAD_DIR, `${Date.now()}-${filename}`);
  await fsp.writeFile(localPath, buffer);
  return { localPath, buffer };
}

async function extractTextFromPDFBuffer(buffer) {
  try {
    const pdfParseModule = await import('pdf-parse');
    const pdfParse = pdfParseModule && (pdfParseModule.default || pdfParseModule);
    const data = await pdfParse(buffer);
    return data && data.text ? data.text : null;
  } catch (e) {
    console.warn('pdf-parse failed', e && e.message);
    return null;
  }
}

async function fetchPriceForTicker(ticker) {
  if (!ticker || !PRICE_URL_TEMPLATE || !PRICE_SELECTOR) return null;
  try {
    const url = PRICE_URL_TEMPLATE.replace('{TICKER}', encodeURIComponent(ticker));
    const html = await fetchHTML(url);
    const $ = cheerioLoad(html);
    const el = $(PRICE_SELECTOR).first();
    return el && el.text() ? el.text().trim() : null;
  } catch (e) {
    console.warn('fetchPriceForTicker', e && e.message);
    return null;
  }
}

// ---------- email ----------
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
    return null;
  }
  if (!toAddresses || toAddresses.length === 0) throw new Error('No recipients');
  const mail = { from: FROM_EMAIL, to: toAddresses.join(','), subject, html: htmlBody, attachments };
  return await t.sendMail(mail);
}

// ---------- core processing ----------
async function loadAlerts() {
  const fromFile = await readJSON(ALERTS_FILE, null);
  if (fromFile && Object.keys(fromFile).length) return fromFile;
  if (process.env.DEFAULT_ALERTS) {
    try { return JSON.parse(process.env.DEFAULT_ALERTS); } catch (e) { console.warn('DEFAULT_ALERTS bad JSON'); }
  }
  return {};
}

async function processFirstItemIfToday(alerts, seenSet, url) {
  let html;
  try {
    html = await fetchHTML(url);
  } catch (e) {
    console.error('Error fetching', url, e && (e.message || e));
    return;
  }

  const $ = cheerioLoad(html);
  const dateTd = $('td.date').first();
  if (!dateTd || !dateTd.length) return;

  const tr = dateTd.closest('tr');
  const dateText = dateTd.text().trim();
  const parsedDate = parseDateFromTd(dateText);
  if (!parsedDate) return;

  const today = getTodayPartsInBelgrade();
  if (!(parsedDate.day === today.day && parsedDate.month === today.month && parsedDate.year === today.year)) {
    return; // not today's item
  }

  const linkEl = tr.find('a[href$=".pdf"]').first();
  if (!linkEl || !linkEl.length) return;

  const href = linkEl.attr('href');
  const pdfUrl = new URL(href, url).href;
  if (seenSet.has(pdfUrl)) return;

  const alertKeys = Object.keys(alerts || {});
  let ticker = tr.attr('data-ticker') || findTickerFromText(tr.text(), alertKeys);
  if (!ticker) ticker = findTickerFromText(path.basename(new URL(pdfUrl).pathname), alertKeys);

  try {
    const { localPath, buffer } = await downloadPDF(pdfUrl);
    const extracted = await extractTextFromPDFBuffer(buffer);
    const price = ticker ? await fetchPriceForTicker(ticker) : null;
    const recipients = ticker ? (alerts[ticker] || []) : [];

    if (!recipients || recipients.length === 0) {
      seenSet.add(pdfUrl);
      await writeJSON(SEEN_FILE, { seen: Array.from(seenSet) });
      console.log('No recipients for', ticker, '- marked as seen for', pdfUrl);
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
    console.error('Processing failed for', pdfUrl, e && (e.message || e));
  }
}

// ---------- orchestrator ----------
export async function startPdfTracker() {
  await ensureDir(DOWNLOAD_DIR);
  const alerts = await loadAlerts();
  const seen = await readJSON(SEEN_FILE, { seen: [] });
  const seenSet = new Set(seen.seen || []);

  async function checkAllTickersOnce() {
    for (const url of NEWS_LIST_URLS) {
      try {
        await processFirstItemIfToday(alerts, seenSet, url);
      } catch (e) {
        console.error('Error processing', url, e && (e.message || e));
      }
    }
  }

  // run immediately
  try {
    await checkAllTickersOnce();
  } catch (e) {
    console.error('Initial check failed', e && (e.message || e));
  }

  // schedule interval
  const timer = setInterval(checkAllTickersOnce, POLL_INTERVAL_MS);
  console.log('pdfAlertTracker running, polling every', POLL_INTERVAL_MS, 'ms');

  return { stop: () => clearInterval(timer) };
}

// run if executed directly
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  (async () => {
    try {
      await startPdfTracker();
    } catch (e) {
      console.error('startPdfTracker error', e && (e.message || e));
      process.exit(1);
    }
  })();
}

export default { startPdfTracker };
