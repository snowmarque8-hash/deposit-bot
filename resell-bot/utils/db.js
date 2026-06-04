const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const FILES = {
  orders:    'orders.json',
  employees: 'employees.json',
  customers: 'customers.json',
  stock:     'stock.json',
  vouches:   'vouches.json',
  invites:   'invites.json',
  waitlist:  'waitlist.json',
  giveaways: 'giveaways.json',
  scamreports: 'scamreports.json',
};

function initDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const defaults = {
    orders:      { orders: [], nextId: 1000 },
    employees:   { employees: {} },
    customers:   { customers: {} },
    stock:       { items: [] },
    vouches:     { vouches: [] },
    invites:     { invites: {}, cached: {} },
    waitlist:    { waitlist: {} },
    giveaways:   { giveaways: [] },
    scamreports: { reports: [] },
  };

  for (const [key, file] of Object.entries(FILES)) {
    const filePath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(defaults[key], null, 2));
    }
  }
  console.log('✅ Database initialized');
}

function readDB(name) {
  const filePath = path.join(DATA_DIR, FILES[name]);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeDB(name, data) {
  const filePath = path.join(DATA_DIR, FILES[name]);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

module.exports = { initDB, readDB, writeDB };
