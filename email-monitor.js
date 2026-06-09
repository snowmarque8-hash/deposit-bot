// email-monitor.js — Multi-account Gmail watcher using IMAP
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const fs = require('fs');

const DATA_DIR = fs.existsSync('/data') ? '/data' : '.';
const SEEN_FILE = DATA_DIR + '/seen_emails.json';
function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); }
  catch (e) { return new Set(); }
}
function saveSeen(set) {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...set].slice(-500))); }
  catch (e) {}
}

// ── Extract deposit code ──────────────────────────────────────────────────────
function extractDepositCode(text) {
  if (!text) return null;
  const match = text.match(/\bDEP-([A-Z0-9]{4})\b/i);
  return match ? `DEP-${match[1].toUpperCase()}` : null;
}

// ── Payment parsers ───────────────────────────────────────────────────────────
function parsePayPal(subject, body, fromEmail) {
  if (!fromEmail.includes('paypal.com')) return null;
  const amountMatch = body.match(/you(?:'ve)? received \$?([\d,]+\.?\d*)/i) || subject.match(/you received \$?([\d,]+\.?\d*)/i);
  const senderMatch = body.match(/from ([A-Z][a-z]+ [A-Z][a-z]+)/i) || subject.match(/from ([A-Z][a-z]+ [A-Z][a-z]+)/i);
  if (!amountMatch) return null;
  return { platform: 'PayPal', amount: parseFloat(amountMatch[1].replace(',', '')), senderName: senderMatch?.[1] ?? 'Unknown', memo: body };
}
function parseVenmo(subject, body, fromEmail) {
  if (!fromEmail.includes('venmo.com')) return null;
  const amountMatch = body.match(/paid you \$?([\d,]+\.?\d*)/i) || subject.match(/paid you \$?([\d,]+\.?\d*)/i);
  const senderMatch = body.match(/^([A-Z][a-z]+ [A-Z][a-z]+) paid you/im) || subject.match(/([A-Z][a-z]+ [A-Z][a-z]+) paid you/i);
  if (!amountMatch) return null;
  return { platform: 'Venmo', amount: parseFloat(amountMatch[1].replace(',', '')), senderName: senderMatch?.[1] ?? 'Unknown', memo: body };
}
function parseCashApp(subject, body, fromEmail) {
  if (!fromEmail.includes('cash.app') && !fromEmail.includes('square.com')) return null;
  const amountMatch = body.match(/you received \$?([\d,]+\.?\d*)/i) || subject.match(/received \$?([\d,]+\.?\d*)/i);
  const senderMatch = body.match(/from (\$[a-zA-Z0-9_]+)/i) || subject.match(/from (\$[a-zA-Z0-9_]+)/i);
  if (!amountMatch) return null;
  return { platform: 'Cash App', amount: parseFloat(amountMatch[1].replace(',', '')), senderName: senderMatch?.[1] ?? 'Unknown', memo: body };
}
function parseZelle(subject, body, fromEmail) {
  if (!body.includes('Zelle') && !subject.includes('Zelle')) return null;
  const amountMatch = body.match(/received \$?([\d,]+\.?\d*)(?: USD)?(?: with Zelle)?/i) || subject.match(/received \$?([\d,]+\.?\d*)/i);
  const senderMatch = body.match(/from ([A-Z][a-z]+ [A-Z][a-z]+)/i) || subject.match(/from ([A-Z][a-z]+ [A-Z][a-z]+)/i);
  if (!amountMatch) return null;
  return { platform: 'Zelle', amount: parseFloat(amountMatch[1].replace(',', '')), senderName: senderMatch?.[1] ?? 'Unknown', memo: body };
}
function parseChime(subject, body, fromEmail) {
  if (!fromEmail.includes('chime.com')) return null;
  const amountMatch = body.match(/received \$?([\d,]+\.?\d*)/i) || subject.match(/received \$?([\d,]+\.?\d*)/i);
  const senderMatch = body.match(/from ([A-Z][a-z]+ [A-Z][a-z]+)/i) || subject.match(/from ([A-Z][a-z]+ [A-Z][a-z]+)/i);
  if (!amountMatch) return null;
  return { platform: 'Chime', amount: parseFloat(amountMatch[1].replace(',', '')), senderName: senderMatch?.[1] ?? 'Unknown', memo: body };
}

const PARSERS = [parsePayPal, parseVenmo, parseCashApp, parseZelle, parseChime];

function parsePaymentEmail(subject, body, fromEmail) {
  for (const parser of PARSERS) {
    const result = parser(subject, body, fromEmail);
    if (result) {
      result.depositCode = extractDepositCode(result.memo || body) ?? extractDepositCode(subject);
      return result;
    }
  }
  return null;
}

// ── Check single IMAP account ─────────────────────────────────────────────────
async function checkSingleAccount(user, password, label, onPaymentFound) {
  return new Promise((resolve) => {
    const imap = new Imap({
      user,
      password,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000,
    });

    imap.once('error', (err) => {
      console.error(`IMAP error (${label}):`, err.message);
      resolve();
    });

    imap.once('end', () => resolve());

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err) => {
        if (err) { console.error(`openBox error (${label}):`, err.message); imap.end(); return; }

        // Look at emails from the last 2 hours (read OR unread) so opening on phone doesn't skip them
        const since = new Date();
        since.setHours(since.getHours() - 2);

        imap.search([['SINCE', since]], (err, results) => {
          if (err || !results?.length) { imap.end(); return; }

          // Only process the most recent 30 to avoid re-scanning everything
          const recent = results.slice(-30);
          console.log(`📧 [${label}] Scanning ${recent.length} recent email(s)`);

          const seen = loadSeen();
          const fetch = imap.fetch(recent, { bodies: '', markSeen: false });
          const promises = [];

          fetch.on('message', (msg) => {
            const p = new Promise((res) => {
              msg.on('body', (stream) => {
                simpleParser(stream, async (err, parsed) => {
                  if (err) { res(); return; }
                  const messageId = parsed.messageId || '';
                  // Skip if already processed
                  if (messageId && seen.has(messageId)) { res(); return; }

                  const subject = parsed.subject ?? '';
                  const fromEmail = (parsed.from?.value?.[0]?.address ?? '').toLowerCase();
                  const body = parsed.text ?? parsed.html?.replace(/<[^>]+>/g, ' ') ?? '';
                  console.log(`[${label}] Checking | From: ${fromEmail} | Subject: ${subject.slice(0, 60)}`);

                  const payment = parsePaymentEmail(subject, body, fromEmail);
                  if (payment) {
                    console.log(`[${label}] PAYMENT DETECTED: ${payment.platform} $${payment.amount} | Code: ${payment.depositCode ?? 'NONE'}`);
                    if (messageId) seen.add(messageId);
                    await onPaymentFound(payment, subject);
                  }
                  res();
                });
              });
            });
            promises.push(p);
          });

          fetch.once('end', async () => { await Promise.all(promises); saveSeen(seen); imap.end(); });
          fetch.once('error', (err) => { console.error(`Fetch error (${label}):`, err.message); imap.end(); });
        });
      });
    });

    imap.connect();
  });
}

// ── Check all accounts ────────────────────────────────────────────────────────
async function checkEmails(_, onPaymentFound) {
  const accounts = [
    { user: process.env.GMAIL_USER, password: process.env.GMAIL_PASSWORD, label: 'Account 1' },
    { user: process.env.GMAIL_USER_2, password: process.env.GMAIL_PASSWORD_2, label: 'Account 2' },
    { user: process.env.GMAIL_USER_3, password: process.env.GMAIL_PASSWORD_3, label: 'Account 3' },
  ].filter(a => a.user && a.password);

  if (!accounts.length) {
    console.error('❌ No Gmail accounts configured!');
    return;
  }

  for (const account of accounts) {
    await checkSingleAccount(account.user, account.password, account.label, onPaymentFound);
  }
}

async function getGmailAuth() { return null; }

module.exports = { getGmailAuth, checkEmails };
