// doordash-cart-scraper.js — Scrapes DoorDash shared cart links using Puppeteer

const puppeteer = require('puppeteer');

async function scrapeCartLink(url) {
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

    // Set cookies from env token so DoorDash thinks we're logged in
    const token = process.env.DOORDASH_TOKEN;
    if (token) {
      await page.setCookie({
        name: 'ddweb_token',
        value: token,
        domain: '.doordash.com',
      });
    }

    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
    await page.setViewport({ width: 390, height: 844 });

    console.log('Puppeteer opening cart: ' + url);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    const data = await page.evaluate(() => {
      const text = document.body.innerText;

      // Restaurant name
      let restaurant = null;
      const h1 = document.querySelector('h1');
      if (h1) restaurant = h1.innerText.trim();
      if (!restaurant) {
        const match = text.match(/^([^\n]+)\n/);
        if (match) restaurant = match[1].trim();
      }

      // Items - look for quantity + name patterns
      const items = [];
      const itemMatches = text.matchAll(/(\d+)\s*x?\s*([A-Z][^\n$]{2,40})\s*\$?([\d.]+)?/gm);
      for (const m of itemMatches) {
        const qty = parseInt(m[1]);
        const name = m[2].trim();
        const price = m[3] ? parseFloat(m[3]) : null;
        if (qty > 0 && qty < 20 && name.length > 2) {
          items.push({ qty, name, price });
        }
      }

      // Price patterns
      const subtotalMatch = text.match(/[Ss]ubtotal[:\s]*\$?([\d.]+)/);
      const subtotal = subtotalMatch ? parseFloat(subtotalMatch[1]) : null;

      // Creator
      const creatorMatch = text.match(/(?:Created by|Cart by|Order by)[:\s]+([A-Z][a-z]+ ?[A-Z]?[a-z]*)/i);
      const creator = creatorMatch ? creatorMatch[1] : null;

      // Status
      let status = 'Open';
      if (text.includes('checkout') || text.includes('Checkout')) status = 'Ready to checkout';
      if (text.includes('closed') || text.includes('Closed')) status = 'Closed';

      return { restaurant, items, subtotal, creator, status, rawText: text.slice(0, 3000) };
    });

    return { success: true, data };
  } catch (err) {
    console.error('Cart scrape error:', err.message);
    return { success: false, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeCartLink };
