// ddtrack-scraper.js — Scrapes ddtrack.live order pages using Puppeteer

const puppeteer = require('puppeteer');

async function scrapeDDTrack(url) {
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
    // Wait for the order data to load (JS-rendered)
    await new Promise(r => setTimeout(r, 5000));

    const data = await page.evaluate(() => {
      const text = document.body.innerText;

      // Restaurant
      let restaurant = null;
      const restaurantMatch = text.match(/Restaurant\s*\n\s*([^\n]+)/);
      if (restaurantMatch && restaurantMatch[1] && !restaurantMatch[1].includes('Restaurant')) {
        restaurant = restaurantMatch[1].trim();
      }

      // Status — check which stage is active
      let status = 'Unknown';
      if (text.includes('Order Cancelled') || text.includes('cancelled')) status = 'Cancelled';
      else if (text.includes('Delivered')) status = 'Delivered';
      else if (text.includes('On the way')) status = 'On the way';
      else if (text.includes('Preparing')) status = 'Preparing';
      else if (text.includes('Placed')) status = 'Placed';

      // Dasher
      let dasher = null;
      const dasherMatch = text.match(/Your Dasher\s*\n\s*([^\n]+)/);
      if (dasherMatch && dasherMatch[1] && !dasherMatch[1].includes('On the way')) {
        dasher = dasherMatch[1].trim();
      }

      // Delivering to
      let deliveringTo = null;
      const deliverMatch = text.match(/Delivering to\s*\n\s*([^\n]+)/);
      if (deliverMatch && deliverMatch[1] && deliverMatch[1].trim() !== '—') {
        deliveringTo = deliverMatch[1].trim();
      }

      // Order items — usually after "Your order"
      const items = [];
      const orderSection = text.split(/Your order/i)[1];
      if (orderSection) {
        const lines = orderSection.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          const m = line.match(/^(\d+)x?\s+(.+)/);
          if (m && parseInt(m[1]) < 20) {
            items.push({ qty: parseInt(m[1]), name: m[2].trim() });
          }
        }
      }

      const found = !text.includes('Order not found') && (restaurant || dasher || status !== 'Unknown');

      return { found, restaurant, status, dasher, deliveringTo, items, rawText: text.slice(0, 1500) };
    });

    console.log('DDTrack scraped:', JSON.stringify({ status: data.status, restaurant: data.restaurant, found: data.found }));
    return data.found ? data : null;
  } catch (err) {
    console.error('DDTrack scrape error:', err.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeDDTrack };
