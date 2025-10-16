// debug-fetch-2.js
require('dotenv').config();
const puppeteer = require('puppeteer');

(async () => {
  const ticker = 'INFM';
  const urlTemplate = process.env.PRICE_URL_TEMPLATE || 'https://www.belex.rs/eng/quote/{TICKER}';
  const url = urlTemplate.replace('{TICKER}', encodeURIComponent(ticker));
  console.log('Opening', url);

  const browser = await puppeteer.launch({ headless: "new", args:['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    const body = await page.evaluate(() => document.body.innerText || '');
    console.log('--- body snippet (first 4000 chars) ---');
    console.log(body.slice(0, 4000).replace(/\n/g, ' ¶ '));
    console.log('--- end body snippet ---\n');

    // Show regex matches near Price/Cena with some context
    const re = /(.{0,60}(?:Price|Cena).{0,60})/ig;
    let match;
    let i = 0;
    while ((match = re.exec(body)) !== null && i < 10) {
      i++;
      const chunk = match[1];
      // find numbers in chunk
      const numbers = [...chunk.matchAll(/([0-9]+[.,][0-9]{1,6})/g)].map(m=>m[1]);
      console.log(`Match#${i}: ...${chunk}...`);
      console.log('  Numbers in context:', numbers.length ? numbers.join(', ') : '(none)');
    }

    // Also print first 30 elements that contain digits (tag + short text + simple selector path)
    const candidates = await page.evaluate(() => {
      function pathFor(el) {
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== 'html' && parts.length < 6) {
          let part = cur.tagName.toLowerCase();
          if (cur.id) part += '#' + cur.id;
          else if (cur.className) part += '.' + cur.className.toString().trim().split(/\s+/).join('.');
          parts.unshift(part);
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      }
      const nodes = Array.from(document.querySelectorAll('body *')).filter(n => (n.textContent || '').match(/\d/));
      return nodes.slice(0,30).map(n => ({ tag: n.tagName.toLowerCase(), text: (n.textContent||'').trim().slice(0,140), path: pathFor(n) }));
    });
    console.log('\n--- Candidate elements containing digits (first 30) ---');
    candidates.forEach((c, idx) => console.log(`${idx+1}. <${c.tag}> ${c.path} -> "${c.text}"`));
    console.log('--- end candidates ---');

  } catch (e) {
    console.error('debug error', e);
  } finally {
    await browser.close();
  }
})();
