// doordash-cart-scraper.js — Full login with auto email verification code

const puppeteer = require('puppeteer');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

let savedSession = null;

// Wait for DoorDash verification code from Gmail
async function getVerificationCode(timeoutMs) {
  timeoutMs = timeoutMs || 30000;
  const start = Date.now();
  console.log('Waiting for DoorDash verification code in email...');

  return new Promise((resolve) => {
    const imap = new Imap({
      user: process.env.GMAIL_USER,
      password: process.env.GMAIL_PASSWORD,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });

    imap.once('error', (e) => { console.error('IMAP error:', e.message); resolve(null); });
    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err) => {
        if (err) { imap.end(); resolve(null); return; }

        // Poll for new email every 3 seconds
        const poll = setInterval(() => {
          if (Date.now() - start > timeoutMs) {
            clearInterval(poll);
            imap.end();
            resolve(null);
            return;
          }

          const since = new Date(Date.now() - 60000); // last 60 seconds
          imap.search([['FROM', 'doordash'], ['SINCE', since]], (err, results) => {
            if (err || !results || !results.length) return;

            const fetch = imap.fetch(results, { bodies: '' });
            fetch.on('message', (msg) => {
              msg.on('body', (stream) => {
                simpleParser(stream, (err, parsed) => {
                  if (err) return;
                  const text = parsed.text || parsed.html || '';
                  const subject = parsed.subject || '';

                  // Look for 6-digit verification code
                  if (subject.toLowerCase().includes('verify') ||
                      subject.toLowerCase().includes('code') ||
                      subject.toLowerCase().includes('confirm') ||
                      text.includes('verification code') ||
                      text.includes('verify your')) {
                    const codeMatch = text.match(/\b(\d{6})\b/);
                    if (codeMatch) {
                      console.log('Found verification code: ' + codeMatch[1]);
                      clearInterval(poll);
                      imap.end();
                      resolve(codeMatch[1]);
                    }
                  }
                });
              });
            });
          });
        }, 3000);
      });
    });

    imap.connect();
  });
}

async function loginToDoorDash(page) {
  try {
    console.log('Logging into DoorDash...');
    await page.goto('https://www.doordash.com/consumer/login/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // Enter email
    const emailInput = await page.$('input[type="email"], input[name="email"], input[placeholder*="email" i]');
    if (!emailInput) throw new Error('Email input not found');
    await emailInput.type(process.env.DOORDASH_EMAIL, { delay: 50 });
    await new Promise(r => setTimeout(r, 500));

    // Click continue
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 2000));

    // Check if password field appears
    const passwordInput = await page.$('input[type="password"]');
    if (passwordInput) {
      await passwordInput.type(process.env.DOORDASH_PASSWORD, { delay: 50 });
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 3000));
    }

    // Check if verification code is needed
    const pageText = await page.evaluate(() => document.body.innerText);
    const needsCode = pageText.toLowerCase().includes('verification') ||
                      pageText.toLowerCase().includes('enter the code') ||
                      pageText.toLowerCase().includes('check your email') ||
                      pageText.toLowerCase().includes('sent you a code');

    if (needsCode) {
      console.log('Verification code required — checking email...');
      const code = await getVerificationCode(45000);

      if (code) {
        // Find code input and type it
        const codeInput = await page.$('input[type="number"], input[type="text"][maxlength="6"], input[autocomplete="one-time-code"]');
        if (codeInput) {
          await codeInput.type(code, { delay: 100 });
          await page.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 3000));
          console.log('Verification code entered!');
        } else {
          // Try clicking each digit box
          const inputs = await page.$$('input[type="number"], input[maxlength="1"]');
          if (inputs.length >= 6) {
            for (let i = 0; i < 6; i++) {
              await inputs[i].type(code[i], { delay: 100 });
            }
            await page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 3000));
          }
        }
      } else {
        console.log('No verification code found in email within timeout');
        return false;
      }
    }

    // Save session cookies
    savedSession = await page.cookies();
    console.log('DoorDash login successful!');
    return true;
  } catch (e) {
    console.error('Login failed:', e.message);
    return false;
  }
}

async function scrapeCartLink(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
    await page.setViewport({ width: 390, height: 844 });

    // Restore saved session or log in fresh
    if (savedSession && savedSession.length > 0) {
      await page.setCookie(...savedSession);
    } else {
      await loginToDoorDash(page);
    }

    console.log('Opening cart: ' + url);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    // If still on login/guest page, log in again
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('consumer/guest')) {
      console.log('Session expired — logging in again...');
      savedSession = null;
      await loginToDoorDash(page);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 4000));
    }

    const data = await page.evaluate(() => {
      const text = document.body.innerText;

      // Creator
      const creatorMatch = text.match(/([A-Za-z]+(?: [A-Z]\.?)?)'s (?:Group Order|Cart)/i);
      const creator = creatorMatch ? creatorMatch[1] : null;

      // Item count
      const itemCountMatch = text.match(/(\d+) items? in cart/i);
      const itemCount = itemCountMatch ? parseInt(itemCountMatch[1]) : 0;

      // Restaurant
      let restaurant = null;
      const h1 = document.querySelector('h1');
      if (h1) restaurant = h1.innerText.trim();
      if (!restaurant) {
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines.slice(0, 20)) {
          if (line.length > 2 && line.length < 60 &&
              !line.match(/Group Order|Sign|DoorDash|Login|Cart|item|Continue|Enter|Required/i) &&
              /^[A-Z]/.test(line)) {
            restaurant = line;
            break;
          }
        }
      }

      // Items
      const items = [];
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const qtyMatch = lines[i].match(/^(\d+)x?\s+(.+)/);
        if (qtyMatch) {
          const qty = parseInt(qtyMatch[1]);
          const name = qtyMatch[2].trim();
          let price = null;
          if (lines[i + 1] && lines[i + 1].match(/^\$?([\d.]+)$/)) {
            price = parseFloat(lines[i + 1].replace('$', ''));
          }
          if (qty > 0 && qty < 20 && name.length > 1 && name.length < 80) {
            items.push({ qty, name, price });
          }
        }
      }

      // Subtotal
      const subtotalMatch = text.match(/[Ss]ubtotal\s*\$?([\d.]+)/);
      const subtotal = subtotalMatch ? parseFloat(subtotalMatch[1]) : null;

      return { creator, itemCount, restaurant, items, subtotal, rawText: text.slice(0, 1500) };
    });

    console.log('Scraped:', JSON.stringify({ restaurant: data.restaurant, itemCount: data.itemCount, items: data.items.length, subtotal: data.subtotal }));
    console.log('Raw:', data.rawText);
    return { success: true, data };
  } catch (err) {
    console.error('Scrape error:', err.message);
    return { success: false, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeCartLink };
