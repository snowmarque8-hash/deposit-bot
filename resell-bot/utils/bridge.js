const fs = require('fs');
const path = require('path');
const config = require('../config.json');

// Path to deposit bot's folder (where deposits.json, balances.json live)
const DEPOSIT_PATH = config.depositBotDataPath
  ? path.resolve(__dirname, '..', config.depositBotDataPath)
  : null;

function depositFile(name) {
  if (!DEPOSIT_PATH) return null;
  return path.join(DEPOSIT_PATH, name);
}

function readDepositFile(name) {
  const fp = depositFile(name);
  if (!fp || !fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function writeDepositFile(name, data) {
  const fp = depositFile(name);
  if (!fp) return false;
  try { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); return true; } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Get a user's current balance from the deposit bot
// balances.json structure: { "discord_USERID": 50.00, ... }
// ─────────────────────────────────────────────────────────────────────────────
function getDepositBalance(userId) {
  const balances = readDepositFile('balances.json');
  if (!balances) return null;
  return balances[`discord_${userId}`] ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deduct from the deposit bot's balance (e.g. when an order is placed)
// ─────────────────────────────────────────────────────────────────────────────
function deductDepositBalance(userId, amount) {
  const balances = readDepositFile('balances.json');
  if (!balances) return false;
  const key = `discord_${userId}`;
  const current = balances[key] ?? 0;
  if (current < amount) return false; // insufficient funds
  balances[key] = parseFloat((current - amount).toFixed(2));
  writeDepositFile('balances.json', balances);

  // Also log it to transactions.json
  logToDepositBot({
    type: 'resell_order_deduct',
    discordId: userId,
    amount,
    newBalance: balances[key],
    platform: 'Resell Bot',
    depositCode: null,
  });

  return balances[key];
}

// ─────────────────────────────────────────────────────────────────────────────
// Check if a user has a confirmed deposit matching an amount
// deposits.json structure: { "DEP-XXXX": { discordId, status, amount, ... } }
// ─────────────────────────────────────────────────────────────────────────────
function checkDepositForOrder(userId, amount) {
  const deposits = readDepositFile('deposits.json');
  if (!deposits) return null;

  return Object.values(deposits).find(d =>
    d.discordId === userId &&
    d.status === 'paid' &&
    !d.usedForOrder &&
    parseFloat(d.amount) === parseFloat(amount)
  ) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mark a deposit code as used for an order
// ─────────────────────────────────────────────────────────────────────────────
function markDepositUsed(depositCode, orderId) {
  const deposits = readDepositFile('deposits.json');
  if (!deposits || !deposits[depositCode]) return false;
  deposits[depositCode].usedForOrder = orderId;
  deposits[depositCode].usedAt = new Date().toISOString();
  return writeDepositFile('deposits.json', deposits);
}

// ─────────────────────────────────────────────────────────────────────────────
// Get all deposits for a user (their history from deposit bot)
// ─────────────────────────────────────────────────────────────────────────────
function getUserDepositHistory(userId) {
  const deposits = readDepositFile('deposits.json');
  if (!deposits) return [];
  return Object.values(deposits)
    .filter(d => d.discordId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ─────────────────────────────────────────────────────────────────────────────
// Log an event to deposit bot's transactions.json
// ─────────────────────────────────────────────────────────────────────────────
function logToDepositBot(entry) {
  const fp = depositFile('transactions.json');
  if (!fp) return;
  let log = [];
  if (fs.existsSync(fp)) {
    try { log = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
  }
  log.unshift({ ...entry, timestamp: new Date().toISOString(), source: 'resell-bot' });
  if (log.length > 500) log = log.slice(0, 500);
  try { fs.writeFileSync(fp, JSON.stringify(log, null, 2)); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Check if user has enough balance to cover an order
// ─────────────────────────────────────────────────────────────────────────────
function hasEnoughBalance(userId, amount) {
  const balance = getDepositBalance(userId);
  return balance !== null && balance >= amount;
}

module.exports = {
  getDepositBalance,
  deductDepositBalance,
  checkDepositForOrder,
  markDepositUsed,
  getUserDepositHistory,
  logToDepositBot,
  hasEnoughBalance,
};
