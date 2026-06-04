// registry.js — Per-deposit unique codes

const fs = require('fs');
const path = require('path');

const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DEPOSITS_FILE = path.join(DATA_DIR, 'deposits.json');

// Structure:
// {
//   "DEP-X7K2": {
//     "code": "DEP-X7K2",
//     "discordId": "123456789",
//     "username": "JohnDoe",
//     "expectedAmount": 50,        // optional, set by admin
//     "status": "pending",         // pending | paid | expired
//     "createdAt": "...",
//     "paidAt": null,
//     "amount": null,              // filled when payment detected
//     "platform": null,
//     "senderName": null,
//   }
// }

function loadDeposits() {
  if (!fs.existsSync(DEPOSITS_FILE)) fs.writeFileSync(DEPOSITS_FILE, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(DEPOSITS_FILE, 'utf8'));
}
function saveDeposits(d) { fs.writeFileSync(DEPOSITS_FILE, JSON.stringify(d, null, 2)); }

function generateCode(existing) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = 'DEP-' + Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (existing[code]);
  return code;
}

// Create a new deposit code for a user
function createDepositCode(discordId, username, expectedAmount = null) {
  const deposits = loadDeposits();
  const code = generateCode(deposits);
  deposits[code] = {
    code,
    discordId,
    username,
    expectedAmount,
    status: 'pending',
    createdAt: new Date().toISOString(),
    paidAt: null,
    amount: null,
    platform: null,
    senderName: null,
  };
  saveDeposits(deposits);
  return deposits[code];
}

// Look up a deposit by code
function lookupCode(code) {
  const deposits = loadDeposits();
  return deposits[code.toUpperCase()] ?? null;
}

// Mark a deposit as paid
function markPaid(code, { amount, platform, senderName }) {
  const deposits = loadDeposits();
  if (!deposits[code]) return null;
  deposits[code].status = 'paid';
  deposits[code].paidAt = new Date().toISOString();
  deposits[code].amount = amount;
  deposits[code].platform = platform;
  deposits[code].senderName = senderName;
  saveDeposits(deposits);
  return deposits[code];
}

// Get all pending deposits for a user
function getPendingForUser(discordId) {
  const deposits = loadDeposits();
  return Object.values(deposits).filter(d => d.discordId === discordId && d.status === 'pending');
}

// Get all deposits for a user
function getAllForUser(discordId) {
  const deposits = loadDeposits();
  return Object.values(deposits)
    .filter(d => d.discordId === discordId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Get all pending deposits (admin)
function getAllPending() {
  const deposits = loadDeposits();
  return Object.values(deposits).filter(d => d.status === 'pending');
}

module.exports = { createDepositCode, lookupCode, markPaid, getPendingForUser, getAllForUser, getAllPending };
