# 🛍️ Resell Bot — Setup Guide

## 📁 Folder Structure
```
resell-bot/
├── index.js
├── config.json
├── package.json
├── commands/
│   ├── order.js        → /order add/status/view/list/history
│   ├── leaderboard.js  → /leaderboard
│   ├── stock.js        → /stock view/add/update/remove
│   ├── verify.js       → /verify set/check/remove
│   ├── vouch.js        → /vouch add/check
│   ├── announce.js     → /announce
│   ├── pay.js          → /pay
│   ├── faq.js          → /faq
│   ├── invites.js      → /invites check/leaderboard
│   ├── giveaway.js     → /giveaway start/end/reroll
│   ├── waitlist.js     → /waitlist join/leave/view
│   ├── scamreport.js   → /scamreport add/view
│   ├── stats.js        → /stats
│   └── pingroles.js    → /pingroles add/remove/list
├── utils/
│   ├── db.js           → JSON read/write helper
│   ├── receipt.js      → Auto receipt generator
│   ├── inviteTracker.js→ Tracks who invited who
│   ├── giveawayChecker.js → Auto-ends giveaways
│   └── bridge.js       → Talks to deposit bot
└── data/               → Auto-created on first run
    ├── orders.json
    ├── employees.json
    ├── customers.json
    ├── stock.json
    ├── vouches.json
    ├── invites.json
    ├── waitlist.json
    ├── giveaways.json
    └── scamreports.json
```

---

## ⚙️ Setup Steps

### 1. Install dependencies
```bash
cd resell-bot
npm install
```

### 2. Fill in config.json
Open `config.json` and replace all placeholder values:

| Field | What to put |
|-------|-------------|
| `token` | Your bot token from Discord Developer Portal |
| `clientId` | Your bot's Application ID |
| `guildId` | Your Discord server ID |
| `staffRoleId` | Role ID for staff |
| `adminRoleId` | Role ID for admins |
| `receiptChannelId` | Channel where receipts get posted |
| `announcementChannelId` | Channel for announcements |
| `leaderboardChannelId` | Channel for leaderboards |
| `stockChannelId` | Channel for stock/low stock alerts |
| `vouchChannelId` | Channel where vouches get posted |
| `logChannelId` | Private staff log channel |
| `verifiedRoleId` | ✅ Verified Buyer role ID |
| `resellerRoleId` | 💰 Reseller role ID |
| `vipRoleId` | ⭐ VIP role ID |
| `blacklistedRoleId` | 🚫 Blacklisted role ID |
| `pingRoles` | Replace all ROLE_ID values for each category |
| `paymentMethods` | Your actual payment info |
| `depositBotDataPath` | Path to deposit bot's data folder |

### 3. Start the bot
```bash
npm start
```

---

## 🔗 Connecting to Your Deposit Bot

In `config.json`, set `depositBotDataPath` to the relative path of your deposit bot's `data/` folder.

Example:
```json
"depositBotDataPath": "../deposit-bot/data"
```

When you use `/order add` with `check_deposit: true`, the resell bot will:
1. Look in the deposit bot's `deposits.json` for a matching confirmed payment
2. Mark it as used so it can't be applied twice
3. Auto-set the payment status on the order

---

## 📋 All Commands

### 📦 Orders
| Command | Description |
|---------|-------------|
| `/order add` | Log a new order with receipt |
| `/order status` | Update order status |
| `/order view` | View a specific order |
| `/order list` | List/filter orders |
| `/order history` | Customer order history |

### 🏆 Leaderboard & Stats
| Command | Description |
|---------|-------------|
| `/leaderboard` | Weekly/monthly/all-time rankings |
| `/stats` | Employee dashboard |

### 🛍️ Stock
| Command | Description |
|---------|-------------|
| `/stock view` | Browse inventory |
| `/stock add` | Add/restock item |
| `/stock update` | Update quantity |
| `/stock remove` | Remove item |

### 👤 Customers
| Command | Description |
|---------|-------------|
| `/verify set` | Set verified/reseller/vip/blacklisted |
| `/verify check` | View customer profile |
| `/verify remove` | Remove a status |

### ⭐ Vouches
| Command | Description |
|---------|-------------|
| `/vouch add` | Leave a review |
| `/vouch check` | View employee reviews |

### 📣 Announcements
| Command | Description |
|---------|-------------|
| `/announce` | Send a clean embed announcement |
| `/pay` | Show payment methods |
| `/faq` | Answer common questions |

### 📨 Invites
| Command | Description |
|---------|-------------|
| `/invites check` | Check invite count |
| `/invites leaderboard` | Top inviters |

### 🎉 Giveaways
| Command | Description |
|---------|-------------|
| `/giveaway start` | Start a giveaway |
| `/giveaway end` | End early |
| `/giveaway reroll` | Reroll winner |

### ⚙️ Other
| Command | Description |
|---------|-------------|
| `/waitlist join` | Join a restock waitlist |
| `/waitlist leave` | Leave a waitlist |
| `/waitlist view` | View waitlist (staff) |
| `/scamreport add` | Log a suspicious user |
| `/scamreport view` | View reports on a user |
| `/pingroles add` | Subscribe to category pings |
| `/pingroles remove` | Unsubscribe |
| `/pingroles list` | See all ping roles |

---

## 💡 Tips

- Orders auto-generate IDs like `ORDER-1000`, `ORDER-1001`, etc.
- Giveaways auto-end using a 15-second background checker
- When stock is restocked, waitlisted users get auto-DM'd
- Low stock alerts fire when quantity hits your configured threshold
- All verification changes are logged to your log channel
- The bridge to your deposit bot is plug-and-play — just set the path
