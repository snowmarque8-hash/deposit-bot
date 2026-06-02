// doordash-scraper.js — Scrapes ddmap Railway links using Puppeteer

const puppeteer = require('puppeteer');

async function scrapeDoorDashLink(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();

    // Pretend to be a real mobile browser
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
    await page.setViewport({ width: 390, height: 844 });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for content to load
    await page.waitForSelector('body', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 3000)); // extra wait for JS to render

    // Scrape all text content
    const data = await page.evaluate(() => {
      const text = document.body.innerText;
      const html = document.body.innerHTML;

      // ── Restaurant name ──────────────────────────────────────────────────
      const restaurantEl = document.querySelector('h1, h2, [class*="restaurant"], [class*="store"]');
      const restaurant = restaurantEl?.innerText?.trim() ?? null;

      // ── Status ───────────────────────────────────────────────────────────
      let status = null;
      const statusKeywords = ['Dasher waiting', 'Picked up', 'Delivered', 'Preparing', 'Order placed', 'On the way', 'LIVE'];
      for (const kw of statusKeywords) {
        if (text.includes(kw)) { status = kw; break; }
      }

      // ── ETA ───────────────────────────────────────────────────────────────
      const etaMatch = text.match(/(\d{1,2}:\d{2}\s?[AP]M)\s*[-–]\s*(\d{1,2}:\d{2}\s?[AP]M)/i);
      const eta = etaMatch ? `${etaMatch[1]} - ${etaMatch[2]}` : null;

      // ── Driver info ───────────────────────────────────────────────────────
      const driverMatch = text.match(/([A-Z][a-z]+(?:\s[A-Z]\.?)?)\s*\n.*?(\d+\/\d+)\s*[•·]\s*([\d,]+)\s*deliver/i);
      let driver = null;
      if (driverMatch) {
        driver = {
          name: driverMatch[1].trim(),
          rating: driverMatch[2],
          deliveries: driverMatch[3],
        };
      } else {
        // fallback — try to find name near star rating
        const nameMatch = text.match(/([A-Z][a-z]+)\s*\n?\s*[⭐★✩]\s*(\d\/\d)/);
        if (nameMatch) driver = { name: nameMatch[1], rating: nameMatch[2], deliveries: null };
      }

      // ── Order for ─────────────────────────────────────────────────────────
      const orderForMatch = text.match(/Order for ([A-Z][a-z]+(?: [A-Z]\.?)?)/i);
      const orderFor = orderForMatch?.[1] ?? null;

      // ── Order items ───────────────────────────────────────────────────────
      const items = [];
      const itemMatches = text.matchAll(/(\d+)x\s+([^\n•]+)\n((?:\s*[•·]\s+[^\n]+\n?)*)/g);
      for (const match of itemMatches) {
        const qty = match[1];
        const name = match[2].trim();
        const customizations = match[3]
          .split('\n')
          .map(l => l.replace(/^[•·\s]+/, '').trim())
          .filter(Boolean);
        items.push({ qty, name, customizations });
      }

      return { restaurant, status, eta, driver, orderFor, items, rawText: text.slice(0, 2000) };
    });

    return data;
  } catch (err) {
    console.error('Scrape error:', err.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeDoorDashLink };
