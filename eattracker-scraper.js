// eattracker-scraper.js — Scrapes eat-tracker.com order pages using Puppeteer

const puppeteer = require('puppeteer');

async function scrapeEatTracker(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
    await page.setViewport({ width: 390, height: 844 });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    const data = await page.evaluate(() => {
      const text = document.body.innerText;

      if (text.includes('Tracker not available') || text.includes('not available')) {
        return { found: false };
      }

      // Restaurant
      let restaurant = null;
      const h1 = document.querySelector('h1, h2');
      if (h1) restaurant = h1.innerText.trim();
      const prepMatch = text.match(/([A-Z][A-Za-z'&\s]+?) is preparing/);
      if (prepMatch) restaurant = prepMatch[1].trim();

      // Status
      let status = 'Unknown';
      if (text.includes('Delivered')) status = 'Delivered';
      else if (text.includes('On the way')) status = 'On the way';
      else if (text.includes('Preparing') || text.includes('preparing')) status = 'Preparing';
      else if (text.includes('Placed')) status = 'Placed';

      // ETA
      let eta = null;
      const etaMatch = text.match(/(?:Estimated arrival|ETA|Arriving)[:\s]*\n?\s*([0-9:]+\s*[-–]?\s*[0-9:]*\s*[AP]?M?)/i);
      if (etaMatch && !etaMatch[1].includes('--')) eta = etaMatch[1].trim();

      // Driver
      let driver = null;
      const driverMatch = text.match(/([A-Z][a-z]+)\s*\n?\s*★?\s*([\d.]+)\s*[•·]?\s*([\d,]+)?\s*deliver/i);
      if (driverMatch) driver = { name: driverMatch[1], rating: driverMatch[2], deliveries: driverMatch[3] || null };

      // Customer
      const custMatch = text.match(/(?:For|Order for)\s+([A-Z][a-z]+(?: [A-Z][a-z]*)?)/);
      const customer = custMatch ? custMatch[1] : null;

      // Items
      const items = [];
      const itemMatches = text.matchAll(/(\d+)\s*[x×]\s*([A-Z][^\n$]{2,50})/gi);
      for (const m of itemMatches) {
        const qty = parseInt(m[1]);
        const name = m[2].trim();
        if (qty > 0 && qty < 30 && name.length > 2) items.push({ qty, name });
      }

      // Totals
      const subtotalMatch = text.match(/Subtotal\s*\$?([\d.]+)/);
      const totalMatch = text.match(/Total\s*\$?([\d.]+)/);
      const subtotal = subtotalMatch ? parseFloat(subtotalMatch[1]) : null;
      const total = totalMatch ? parseFloat(totalMatch[1]) : null;

      // Address
      let address = null;
      const addrMatch = text.match(/📍\s*\n?\s*([^\n]+)/);
      if (addrMatch) address = addrMatch[1].trim();

      return { found: true, restaurant, status, eta, driver, customer, items, subtotal, total, address };
    });

    console.log('EatTracker scraped:', JSON.stringify({ status: data.status, restaurant: data.restaurant, found: data.found }));
    return data.found ? data : null;
  } catch (err) {
    console.error('EatTracker scrape error:', err.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeEatTracker };
