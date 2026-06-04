require('dotenv').config();

const {
  Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder,
  ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const fs = require('fs');
const { checkEmails } = require('./email-monitor');
const { createDepositCode, lookupCode, markPaid, getPendingForUser, getAllForUser, getAllPending } = require('./registry');
const { scrapeDoorDashLink } = require('./doordash-scraper');
const { fetchGroupOrder, applyPromo } = require('./doordash-group');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const DEPOSIT_CHANNEL_ID = process.env.DEPOSIT_CHANNEL_ID;
const CHECK_INTERVAL_MS = 60000;
const DB_FILE = './balances.json';
const LOG_FILE = './transactions.json';
const TICKETS_FILE = './tickets.json';
const POINTS_FILE = './points.json';
const CHEF_ROLE_NAME = 'Chef';

const PLATFORM_STYLE = {
  PayPal:     { color: 0x003087, emoji: 'P' },
  Venmo:      { color: 0x3396CD, emoji: '💙' },
  'Cash App': { color: 0x00D632, emoji: '💚' },
  Zelle:      { color: 0x6D1ED4, emoji: '💜' },
  Chime:      { color: 0x00C300, emoji: '🟢' },
  Manual:     { color: 0x607D8B, emoji: '✅' },
};

// DB
function loadDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(d) { fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); }
function getBalance(k) { return loadDB()[k] ?? 0; }
function addBalance(k, n) { const d = loadDB(); d[k] = (d[k] ?? 0) + n; saveDB(d); return d[k]; }
function setBalance(k, n) { const d = loadDB(); d[k] = n; saveDB(d); return n; }
function logTx(e) {
  let l = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE)) : [];
  l.unshift({ ...e, timestamp: new Date().toISOString() });
  if (l.length > 500) l = l.slice(0, 500);
  fs.writeFileSync(LOG_FILE, JSON.stringify(l, null, 2));
}
function getLog(n) {
  n = n || 10;
  return fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE)).slice(0, n) : [];
}

// Tickets
function loadTickets() {
  if (!fs.existsSync(TICKETS_FILE)) fs.writeFileSync(TICKETS_FILE, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf8'));
}
function saveTickets(d) { fs.writeFileSync(TICKETS_FILE, JSON.stringify(d, null, 2)); }
function saveTicket(code, channelId, discordId) {
  const t = loadTickets(); t[code] = { channelId, discordId }; saveTickets(t);
}
function getTicketInfo(code) { return loadTickets()[code] ?? null; }
function removeTicket(code) { const t = loadTickets(); delete t[code]; saveTickets(t); }

// Points
function loadPoints() {
  if (!fs.existsSync(POINTS_FILE)) fs.writeFileSync(POINTS_FILE, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(POINTS_FILE, 'utf8'));
}
function savePoints(d) { fs.writeFileSync(POINTS_FILE, JSON.stringify(d, null, 2)); }
function addPoint(userId, username) {
  const p = loadPoints();
  if (!p[userId]) p[userId] = { username, points: 0 };
  p[userId].points += 1;
  p[userId].username = username;
  savePoints(p);
  return p[userId].points;
}
function resetAllPoints() {
  const p = loadPoints();
  for (const id of Object.keys(p)) p[id].points = 0;
  savePoints(p);
}

// Commands
const commands = [
  new SlashCommandBuilder().setName('newdeposit').setDescription('Open a deposit ticket')
    .addNumberOption(o => o.setName('amount').setDescription('Amount (optional)').setRequired(false)),
  new SlashCommandBuilder().setName('balance').setDescription('Check balance')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(false)),
  new SlashCommandBuilder().setName('myhistory').setDescription('Your deposit history'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top 10 balances'),
  new SlashCommandBuilder().setName('points').setDescription('Chef points leaderboard'),
  new SlashCommandBuilder().setName('mypoints').setDescription('Your points'),
  new SlashCommandBuilder().setName('resetpoints').setDescription('Reset all points (Admin)'),
  new SlashCommandBuilder().setName('withdraw').setDescription('Deduct balance (Admin)')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addNumberOption(o => o.setName('amount').setDescription('Amount').setRequired(true)),
  new SlashCommandBuilder().setName('setbalance').setDescription('Set balance (Admin)')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addNumberOption(o => o.setName('amount').setDescription('Amount').setRequired(true)),
  new SlashCommandBuilder().setName('history').setDescription('Recent transactions (Admin)'),
  new SlashCommandBuilder().setName('pending').setDescription('Pending deposit codes (Admin)'),
  new SlashCommandBuilder().setName('checkmail').setDescription('Check Gmail now'),
  new SlashCommandBuilder().setName('closeticket').setDescription('Close this ticket (Admin)'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (e) { console.error(e); }
})();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

function makeConfirmRow(code) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('confirm_' + code).setLabel('Confirm Payment').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('deny_' + code).setLabel('Cancel Ticket').setStyle(ButtonStyle.Danger),
  );
}

async function createTicketChannel(guild, user, deposit) {
  const category = TICKET_CATEGORY_ID ? guild.channels.cache.get(TICKET_CATEGORY_ID) : null;
  const channel = await guild.channels.create({
    name: 'deposit-' + user.username.toLowerCase() + '-' + deposit.code.toLowerCase(),
    type: ChannelType.GuildText,
    parent: category ?? undefined,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
    ],
  });
  saveTicket(deposit.code, channel.id, user.id);
  return channel;
}

async function closeTicket(code, channel, delayMs) {
  delayMs = delayMs || 10000;
  await channel.send({ embeds: [new EmbedBuilder().setColor(0x607D8B).setTitle('Ticket Closing').setDescription('This ticket will be deleted in 10 seconds...').setTimestamp()] });
  setTimeout(async () => {
    try { await channel.delete(); removeTicket(code); }
    catch (e) { console.error('Failed to delete ticket:', e.message); }
  }, delayMs);
}

async function confirmDeposit(deposit, amount, platform, senderName, channel) {
  markPaid(deposit.code, { amount, platform, senderName });
  const balanceKey = 'discord_' + deposit.discordId;
  const newBalance = addBalance(balanceKey, amount);
  logTx({ type: platform === 'Manual' ? 'manual_confirm' : 'auto_deposit', platform, senderName, discordId: deposit.discordId, depositCode: deposit.code, amount, newBalance });
  const style = PLATFORM_STYLE[platform] ?? { color: 0x888888, emoji: '💰' };
  await channel.send({
    content: '<@' + deposit.discordId + '>',
    embeds: [new EmbedBuilder().setColor(style.color).setTitle(style.emoji + ' Payment Confirmed!')
      .setDescription('Your deposit has been received and your balance has been updated!')
      .addFields(
        { name: 'Platform', value: platform, inline: true },
        { name: 'Amount', value: '$' + amount.toFixed(2), inline: true },
        { name: 'New Balance', value: '$' + newBalance.toFixed(2), inline: true },
      )
      .setFooter({ text: platform === 'Manual' ? 'Manually confirmed by admin' : 'Auto-detected via Gmail' })
      .setTimestamp()],
  });
  await closeTicket(deposit.code, channel);
}

async function handleAutoDeposit(payment) {
  const { platform, amount, senderName, depositCode } = payment;
  if (!depositCode) { console.log('No code in memo from ' + senderName); return; }
  const deposit = lookupCode(depositCode);
  if (!deposit) { console.log('Unknown code: ' + depositCode); return; }
  if (deposit.status === 'paid') { console.log('Code already used: ' + depositCode); return; }
  const guild = client.guilds.cache.get(GUILD_ID);
  const ticketInfo = getTicketInfo(depositCode);
  const channel = ticketInfo ? guild && guild.channels.cache.get(ticketInfo.channelId) : null;
  if (channel) {
    await confirmDeposit(deposit, amount, platform, senderName, channel);
  } else {
    markPaid(depositCode, { amount, platform, senderName });
    addBalance('discord_' + deposit.discordId, amount);
    logTx({ type: 'auto_deposit', platform, senderName, discordId: deposit.discordId, depositCode, amount });
    const fallback = client.channels.cache.get(DEPOSIT_CHANNEL_ID);
    if (fallback) {
      await fallback.send({ embeds: [new EmbedBuilder().setColor(0x00C853).setTitle('Payment Received')
        .addFields(
          { name: 'User', value: '<@' + deposit.discordId + '>', inline: true },
          { name: 'Amount', value: '$' + amount.toFixed(2), inline: true },
          { name: 'Platform', value: platform, inline: true },
        ).setTimestamp()] });
    }
  }
}

async function startEmailMonitor() {
  const accounts = [process.env.GMAIL_USER, process.env.GMAIL_USER_2, process.env.GMAIL_USER_3].filter(Boolean);
  if (!accounts.length) { console.error('No Gmail accounts configured!'); return; }
  console.log('Monitoring ' + accounts.length + ' Gmail account(s). Polling every 60s...');
  await runEmailCheck();
  setInterval(runEmailCheck, CHECK_INTERVAL_MS);
}

async function runEmailCheck() {
  try { await checkEmails(null, handleAutoDeposit); }
  catch (e) { console.error('Email check error:', e.message); }
}

// Message listener for DoorDash links
const DDMAP_REGEX = /https:\/\/ddmap-production\.up\.railway\.app\/map\/[a-f0-9-]+/i;
const GIFT_REGEX = /https:\/\/www\.doordash\.com\/gifts\/[a-f0-9-]+/i;
const GROUP_REGEX = /https:\/\/www\.doordash\.com\/(?:group-order|share\/group-order|links\/group-order)\/[a-zA-Z0-9-]+/i;
const DRD_REGEX = /https:\/\/drd\.sh\/cart\/[a-zA-Z0-9]+\/?/i;

async function expandShortLink(url) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15' }
    });
    return res.url;
  } catch (e) {
    console.error('Failed to expand short link:', e.message);
    return url;
  }
}

client.on('messageCreate', async function(message) {
  if (message.author.bot) return;
  const member = message.member;
  const isChef = member && member.roles.cache.some(function(r) { return r.name === CHEF_ROLE_NAME; });

  // Gift link
  const giftMatch = message.content.match(GIFT_REGEX);
  if (giftMatch) {
    const url = giftMatch[0];
    const giftId = url.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
    const giftUUID = giftId ? giftId[0] : null;

    let pointsText = '';
    if (isChef) {
      const total = addPoint(message.author.id, message.author.username);
      pointsText = '+1 point! ' + message.author.username + ' now has ' + total + ' point' + (total !== 1 ? 's' : '');
    }

    async function fetchGiftOrder() {
      const token = process.env.DOORDASH_TOKEN;
      if (!token || !giftUUID) return null;
      const endpoints = [
        'https://www.doordash.com/api/v2/orders/gifts/' + giftUUID + '/',
        'https://www.doordash.com/api/v1/gifts/' + giftUUID + '/',
        'https://www.doordash.com/api/v2/gifts/' + giftUUID + '/',
      ];
      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint, {
            headers: {
              'Authorization': 'Bearer ' + token.split(':')[0],
              'Cookie': 'ddweb_token=' + token,
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
              'Accept': 'application/json',
            },
          });
          if (res.ok) return await res.json();
        } catch (e) { continue; }
      }
      return null;
    }

    function buildGiftEmbed(data, lastUpdated) {
      const statusMap = {
        created: 'Order Placed',
        confirmed: 'Confirmed',
        preparing: 'Preparing',
        picked_up: 'Picked Up',
        delivered: 'Delivered',
        cancelled: 'Cancelled',
      };
      const embed = new EmbedBuilder()
        .setColor(0xFF3008)
        .setTitle('DoorDash Gift Order')
        .setURL(url)
        .addFields({ name: 'Shared by', value: '<@' + message.author.id + '>', inline: true });

      if (data) {
        const store = data.store_name || (data.store && data.store.name) || 'Unknown';
        const status = statusMap[data.status] || data.status || 'Tracking...';
        const eta = data.estimated_delivery_time || data.delivery_eta || null;
        const driver = (data.dasher && data.dasher.first_name) || (data.driver && data.driver.name) || null;
        const items = data.items || data.order_items || [];
        const orderFor = data.recipient_name || null;

        embed.addFields(
          { name: 'Restaurant', value: store, inline: true },
          { name: 'Status', value: status, inline: true },
        );
        if (eta) embed.addFields({ name: 'ETA', value: eta, inline: true });
        if (driver) embed.addFields({ name: 'Dasher', value: driver, inline: true });
        if (orderFor) embed.addFields({ name: 'Order For', value: orderFor, inline: true });
        if (items.length) {
          const itemsText = items.map(function(i) { return (i.quantity || 1) + 'x ' + i.name; }).join('\\n');
          embed.addFields({ name: 'Items', value: itemsText.slice(0, 1024) });
        }
      } else {
        embed.setDescription('Tracking order... Click the link to view full details.\n[Open Order](' + url + ')');
      }

      if (pointsText) embed.addFields({ name: 'Points', value: pointsText });
      embed.setFooter({ text: 'Live Tracker' + (lastUpdated ? ' | Updated: ' + lastUpdated : '') }).setTimestamp();
      return embed;
    }

    const initialData = await fetchGiftOrder();
    const sentMsg = await message.reply({ embeds: [buildGiftEmbed(initialData, null)] });

    const giftInterval = setInterval(async function() {
      try {
        const updated = await fetchGiftOrder();
        await sentMsg.edit({ embeds: [buildGiftEmbed(updated, new Date().toLocaleTimeString())] });
        if (updated && (updated.status === 'delivered' || updated.status === 'cancelled')) {
          clearInterval(giftInterval);
        }
      } catch (e) { console.error('Gift tracker error:', e.message); }
    }, 30000);

    setTimeout(function() { clearInterval(giftInterval); }, 3 * 60 * 60 * 1000);
    return;
  }

  // drd.sh short link
  const drdMatch = message.content.match(DRD_REGEX);
  if (drdMatch) {
    const shortUrl = drdMatch[0];
    const thinking = await message.reply('Expanding DoorDash link...');
    const fullUrl = await expandShortLink(shortUrl);
    console.log('Expanded ' + shortUrl + ' -> ' + fullUrl);

    // Check if it expanded to a group order
    if (fullUrl.includes('group-order') || fullUrl.includes('cart') || fullUrl.includes('drd.sh')) {
      const result = await fetchGroupOrder(fullUrl);
      if (!result.success) {
        return thinking.edit('Opened link: ' + fullUrl + ' - Could not read order details automatically. Error: ' + result.error);
      }
      const data = result.data;
      const store = data.store_name || (data.store && data.store.name) || 'Unknown Restaurant';
      const items = data.items || (data.cart && data.cart.items) || [];
      const subtotal = (data.subtotal || (data.cart && data.cart.subtotal) || 0) / 100;
      const promoSubtotal = applyPromo(subtotal, 50);
      let itemsText = items.length
        ? items.map(function(item) {
            const price = (item.price || item.unit_price || 0) / 100;
            const qty = item.quantity || 1;
            const total = price * qty;
            const promo = applyPromo(total, 50);
            return qty + 'x ' + item.name + ' | $' + total.toFixed(2) + ' -> $' + promo.final;
          }).join('\n')
        : 'No items found';

      const embed = new EmbedBuilder()
        .setColor(0xFF3008)
        .setTitle('DoorDash Group Order Price Breakdown')
        .setURL(fullUrl)
        .addFields(
          { name: 'Restaurant', value: store, inline: true },
          { name: 'Original Total', value: '$' + subtotal.toFixed(2), inline: true },
          { name: 'After 50% Off', value: '$' + promoSubtotal.final, inline: true },
        )
        .addFields({ name: 'Items', value: itemsText.slice(0, 1024) })
        .addFields({ name: 'Summary', value: 'Original: $' + subtotal.toFixed(2) + '\nDiscount: -$' + promoSubtotal.discount + '\nYou pay: $' + promoSubtotal.final })
        .setFooter({ text: 'Based on 50% promo | Updates every 30s' }).setTimestamp();

      const sentMsg = await thinking.edit({ content: '', embeds: [embed] });

      const drdInterval = setInterval(async function() {
        try {
          const updated = await fetchGroupOrder(fullUrl);
          if (!updated.success) { clearInterval(drdInterval); return; }
          const d = updated.data;
          const updatedStore = d.store_name || (d.store && d.store.name) || store;
          const updatedItems = d.items || (d.cart && d.cart.items) || [];
          const updatedSubtotal = (d.subtotal || (d.cart && d.cart.subtotal) || 0) / 100;
          const updatedPromo = applyPromo(updatedSubtotal, 50);
          const updatedItemsText = updatedItems.length
            ? updatedItems.map(function(i) {
                const p = (i.price || i.unit_price || 0) / 100 * (i.quantity || 1);
                const pr = applyPromo(p, 50);
                return (i.quantity || 1) + 'x ' + i.name + ' | $' + p.toFixed(2) + ' -> $' + pr.final;
              }).join('\n')
            : 'No items found';
          const updatedEmbed = new EmbedBuilder()
            .setColor(0xFF3008).setTitle('DoorDash Group Order Price Breakdown').setURL(fullUrl)
            .addFields(
              { name: 'Restaurant', value: updatedStore, inline: true },
              { name: 'Original Total', value: '$' + updatedSubtotal.toFixed(2), inline: true },
              { name: 'After 50% Off', value: '$' + updatedPromo.final, inline: true },
            )
            .addFields({ name: 'Items', value: updatedItemsText.slice(0, 1024) })
            .addFields({ name: 'Summary', value: 'Original: $' + updatedSubtotal.toFixed(2) + '\nDiscount: -$' + updatedPromo.discount + '\nYou pay: $' + updatedPromo.final })
            .setFooter({ text: 'Based on 50% promo | Updated: ' + new Date().toLocaleTimeString() }).setTimestamp();
          await sentMsg.edit({ embeds: [updatedEmbed] });
        } catch (e) { console.error('drd tracker error:', e.message); clearInterval(drdInterval); }
      }, 30000);

      setTimeout(function() { clearInterval(drdInterval); }, 2 * 60 * 60 * 1000);
      return;
    }

    return thinking.edit('Expanded link: ' + fullUrl);
  }

  // Group order link
  const groupMatch = message.content.match(GROUP_REGEX);
  if (groupMatch) {
    const url = groupMatch[0];
    const thinking = await message.reply('Reading group order and calculating 50% promo prices...');
    const result = await fetchGroupOrder(url);
    if (!result.success) return thinking.edit('Could not read the group order. Error: ' + result.error);

    const data = result.data;
    const store = data.store_name || (data.store && data.store.name) || 'Unknown Restaurant';
    const items = data.items || (data.cart && data.cart.items) || [];
    const subtotal = (data.subtotal || (data.cart && data.cart.subtotal) || 0) / 100;
    const promoSubtotal = applyPromo(subtotal, 50);

    let itemsText = '';
    if (items.length) {
      itemsText = items.map(function(item) {
        const price = (item.price || item.unit_price || 0) / 100;
        const qty = item.quantity || 1;
        const total = price * qty;
        const promo = applyPromo(total, 50);
        return qty + 'x ' + item.name + ' | Original: $' + total.toFixed(2) + ' -> After 50% off: $' + promo.final;
      }).join('\\n');
    } else {
      itemsText = 'No items found';
    }

    const embed = new EmbedBuilder()
      .setColor(0xFF3008)
      .setTitle('DoorDash Group Order Price Breakdown')
      .setURL(url)
      .addFields(
        { name: 'Restaurant', value: store, inline: true },
        { name: 'Original Total', value: '$' + subtotal.toFixed(2), inline: true },
        { name: 'After 50% Off', value: '$' + promoSubtotal.final, inline: true },
      )
      .addFields({ name: 'Items', value: itemsText.slice(0, 1024) })
      .addFields({ name: 'Summary', value: 'Original: $' + subtotal.toFixed(2) + '\nDiscount: -$' + promoSubtotal.discount + '\nYou pay: $' + promoSubtotal.final })
      .setFooter({ text: 'Based on 50% promo | Updates every 30s' }).setTimestamp();

    const sentMsg = await thinking.edit({ content: '', embeds: [embed] });

    const trackInterval = setInterval(async function() {
      try {
        const updated = await fetchGroupOrder(url);
        if (!updated.success) { clearInterval(trackInterval); return; }
        const d = updated.data;
        const updatedStore = d.store_name || (d.store && d.store.name) || store;
        const updatedItems = d.items || (d.cart && d.cart.items) || [];
        const updatedSubtotal = (d.subtotal || (d.cart && d.cart.subtotal) || 0) / 100;
        const updatedPromo = applyPromo(updatedSubtotal, 50);
        let updatedItemsText = updatedItems.length
          ? updatedItems.map(function(i) {
              const p = (i.price || i.unit_price || 0) / 100 * (i.quantity || 1);
              const pr = applyPromo(p, 50);
              return (i.quantity || 1) + 'x ' + i.name + ' | $' + p.toFixed(2) + ' -> $' + pr.final;
            }).join('\\n')
          : 'No items found';
        const updatedEmbed = new EmbedBuilder()
          .setColor(0xFF3008).setTitle('DoorDash Group Order Price Breakdown').setURL(url)
          .addFields(
            { name: 'Restaurant', value: updatedStore, inline: true },
            { name: 'Original Total', value: '$' + updatedSubtotal.toFixed(2), inline: true },
            { name: 'After 50% Off', value: '$' + updatedPromo.final, inline: true },
          )
          .addFields({ name: 'Items', value: updatedItemsText.slice(0, 1024) })
          .addFields({ name: 'Summary', value: 'Original: $' + updatedSubtotal.toFixed(2) + '\nDiscount: -$' + updatedPromo.discount + '\nYou pay: $' + updatedPromo.final })
          .setFooter({ text: 'Based on 50% promo | Updated: ' + new Date().toLocaleTimeString() }).setTimestamp();
        await sentMsg.edit({ embeds: [updatedEmbed] });
      } catch (e) { console.error('Group tracker error:', e.message); clearInterval(trackInterval); }
    }, 30000);

    setTimeout(function() { clearInterval(trackInterval); }, 2 * 60 * 60 * 1000);
    return;
  }

  // ddmap tracker link
  const ddmapMatch = message.content.match(DDMAP_REGEX);
  if (ddmapMatch) {
    const url = ddmapMatch[0];
    const thinking = await message.reply('Reading your DoorDash order...');
    const data = await scrapeDoorDashLink(url);
    if (!data) return thinking.edit('Could not read the DoorDash link. Try again in a moment.');

    let itemsText = data.items && data.items.length
      ? data.items.map(function(i) {
          const c = i.customizations && i.customizations.length ? '\n' + i.customizations.map(function(x) { return '  - ' + x; }).join('\\n') : '';
          return i.qty + 'x ' + i.name + c;
        }).join('\n\n')
      : 'Could not parse items';

    let pointsText = '';
    if (isChef) {
      const total = addPoint(message.author.id, message.author.username);
      pointsText = '+1 point! ' + message.author.username + ' now has ' + total + ' point' + (total !== 1 ? 's' : '');
    }

    const embed = new EmbedBuilder().setColor(0xFF3008).setTitle('DoorDash Order Details').setURL(url)
      .addFields(
        { name: 'Restaurant', value: data.restaurant || 'Unknown', inline: true },
        { name: 'Status', value: data.status || 'Unknown', inline: true },
        { name: 'ETA', value: data.eta || 'Unknown', inline: true },
      );
    if (data.driver) embed.addFields({ name: 'Dasher', value: data.driver.name + ' ' + data.driver.rating + (data.driver.deliveries ? ' ' + data.driver.deliveries + ' deliveries' : ''), inline: false });
    if (data.orderFor) embed.addFields({ name: 'Order For', value: data.orderFor, inline: true });
    embed.addFields({ name: 'Items', value: itemsText.slice(0, 1024) });
    if (pointsText) embed.addFields({ name: 'Points', value: pointsText });
    embed.setFooter({ text: 'Auto-read from DoorDash tracker' }).setTimestamp();
    await thinking.edit({ content: '', embeds: [embed] });
  }
});

// Slash command handler
client.on('interactionCreate', async function(interaction) {

  if (interaction.isButton()) {
    const isAdmin = interaction.member.permissions.has('Administrator');
    if (!isAdmin) return interaction.reply({ content: 'Admin only.', ephemeral: true });
    const parts = interaction.customId.split('_');
    const action = parts[0];
    const code = parts.slice(1).join('_');

    if (action === 'confirm') {
      const deposit = lookupCode(code);
      if (!deposit) return interaction.reply({ content: 'Deposit code not found.', ephemeral: true });
      if (deposit.status === 'paid') return interaction.reply({ content: 'Already confirmed!', ephemeral: true });
      await interaction.reply({ content: 'Reply with: amount platform (e.g. 50 PayPal)', ephemeral: true });
      const filter = function(m) { return m.author.id === interaction.user.id; };
      try {
        const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
        const msgParts = collected.first().content.trim().split(' ');
        const amount = parseFloat(msgParts[0]);
        const platform = msgParts[1] || 'Manual';
        if (isNaN(amount) || amount <= 0) return interaction.followUp({ content: 'Invalid amount.', ephemeral: true });
        await collected.first().delete().catch(function() {});
        await confirmDeposit(deposit, amount, platform, 'Manual (Admin)', interaction.channel);
      } catch (e) {
        return interaction.followUp({ content: 'Timed out. Try again.', ephemeral: true });
      }
    }

    if (action === 'deny') {
      await interaction.reply({ content: 'Closing ticket in 10 seconds...' });
      setTimeout(async function() {
        try { await interaction.channel.delete(); } catch (e) {}
      }, 10000);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  if (cmd === 'newdeposit') {
    const expectedAmount = interaction.options.getNumber('amount');
    const deposit = createDepositCode(interaction.user.id, interaction.user.username, expectedAmount);
    const ticketChannel = await createTicketChannel(interaction.guild, interaction.user, deposit);
    await interaction.reply({ content: 'Your deposit ticket is ready! Head to <#' + ticketChannel.id + '>', ephemeral: true });
    await ticketChannel.send({
      content: '<@' + interaction.user.id + '>',
      embeds: [new EmbedBuilder().setColor(0x00C853).setTitle('Deposit Ticket')
        .setDescription('Send your payment to any method below and include your code in the memo/note!')
        .addFields(
          { name: 'Amount', value: expectedAmount ? '$' + expectedAmount.toFixed(2) : 'Any amount', inline: true },
          { name: 'Status', value: 'Waiting for payment...', inline: true },
        )
        .addFields({ name: 'Where to Send', value: 'PayPal: paypal.me/marquesnow816\nVenmo: @cinnamonzeus488\nCash App: $snowmarque373\nZelle: 5627319025\nChime: marque-snow' })
        .addFields({ name: 'Your One-Time Code - Put This in the Memo', value: '```' + deposit.code + '```' })
        .setFooter({ text: 'Ticket closes automatically once payment is confirmed.' }).setTimestamp()],
      components: [makeConfirmRow(deposit.code)],
    });
    return;
  }

  if (cmd === 'balance') {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const balance = getBalance('discord_' + targetUser.id);
    const pending = getPendingForUser(targetUser.id);
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x2196F3).setTitle('Balance')
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: 'User', value: '<@' + targetUser.id + '>', inline: true },
        { name: 'Balance', value: '$' + balance.toFixed(2), inline: true },
        { name: 'Pending', value: String(pending.length), inline: true },
      ).setTimestamp()] });
  }

  if (cmd === 'myhistory') {
    const all = getAllForUser(interaction.user.id);
    if (!all.length) return interaction.reply({ content: 'No deposit history yet!', ephemeral: true });
    const lines = all.slice(0, 15).map(function(d) {
      const icon = d.status === 'paid' ? 'PAID' : 'PENDING';
      const amount = d.amount ? '$' + d.amount.toFixed(2) : (d.expectedAmount ? '$' + d.expectedAmount.toFixed(2) : 'Any');
      return icon + ' ' + d.code + ' | ' + amount + ' | ' + (d.platform || 'Pending');
    });
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x2196F3).setTitle('Your Deposit History')
      .setDescription(lines.join('\\n'))
      .addFields({ name: 'Balance', value: '$' + getBalance('discord_' + interaction.user.id).toFixed(2) })
      .setTimestamp()] });
  }

  if (cmd === 'leaderboard') {
    const db = loadDB();
    const sorted = Object.entries(db).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 10);
    if (!sorted.length) return interaction.reply({ content: 'No balances yet.' });
    const medals = ['1.', '2.', '3.'];
    const lines = sorted.map(function(entry, i) {
      return (medals[i] || (i + 1) + '.') + ' <@' + entry[0].replace('discord_', '') + '> - $' + entry[1].toFixed(2);
    });
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFFD700).setTitle('Balance Leaderboard').setDescription(lines.join('\\n')).setTimestamp()] });
  }

  if (cmd === 'points') {
    const p = loadPoints();
    const sorted = Object.entries(p).sort(function(a, b) { return b[1].points - a[1].points; }).slice(0, 10);
    if (!sorted.length) return interaction.reply({ content: 'No points yet!', ephemeral: true });
    const lines = sorted.map(function(entry, i) {
      return (i + 1) + '. <@' + entry[0] + '> - ' + entry[1].points + ' points';
    });
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFFD700).setTitle('Chef Points Leaderboard').setDescription(lines.join('\\n')).setTimestamp()] });
  }

  if (cmd === 'mypoints') {
    const p = loadPoints();
    const me = p[interaction.user.id];
    const pts = me ? me.points : 0;
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0xFFD700).setTitle('Your Points')
      .addFields({ name: interaction.user.username, value: pts + ' point' + (pts !== 1 ? 's' : '') }).setTimestamp()] });
  }

  if (cmd === 'resetpoints') {
    if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', ephemeral: true });
    resetAllPoints();
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xF44336).setTitle('Points Reset').setDescription('All Chef points reset to 0.').setTimestamp()] });
  }

  if (cmd === 'withdraw') {
    if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const amount = interaction.options.getNumber('amount');
    const newBalance = addBalance('discord_' + targetUser.id, -amount);
    logTx({ type: 'withdraw', discordId: targetUser.id, amount, newBalance });
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFF5722).setTitle('Withdrawal')
      .addFields(
        { name: 'User', value: '<@' + targetUser.id + '>', inline: true },
        { name: 'Deducted', value: '$' + amount.toFixed(2), inline: true },
        { name: 'New Balance', value: '$' + newBalance.toFixed(2), inline: true },
      ).setTimestamp()] });
  }

  if (cmd === 'setbalance') {
    if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const amount = interaction.options.getNumber('amount');
    setBalance('discord_' + targetUser.id, amount);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x9C27B0).setTitle('Balance Set')
      .addFields({ name: '<@' + targetUser.id + '>', value: '$' + amount.toFixed(2) }).setTimestamp()] });
  }

  if (cmd === 'history') {
    if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', ephemeral: true });
    const log = getLog(10);
    if (!log.length) return interaction.reply({ content: 'No transactions yet.', ephemeral: true });
    const lines = log.map(function(t) {
      const icon = (t.type.includes('deposit') || t.type === 'manual_confirm') ? 'IN' : 'OUT';
      return icon + ' <@' + t.discordId + '> | $' + t.amount.toFixed(2) + ' | ' + (t.platform || 'Manual') + ' | ' + (t.depositCode || '-');
    });
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x607D8B).setTitle('Recent Transactions').setDescription(lines.join('\\n')).setTimestamp()] });
  }

  if (cmd === 'pending') {
    if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', ephemeral: true });
    const all = getAllPending();
    if (!all.length) return interaction.reply({ content: 'No pending deposits.', ephemeral: true });
    const lines = all.map(function(d) {
      return d.code + ' | <@' + d.discordId + '> | ' + (d.expectedAmount ? '$' + d.expectedAmount.toFixed(2) : 'Any');
    });
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0xFF9800).setTitle('Pending Deposits (' + all.length + ')').setDescription(lines.join('\\n')).setTimestamp()] });
  }

  if (cmd === 'checkmail') {
    await interaction.reply({ content: 'Checking Gmail now...', ephemeral: true });
    await runEmailCheck();
    return interaction.followUp({ content: 'Done!', ephemeral: true });
  }

  if (cmd === 'closeticket') {
    if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', ephemeral: true });
    await interaction.reply({ content: 'Closing in 10 seconds...' });
    setTimeout(async function() { try { await interaction.channel.delete(); } catch (e) {} }, 10000);
  }
});

client.once('ready', async function() {
  console.log('Bot online: ' + client.user.tag);
  await startEmailMonitor();
});

client.login(TOKEN);
