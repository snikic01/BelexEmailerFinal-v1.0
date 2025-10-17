// fetchHelpers.js
// Robust fetch helpers for pdfAlertTracker.js
// - Provides fetchWithRetries, fetchHTML, downloadPDF
// - Uses node-fetch v2 and Node http/https keep-alive agents
// - Configurable via environment variables: FETCH_TIMEOUT_MS, MAX_FETCH_RETRIES, HTTP_USER_AGENT

const http = require('http');
const https = require('https');
const fetch = require('node-fetch');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 8 });

const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '15000', 10);
const MAX_FETCH_RETRIES = parseInt(process.env.MAX_FETCH_RETRIES || '3', 10);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchWithRetries(url, options = {}) {
  const maxRetries = options.retries != null ? options.retries : MAX_FETCH_RETRIES;
  const timeoutMs = options.timeoutMs != null ? options.timeoutMs : FETCH_TIMEOUT_MS;
  const headers = Object.assign({
    'User-Agent': process.env.HTTP_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'Accept': options.accept || '*/*'
  }, options.headers || {});

  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const parsed = new URL(url);
      const agent = parsed.protocol === 'https:' ? httpsAgent : httpAgent;
      const res = await fetch(url, {
        method: options.method || 'GET',
        headers,
        signal: controller.signal,
        redirect: 'follow',
        agent
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
        code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT' ||
        msg.includes('socket hang up') || msg.includes('network timeout') || msg.includes('aborted') || msg.includes('fetch')
      );
      console.warn(`fetchWithRetries attempt ${attempt}/${maxRetries} for ${url} failed:`, msg);
      if (!isTransient || attempt === maxRetries) throw lastErr;
      const backoffBase = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      const jitter = Math.floor(Math.random() * 500);
      const wait = backoffBase + jitter;
      console.log(`Retrying ${url} after ${wait}ms (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function fetchHTML(url) {
  const res = await fetchWithRetries(url, { timeoutMs: FETCH_TIMEOUT_MS, retries: MAX_FETCH_RETRIES, accept: 'text/html' });
  return await res.text();
}

async function downloadPDF(url, downloadDir) {
  const res = await fetchWithRetries(url, { timeoutMs: Math.max(20000, FETCH_TIMEOUT_MS), retries: MAX_FETCH_RETRIES, accept: 'application/pdf' });
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (downloadDir) {
    await fsp.mkdir(downloadDir, { recursive: true });
    const filename = path.basename(new URL(url).pathname).split('?')[0] || `news-${Date.now()}.pdf`;
    const localPath = path.join(downloadDir, `${Date.now()}-${filename}`);
    await fsp.writeFile(localPath, buffer);
    return { localPath, buffer };
  }
  return { localPath: null, buffer };
}

module.exports = { fetchWithRetries, fetchHTML, downloadPDF };
