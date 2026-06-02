// email-monitor.js — Multi-account Gmail watcher
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const SEEN_FILE = path.join(__dirname, 'seen_emails.json');

// Supports credentials passed as JSON string (from env var)
async function getGmailAuth(credentialsJson, label = 'default') {
  const credentials = typeof credentialsJson === 'string'
    ? JSON.parse(credentialsJson)
    : credentialsJson;

  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const tokenFile = path.join(__dirname, `gmail_token_${label.replace(/\s+/g, '_')}.json`);

  if (fs.existsSync(tokenFile)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(tokenFile, 'utf8')));
    return oAuth2Client;
  }

  // First-time auth
  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log(`\n🔑 [${label}] Open this URL to authorize Gmail:\n`);
  console.log(authUrl);
  console.log('\nPaste the code here:');

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`[${label}] Code: `, async (code) => {
      rl.close();
      const { tokens } = await oAuth2Client.getToken(code.trim());
      oAuth2Client.setCredentials(tokens);
      fs.writeFileSync(tokenFile, JSON.stringify(tokens));
      console.log(`✅ [${label}] Gmail authorized and token saved.`);
      resolve(oAuth2Client);
    });
  });
}

// ── Extract deposit code ──────────────────────────────────────────────────────
function extractDepositCode(text) {
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

function decodeEmailBody(payload) {
  let body = '';
  if (payload.body?.data) {
    body = Buffer.from(payload.body.data, 'base64').toString('utf8');
  } else if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data)
        body += Buffer.from(part.body.data, 'base64').toString('utf8');
      else if (part.mimeType === 'text/html' && part.body?.data)
        body += Buffer.from(part.body.data, 'base64').toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    }
  }
  return body;
}

function loadSeen() {
  if (!fs.existsSync(SEEN_FILE)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
}
function saveSeen(set) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...set].slice(-1000)));
}

async function checkEmails(auth, onPaymentFound) {
  const gmail = google.gmail({ version: 'v1', auth });
  const seen = loadSeen();

  const query = [
    'from:(paypal.com OR venmo.com OR cash.app OR square.com OR chime.com)',
    'OR (subject:("you received" OR "paid you" OR "sent you") Zelle)',
    'newer_than:1d is:unread',
  ].join(' ');

  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 20 });
  const messages = res.data.messages ?? [];

  for (const msg of messages) {
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
    const headers = full.data.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value ?? '';
    const fromHeader = headers.find(h => h.name === 'From')?.value ?? '';
    const fromEmail = (fromHeader.match(/<(.+)>/)?.[1] ?? fromHeader).toLowerCase();
    const body = decodeEmailBody(full.data.payload);
    const payment = parsePaymentEmail(subject, body, fromEmail);
    if (payment) await onPaymentFound(payment, subject);
  }

  saveSeen(seen);
}

module.exports = { getGmailAuth, checkEmails };
