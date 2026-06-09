// doomdash-scraper.js — Scrapes doomdash.online tracking pages
// This site renders content server-side so we can use plain fetch (no Puppeteer needed)

async function scrapeDoomDash(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Strip tags to get text
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                     .replace(/<style[\s\S]*?<\/style>/gi, '')
                     .replace(/<[^>]+>/g, '\n')
                     .replace(/&amp;/g, '&')
                     .replace(/&times;/g, 'x')
                     .replace(/&#215;/g, 'x')
                     .replace(/\n\s*\n/g, '\n')
                     .trim();

    // Restaurant — appears in title or heading
    let restaurant = null;
    const titleMatch = html.match(/<title>Tracking ([^<—]+)/i);
    if (titleMatch) restaurant = titleMatch[1].trim();
    // Also try "X is preparing your order"
    const prepMatch = text.match(/([A-Z][A-Za-z'&\s]+?) is preparing your order/);
    if (prepMatch) restaurant = prepMatch[1].trim();

    // Status
    let status = 'Unknown';
    if (text.includes('Delivered')) status = 'Delivered';
    else if (text.includes('On the way')) status = 'On the way';
    else if (text.includes('Preparing') || text.includes('preparing')) status = 'Preparing';
    else if (text.includes('Placed')) status = 'Placed';

    // ETA
    let eta = null;
    const etaMatch = text.match(/Estimated arrival\s*\n\s*([^\n]+)/);
    if (etaMatch && etaMatch[1].trim() !== '--:--') eta = etaMatch[1].trim();

    // Customer + Order number
    const orderMatch = text.match(/For ([A-Za-z\s]+?)\s*[·]\s*Order #([a-f0-9]+)/i);
    const customer = orderMatch ? orderMatch[1].trim() : null;
    const orderNum = orderMatch ? orderMatch[2].trim() : null;

    // Items
    const items = [];
    const itemMatches = text.matchAll(/(\d+)\s*x\s*([A-Z][^\n$]{2,50})/gi);
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
    const addrMatch = text.match(/📍\s*\n?\s*([^\n]+(?:\n[^\n]+)?)/);
    if (addrMatch) address = addrMatch[1].replace(/\n/g, ', ').trim();

    // Dasher rating
    const dasherMatch = text.match(/★\s*([\d.]+)\s*([\d,]+) deliveries/);
    const dasher = dasherMatch ? { rating: dasherMatch[1], deliveries: dasherMatch[2] } : null;

    const found = restaurant || items.length > 0 || total;
    return found ? { restaurant, status, eta, customer, orderNum, items, subtotal, total, address, dasher } : null;
  } catch (err) {
    console.error('DoomDash scrape error:', err.message);
    return null;
  }
}

module.exports = { scrapeDoomDash };
