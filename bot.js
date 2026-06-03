// bot.js — Discord Deposit Bot | Tickets + Codes + Multi-Gmail + Manual Confirm
require('dotenv').config();

const {
  Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder,
  ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const fs = require('fs');
const { getGmailAuth, checkEmails } = require('./email-monitor');
const { createDepositCode, lookupCode, markPaid, getPendingForUser, getAllForUser, getAllPending } = require('./registry');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const CHECK_INTERVAL_MS = 60_000;
const DB_FILE = './balances.json';
const LOG_FILE = './transactions.json';
const TICKETS_FILE = './tickets.json';

// Multiple Gmail accounts — comma separated in .env
// GMAIL_CREDENTIALS_LIST={"creds1":...},{"creds2":...}
// OR just use GMAIL_CREDENTIALS for a single account
const EXTRA_GMAIL_CREDENTIALS = process.env.GMAIL_CREDENTIALS_2 ?? null;
const EXTRA_GMAIL_CREDENTIALS_3 = process.env.GMAIL_CREDENTIALS_3 ?? null;

const PLATFORM_STYLE = {
  PayPal:     { color: 0x003087, emoji: '🅿️' },
  Venmo:      { color: 0x3396CD, emoji: '💙' },
  'Cash App': { color: 0x00D632, emoji: '💚' },
  Zelle:      { color: 0x6D1ED4, emoji: '💜' },
  Chime:      { color: 0x00C300, emoji: '🟢' },
  Manual:     { color: 0x607D8B, emoji: '✅' },
};

// ── DB helpers ────────────────────────────────────────────────────────────────
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
function getLog(n = 10) {
  return fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE)).slice(0, n) : [];
}

// ── Ticket helpers ────────────────────────────────────────────────────────────
function loadTickets() {
  if (!fs.existsSync(TICKETS_FILE)) fs.writeFileSync(TICKETS_FILE, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf8'));
}
function saveTickets(d) { fs.writeFileSync(TICKETS_FILE, JSON.stringify(d, null, 2)); }
function saveTicket(code, channelId, discordId) {
  const t = loadTickets();
  t[code] = { channelId, discordId };
  saveTickets(t);
}
function getTicketInfo(code) { return loadTickets()[code] ?? null; }
function removeTicket(code) { const t = loadTickets(); delete t[code]; saveTickets(t); }

// ── Slash commands ────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('newdeposit')
    .setDescription('Open a deposit ticket and get your unique payment code')
    .addNumberOption(o => o.setName('amount').setDescription('Amount you are sending (optional)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your balance')
    .addUserOption(o => o.setName('user').setDescription('Discord user (leave blank for yourself)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('myhistory')
    .setDescription('See all your past deposits'),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Top 10 balances'),

  new SlashCommandBuilder()
    .setName('withdraw')
    .setDescription('Deduct from a user balance (Admin)')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addNumberOption(o => o.setName('amount').setDescription('Amount').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setbalance')
    .setDescription('Force-set a balance (Admin)')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addNumberOption(o => o.setName('amount').setDescription('Amount').setRequired(true)),

  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Last 10 transactions (Admin)'),

  new SlashCommandBuilder()
    .setName('pending')
    .setDescription('See all pending deposit codes (Admin)'),

  new SlashCommandBuilder()
    .setName('checkmail')
    .setDescription('Manually trigger Gmail check now'),

  new SlashCommandBuilder()
    .setName('closeticket')
    .setDescription('Manually close this ticket (Admin)'),

  new SlashCommandBuilder()
    .setName('points')
    .setDescription('See the Chef points leaderboard'),

  new SlashCommandBuilder()
    .setName('mypoints')
    .setDescription('Check your own points'),

  new SlashCommandBuilder()
    .setName('resetpoints')
    .setDescription('Reset ALL Chef points to 0 (Admin only)'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Slash commands registered.');
  } catch (e) { console.error(e); }
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

// ── Confirm button row (shown in every ticket) ────────────────────────────────
function makeConfirmRow(code) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_${code}`)
      .setLabel('✅ Confirm Payment Manually')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`deny_${code}`)
      .setLabel('❌ Cancel Ticket')
      .setStyle(ButtonStyle.Danger),
  );
}

// ── Create ticket channel ─────────────────────────────────────────────────────
async function createTicketChannel(guild, user, deposit) {
  const category = TICKET_CATEGORY_ID ? guild.channels.cache.get(TICKET_CATEGORY_ID) : null;
  const channel = await guild.channels.create({
    name: `deposit-${user.username.toLowerCase()}-${deposit.code.toLowerCase()}`,
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

// ── Close ticket ──────────────────────────────────────────────────────────────
async function closeTicket(code, channel, delayMs = 10000) {
  await channel.send({ embeds: [new EmbedBuilder()
    .setColor(0x607D8B)
    .setTitle('🔒 Ticket Closing')
    .setDescription('This ticket will be deleted in **10 seconds**...')
    .setTimestamp()] });
  setTimeout(async () => {
    try { await channel.delete(); removeTicket(code); }
    catch (e) { console.error('Failed to delete ticket:', e.message); }
  }, delayMs);
}

// ── Confirm deposit (shared logic used by auto + manual) ──────────────────────
async function confirmDeposit(deposit, amount, platform, senderName, channel) {
  markPaid(deposit.code, { amount, platform, senderName });
  const balanceKey = `discord_${deposit.discordId}`;
  const newBalance = addBalance(balanceKey, amount);
  logTx({ type: platform === 'Manual' ? 'manual_confirm' : 'auto_deposit', platform, senderName, discordId: deposit.discordId, depositCode: deposit.code, amount, newBalance });

  const style = PLATFORM_STYLE[platform] ?? { color: 0x888888, emoji: '💰' };
  await channel.send({
    content: `<@${deposit.discordId}>`,
    embeds: [new EmbedBuilder()
      .setColor(style.color)
      .setTitle(`${style.emoji} Payment Confirmed!`)
      .setDescription('Your deposit has been received and your balance has been updated!')
      .addFields(
        { name: 'Platform', value: platform, inline: true },
        { name: 'Amount', value: `$${amount.toFixed(2)}`, inline: true },
        { name: 'New Balance', value: `$${newBalance.toFixed(2)}`, inline: true },
        { name: 'Code', value: `\`${deposit.code}\``, inline: true },
      )
      .setFooter({ text: platform === 'Manual' ? '✅ Manually confirmed by admin' : '🤖 Auto-detected via Gmail' })
      .setTimestamp()],
  });

  await closeTicket(deposit.code, channel);
}

// ── Auto-deposit handler ──────────────────────────────────────────────────────
async function handleAutoDeposit(payment) {
  const { platform, amount, senderName, depositCode } = payment;
  if (!depositCode) { console.log(`⚠️  No code in memo from "${senderName}"`); return; }

  const deposit = lookupCode(depositCode);
  if (!deposit) { console.log(`⚠️  Unknown code: ${depositCode}`); return; }
  if (deposit.status === 'paid') { console.log(`⚠️  Code ${depositCode} already used`); return; }

  const guild = client.guilds.cache.get(GUILD_ID);
  const ticketInfo = getTicketInfo(depositCode);
  const channel = ticketInfo ? guild?.channels.cache.get(ticketInfo.channelId) : null;

  if (channel) {
    await confirmDeposit(deposit, amount, platform, senderName, channel);
  } else {
    console.log(`⚠️  Ticket channel not found for ${depositCode} — balance updated anyway`);
    markPaid(depositCode, { amount, platform, senderName });
    addBalance(`discord_${deposit.discordId}`, amount);
    logTx({ type: 'auto_deposit', platform, senderName, discordId: deposit.discordId, depositCode, amount });
  }
}

// ── Multi-Gmail polling ───────────────────────────────────────────────────────
async function startEmailMonitor() {
  const accounts = [
    process.env.GMAIL_USER,
    process.env.GMAIL_USER_2,
    process.env.GMAIL_USER_3,
  ].filter(Boolean);

  if (!accounts.length) {
    console.error('No Gmail accounts configured! Set GMAIL_USER and GMAIL_PASSWORD in Railway.');
    return;
  }

  console.log('Monitoring ' + accounts.length + ' Gmail account(s). Polling every 60s...');
  await runEmailCheck();
  setInterval(runEmailCheck, CHECK_INTERVAL_MS);
}

async function runEmailCheck() {
  try {
    await checkEmails(null, handleAutoDeposit);
  } catch (e) {
    console.error('Email check error:', e.message);
  }
}

// ── Command + Button handler ──────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {

  // ── Button interactions ───────────────────────────────────────────────────
  if (interaction.isButton()) {
    const isAdmin = interaction.member.permissions.has('Administrator');
    if (!isAdmin) return interaction.reply({ content: '❌ Only admins can use these buttons.', ephemeral: true });

    const [action, ...codeParts] = interaction.customId.split('_');
    const code = codeParts.join('_');

    // ── ✅ Confirm button ─────────────────────────────────────────────────
    if (action === 'confirm') {
      const deposit = lookupCode(code);
      if (!deposit) return interaction.reply({ content: '❌ Deposit code not found.', ephemeral: true });
      if (deposit.status === 'paid') return interaction.reply({ content: '⚠️ Already confirmed!', ephemeral: true });

      // Ask admin for amount
      await interaction.reply({
        content: `How much did they send? Reply with just the number (e.g. \`50\`) and the platform (e.g. \`PayPal\`)\nFormat: \`amount platform\`\nExample: \`50 PayPal\``,
        ephemeral: true,
      });

      // Wait for admin's reply
      const filter = m => m.author.id === interaction.user.id;
      try {
        const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 30_000, errors: ['time'] });
        const parts = collected.first().content.trim().split(' ');
        const amount = parseFloat(parts[0]);
        const platform = parts[1] ?? 'Manual';

        if (isNaN(amount) || amount <= 0) {
          return interaction.followUp({ content: '❌ Invalid amount. Try again.', ephemeral: true });
        }

        await collected.first().delete().catch(() => {});
        await confirmDeposit(deposit, amount, platform, 'Manual (Admin)', interaction.channel);
      } catch {
        return interaction.followUp({ content: '⏰ Timed out. Click the button again to retry.', ephemeral: true });
      }
    }

    // ── ❌ Deny/Cancel button ─────────────────────────────────────────────
    if (action === 'deny') {
      await interaction.reply({ content: '🔒 Cancelling ticket in 10 seconds...', ephemeral: false });
      const ticketInfo = getTicketInfo(code);
      setTimeout(async () => {
        try { await interaction.channel.delete(); removeTicket(code); }
        catch (e) { console.error('Failed to close ticket:', e.message); }
      }, 10000);
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  // ── /newdeposit ───────────────────────────────────────────────────────────
  if (commandName === 'newdeposit') {
    const expectedAmount = interaction.options.getNumber('amount') ?? null;
    const deposit = createDepositCode(interaction.user.id, interaction.user.username, expectedAmount);
    const ticketChannel = await createTicketChannel(interaction.guild, interaction.user, deposit);

    await interaction.reply({
      content: `✅ Your deposit ticket has been created! Head to <#${ticketChannel.id}>`,
      ephemeral: true,
    });

    await ticketChannel.send({
      content: `<@${interaction.user.id}>`,
      embeds: [new EmbedBuilder()
        .setColor(0x00C853)
        .setTitle('💰 Deposit Ticket')
        .setDescription('Send your payment to any method below and **include your code in the memo/note**!')
        .addFields(
          { name: '💵 Amount', value: expectedAmount ? `$${expectedAmount.toFixed(2)}` : 'Any amount', inline: true },
          { name: '⏳ Status', value: 'Waiting for payment...', inline: true },
        )
        .addFields({ name: '💸 Where to Send', value:
          `> 🅿️ **PayPal** → paypal.me/marquesnow816\n` +
          `> 💙 **Venmo** → @cinnamonzeus488\n` +
          `> 💚 **Cash App** → $snowmarque373\n` +
          `> 💜 **Zelle** → 5627319025\n` +
          `> 🟢 **Chime** → marque-snow`
        })
        .addFields({ name: '📋 Your One-Time Code — Put This in the Memo/Note', value:
          `\`\`\`${deposit.code}\`\`\``
        })
        .setFooter({ text: 'This ticket closes automatically once payment is confirmed.' })
        .setTimestamp()],
      components: [makeConfirmRow(deposit.code)],
    });

    return;
  }

  // ── /balance ──────────────────────────────────────────────────────────────
  if (commandName === 'balance') {
    const targetUser = interaction.options.getUser('user') ?? interaction.user;
    const balance = getBalance(`discord_${targetUser.id}`);
    const pending = getPendingForUser(targetUser.id);
    return interaction.reply({
      ephemeral: true,
      embeds: [new EmbedBuilder()
        .setColor(0x2196F3)
        .setTitle('💳 Balance')
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
          { name: 'User', value: `<@${targetUser.id}>`, inline: true },
          { name: 'Balance', value: `$${balance.toFixed(2)}`, inline: true },
          { name: 'Pending Deposits', value: `${pending.length}`, inline: true },
        )
        .setTimestamp()],
    });
  }

  // ── /myhistory ────────────────────────────────────────────────────────────
  if (commandName === 'myhistory') {
    const all = getAllForUser(interaction.user.id);
    if (!all.length) return interaction.reply({ content: 'No deposit history yet!', ephemeral: true });
    const lines = all.slice(0, 15).map(d => {
      const icon = d.status === 'paid' ? '✅' : '⏳';
      const amount = d.amount ? `$${d.amount.toFixed(2)}` : (d.expectedAmount ? `$${d.expectedAmount.toFixed(2)} expected` : 'Any');
      const date = d.status === 'paid' ? new Date(d.paidAt).toLocaleDateString() : `Created ${new Date(d.createdAt).toLocaleDateString()}`;
      return `${icon} \`${d.code}\` — ${amount} — ${d.platform ?? 'Pending'} — ${date}`;
    });
    return interaction.reply({
      ephemeral: true,
      embeds: [new EmbedBuilder()
        .setColor(0x2196F3)
        .setTitle('📋 Your Deposit History')
        .setDescription(lines.join('\n'))
        .addFields({ name: '💳 Current Balance', value: `$${getBalance(`discord_${interaction.user.id}`).toFixed(2)}` })
        .setTimestamp()],
    });
  }

  // ── /leaderboard ──────────────────────────────────────────────────────────
  if (commandName === 'leaderboard') {
    const db = loadDB();
    const sorted = Object.entries(db).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return interaction.reply({ content: 'No balances yet.' });
    const medals = ['🥇','🥈','🥉'];
    const lines = sorted.map(([k, b], i) =>
      `${medals[i] ?? `**${i+1}.**`} <@${k.replace('discord_', '')}> — $${b.toFixed(2)}`
    );
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFFD700)
      .setTitle('🏆 Leaderboard').setDescription(lines.join('\n')).setTimestamp()] });
  }

  // ── /withdraw ─────────────────────────────────────────────────────────────
  if (commandName === 'withdraw') {
    if (!interaction.member.permissions.has('Administrator'))
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const amount = interaction.options.getNumber('amount');
    const newBalance = addBalance(`discord_${targetUser.id}`, -amount);
    logTx({ type: 'withdraw', discordId: targetUser.id, amount, newBalance });
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFF5722).setTitle('📤 Withdrawal')
      .addFields(
        { name: 'User', value: `<@${targetUser.id}>`, inline: true },
        { name: 'Deducted', value: `$${amount.toFixed(2)}`, inline: true },
        { name: 'New Balance', value: `$${newBalance.toFixed(2)}`, inline: true },
      ).setTimestamp()] });
  }

  // ── /setbalance ───────────────────────────────────────────────────────────
  if (commandName === 'setbalance') {
    if (!interaction.member.permissions.has('Administrator'))
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const amount = interaction.options.getNumber('amount');
    setBalance(`discord_${targetUser.id}`, amount);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x9C27B0).setTitle('✏️ Balance Set')
      .addFields({ name: `<@${targetUser.id}>`, value: `$${amount.toFixed(2)}` }).setTimestamp()] });
  }

  // ── /history ──────────────────────────────────────────────────────────────
  if (commandName === 'history') {
    if (!interaction.member.permissions.has('Administrator'))
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const log = getLog(10);
    if (!log.length) return interaction.reply({ content: 'No transactions yet.', ephemeral: true });
    const lines = log.map(t => {
      const icon = t.type.includes('deposit') || t.type === 'manual_confirm' ? '💚' : '🔴';
      return `${icon} <@${t.discordId}> | $${t.amount.toFixed(2)} | ${t.platform ?? 'Manual'} | \`${t.depositCode ?? '—'}\` | ${new Date(t.timestamp).toLocaleDateString()}`;
    });
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x607D8B)
      .setTitle('📋 Recent Transactions').setDescription(lines.join('\n')).setTimestamp()] });
  }

  // ── /pending ──────────────────────────────────────────────────────────────
  if (commandName === 'pending') {
    if (!interaction.member.permissions.has('Administrator'))
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const all = getAllPending();
    if (!all.length) return interaction.reply({ content: '✅ No pending deposits.', ephemeral: true });
    const lines = all.map(d =>
      `\`${d.code}\` — <@${d.discordId}> — ${d.expectedAmount ? `$${d.expectedAmount.toFixed(2)}` : 'Any'} — ${new Date(d.createdAt).toLocaleDateString()}`
    );
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0xFF9800)
      .setTitle(`⏳ All Pending Codes (${all.length})`).setDescription(lines.join('\n')).setTimestamp()] });
  }

  // ── /closeticket ──────────────────────────────────────────────────────────
  if (commandName === 'closeticket') {
    if (!interaction.member.permissions.has('Administrator'))
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    await interaction.reply({ content: '🔒 Closing ticket in 10 seconds...' });
    setTimeout(async () => {
      try { await interaction.channel.delete(); }
      catch (e) { console.error('Failed to close ticket:', e.message); }
    }, 10000);
  }

  // ── /checkmail ────────────────────────────────────────────────────────────
  if (commandName === 'checkmail') {
    await interaction.reply({ content: '📧 Checking Gmail accounts now...', ephemeral: true });
    await runEmailCheck();
    return interaction.followUp({ content: '✅ Done!', ephemeral: true });
  }

  // ── /points ───────────────────────────────────────────────────────────────
  if (commandName === 'points') {
    const p = loadPoints();
    const sorted = Object.entries(p).sort((a, b) => b[1].points - a[1].points).slice(0, 10);
    if (!sorted.length) return interaction.reply({ content: 'No points recorded yet!', ephemeral: true });
    const medals = ['🥇','🥈','🥉'];
    const lines = sorted.map(([id, d], i) =>
      `${medals[i] ?? `**${i+1}.**`} <@${id}> — **${d.points}** point${d.points !== 1 ? 's' : ''}`
    );
    return interaction.reply({ embeds: [new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('⭐ Chef Points Leaderboard')
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Points earned by sharing DoorDash orders' })
      .setTimestamp()] });
  }

  // ── /mypoints ─────────────────────────────────────────────────────────────
  if (commandName === 'mypoints') {
    const p = loadPoints();
    const me = p[interaction.user.id];
    const pts = me?.points ?? 0;
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('⭐ Your Points')
      .addFields({ name: interaction.user.username, value: `**${pts}** point${pts !== 1 ? 's' : ''}` })
      .setTimestamp()] });
  }

  // ── /resetpoints ──────────────────────────────────────────────────────────
  if (commandName === 'resetpoints') {
    if (!interaction.member.permissions.has('Administrator'))
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    resetAllPoints();
    return interaction.reply({ embeds: [new EmbedBuilder()
      .setColor(0xF44336)
      .setTitle('🔄 Points Reset!')
      .setDescription('All Chef points have been reset to **0**.')
      .setTimestamp()] });
  }
});

// DoorDash link auto-reader + Chef points
const { scrapeDoorDashLink } = require('./doordash-scraper');
const { fetchGroupOrder, applyPromo } = require('./doordash-group');
const GROUP_ORDER_REGEX = /https:\/\/www\.doordash\.com\/(?:group-order|share\/group-order|links\/group-order)\/[a-f0-9-]+/i;
const DDMAP_REGEX = /https:\/\/ddmap-production\.up\.railway\.app\/map\/[a-f0-9-]+/i;
const POINTS_FILE = './points.json';
const CHEF_ROLE_NAME = 'Chef';

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

const GIFT_REGEX = /https:\/\/www\.doordash\.com\/gifts\/[a-f0-9-]+/i;

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const member = message.member;
  const isChef = member?.roles.cache.some(r => r.name === CHEF_ROLE_NAME);

  // ── DoorDash group order link ──────────────────────────────────────────────
  const groupMatch = message.content.match(GROUP_ORDER_REGEX);
  if (groupMatch) {
    const url = groupMatch[0];
    const thinking = await message.reply('🔍 Reading group order and calculating promo prices...');

    const result = await fetchGroupOrder(url);

    if (!result.success) {
      return thinking.edit('❌ Could not read the group order. Make sure the link is valid! Error: ' + result.error);
    }

    const data = result.data;

    // Parse items from group order
    const store = data.store_name ?? data.store?.name ?? 'Unknown Restaurant';
    const items = data.items ?? data.cart?.items ?? [];
    const subtotal = data.subtotal ?? data.cart?.subtotal ?? 0;
    const subtotalDollars = subtotal / 100; // DoorDash uses cents

    let itemsText = '';
    let promoTotal = 0;

    if (items.length) {
      itemsText = items.map(item => {
        const price = (item.price ?? item.unit_price ?? 0) / 100;
        const qty = item.quantity ?? 1;
        const total = price * qty;
        const promo = applyPromo(total, 50);
        promoTotal += parseFloat(promo.final);
        return `**${qty}x ${item.name}**
Original: $${total.toFixed(2)} → After 50% off: **$${promo.final}**`;
      }).join('

');
    } else {
      itemsText = '_No items found in group order_';
    }

    const promoSubtotal = applyPromo(subtotalDollars, 50);

    const embed = new EmbedBuilder()
      .setColor(0xFF3008)
      .setTitle('🍔 Group Order Price Breakdown')
      .setURL(url)
      .addFields({ name: '🏪 Restaurant', value: store, inline: true })
      .addFields({ name: '💰 Original Subtotal', value: `$${subtotalDollars.toFixed(2)}`, inline: true })
      .addFields({ name: '🎉 After 50% Off', value: `**$${promoSubtotal.final}**`, inline: true });

    if (itemsText) embed.addFields({ name: '🛍️ Items', value: itemsText.slice(0, 1024) });

    embed.addFields({
      name: '📊 Summary',
      value: `Original: $${subtotalDollars.toFixed(2)}
Discount (50%): -$${promoSubtotal.discount}
You pay: **$${promoSubtotal.final}**`,
    });

    embed.setFooter({ text: 'Prices based on 50% DoorDash promo • Updates every 30s' }).setTimestamp();
    const sentMsg = await thinking.edit({ content: '', embeds: [embed] });

    // Live tracker — updates every 30 seconds
    const trackInterval = setInterval(async () => {
      try {
        const updated = await fetchGroupOrder(url);
        if (!updated.success) { clearInterval(trackInterval); return; }

        const d = updated.data;
        const updatedStore = d.store_name ?? d.store?.name ?? store;
        const updatedItems = d.items ?? d.cart?.items ?? [];
        const updatedSubtotal = (d.subtotal ?? d.cart?.subtotal ?? 0) / 100;
        const updatedPromo = applyPromo(updatedSubtotal, 50);

        let updatedItemsText = '';
        if (updatedItems.length) {
          updatedItemsText = updatedItems.map(item => {
            const price = (item.price ?? item.unit_price ?? 0) / 100;
            const qty = item.quantity ?? 1;
            const total = price * qty;
            const promo = applyPromo(total, 50);
            return `**${qty}x ${item.name}**
Original: $${total.toFixed(2)} → After 50% off: **$${promo.final}**`;
          }).join('

');
        }

        const updatedEmbed = new EmbedBuilder()
          .setColor(0xFF3008)
          .setTitle('🍔 Group Order Price Breakdown')
          .setURL(url)
          .addFields({ name: '🏪 Restaurant', value: updatedStore, inline: true })
          .addFields({ name: '💰 Original Subtotal', value: `$${updatedSubtotal.toFixed(2)}`, inline: true })
          .addFields({ name: '🎉 After 50% Off', value: `**$${updatedPromo.final}**`, inline: true });

        if (updatedItemsText) updatedEmbed.addFields({ name: '🛍️ Items', value: updatedItemsText.slice(0, 1024) });

        updatedEmbed.addFields({
          name: '📊 Summary',
          value: `Original: $${updatedSubtotal.toFixed(2)}
Discount (50%): -$${updatedPromo.discount}
You pay: **$${updatedPromo.final}**`,
        });

        updatedEmbed
          .setFooter({ text: 'Live tracker • Last updated: ' + new Date().toLocaleTimeString() })
          .setTimestamp();

        await sentMsg.edit({ embeds: [updatedEmbed] });
      } catch (e) {
        console.error('Group order tracker error:', e.message);
        clearInterval(trackInterval);
      }
    }, 30000);

    // Stop tracking after 2 hours
    setTimeout(() => {
      clearInterval(trackInterval);
      sentMsg.edit({ content: '⏹️ Live tracking ended (2 hour limit reached).' }).catch(() => {});
    }, 2 * 60 * 60 * 1000);

    return;
  }

  // ── DoorDash gift link ────────────────────────────────────────────────────
  const giftMatch = message.content.match(GIFT_REGEX);
  if (giftMatch) {
    const url = giftMatch[0];
    const giftId = url.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i)?.[0];

    // Add point if Chef
    let pointsText = '';
    if (isChef) {
      const total = addPoint(message.author.id, message.author.username);
      pointsText = `⭐ +1 point! **${message.author.username}** now has **${total} point${total !== 1 ? 's' : ''}**`;
    }

    // Try to fetch order details from DoorDash API
    async function fetchGiftOrder() {
      const token = process.env.DOORDASH_TOKEN;
      const endpoints = [
        `https://www.doordash.com/api/v2/orders/gifts/${giftId}/`,
        `https://www.doordash.com/api/v1/gifts/${giftId}/`,
        `https://www.doordash.com/api/v2/gifts/${giftId}/`,
      ];
      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint, {
            headers: {
              'Authorization': `Bearer ${token?.split(':')[0]}`,
              'Cookie': `ddweb_token=${token}`,
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
              'Accept': 'application/json',
              'x-channel-id': 'doordash',
            },
          });
          if (res.ok) {
            const data = await res.json();
            return data;
          }
        } catch (e) { continue; }
      }
      return null;
    }

    function buildGiftEmbed(data, url, pointsText, lastUpdated = null) {
      const statusMap = {
        'created': '🟡 Order Placed',
        'confirmed': '🟠 Confirmed',
        'preparing': '👨‍🍳 Preparing',
        'picked_up': '🚗 Picked Up',
        'delivered': '✅ Delivered',
        'cancelled': '❌ Cancelled',
      };

      const embed = new EmbedBuilder()
        .setColor(data ? 0xFF3008 : 0x607D8B)
        .setTitle('🍔 DoorDash Gift Order')
        .setURL(url)
        .addFields({ name: '👤 Shared by', value: `<@${message.author.id}>`, inline: true });

      if (data) {
        const store = data.store_name ?? data.store?.name ?? data.restaurant?.name ?? 'Unknown';
        const status = statusMap[data.status] ?? data.status ?? '⏳ Tracking...';
        const eta = data.estimated_delivery_time ?? data.delivery_eta ?? null;
        const driver = data.dasher?.first_name ?? data.driver?.name ?? null;
        const items = data.items ?? data.order_items ?? [];
        const orderFor = data.recipient_name ?? data.delivery?.consumer_name ?? null;

        embed.addFields(
          { name: '🏪 Restaurant', value: store, inline: true },
          { name: '📊 Status', value: status, inline: true },
        );

        if (eta) embed.addFields({ name: '⏰ ETA', value: eta, inline: true });
        if (driver) embed.addFields({ name: '🚗 Dasher', value: driver, inline: true });
        if (orderFor) embed.addFields({ name: '📦 Order For', value: orderFor, inline: true });

        if (items.length) {
          const itemsText = items.map(i => `• **${i.quantity ?? 1}x ${i.name}**`).join('
');
          embed.addFields({ name: '🛍️ Items', value: itemsText.slice(0, 1024) });
        }
      } else {
        embed.setDescription('📡 Tracking order... DoorDash requires authentication to view full details.
🔗 [Open Order Link](' + url + ')');
      }

      if (pointsText) embed.addFields({ name: '⭐ Points', value: pointsText });

      const footer = lastUpdated
        ? `🔴 Live • Last updated: ${lastUpdated}`
        : '🔴 Live Tracker';
      embed.setFooter({ text: footer }).setTimestamp();
      return embed;
    }

    // Post initial embed
    const initialData = await fetchGiftOrder();
    const sentMsg = await message.reply({ embeds: [buildGiftEmbed(initialData, url, pointsText)] });

    // Live tracker — updates every 30 seconds
    const giftInterval = setInterval(async () => {
      try {
        const updated = await fetchGiftOrder();
        const updatedEmbed = buildGiftEmbed(updated, url, '', new Date().toLocaleTimeString());
        await sentMsg.edit({ embeds: [updatedEmbed] });

        // Stop if delivered or cancelled
        if (updated?.status === 'delivered' || updated?.status === 'cancelled') {
          clearInterval(giftInterval);
          await sentMsg.react('✅');
        }
      } catch (e) {
        console.error('Gift tracker error:', e.message);
      }
    }, 30000);

    // Stop after 3 hours
    setTimeout(() => {
      clearInterval(giftInterval);
      sentMsg.edit({ content: '⏹️ Live tracking ended.' }).catch(() => {});
    }, 3 * 60 * 60 * 1000);

    return;
  }

  // ── DoorDash tracker link (ddmap) ─────────────────────────────────────────
  const match = message.content.match(DDMAP_REGEX);
  if (!match) return;

  const url = match[0];
  const thinking = await message.reply('Searching your DoorDash order...');
  const data = await scrapeDoorDashLink(url);

  if (!data) return thinking.edit('Could not read the DoorDash link. Try again in a moment.');

  let itemsText = data.items?.length
    ? data.items.map(i => {
        const c = i.customizations?.length ? '\n' + i.customizations.map(x => '  - ' + x).join('\n') : '';
        return i.qty + 'x ' + i.name + c;
      }).join('\n\n')
    : 'Could not parse items';

  let pointsText = '';
  if (isChef) {
    const total = addPoint(message.author.id, message.author.username);
    pointsText = `⭐ +1 point! **${message.author.username}** now has **${total} point${total !== 1 ? 's' : ''}**`;
  }

  const embed = new EmbedBuilder()
    .setColor(0xFF3008)
    .setTitle('DoorDash Order Details')
    .setURL(url)
    .addFields(
      { name: 'Restaurant', value: data.restaurant ?? 'Unknown', inline: true },
      { name: 'Status', value: data.status ?? 'Unknown', inline: true },
      { name: 'ETA', value: data.eta ?? 'Unknown', inline: true },
    );

  if (data.driver) embed.addFields({ name: 'Dasher', value: data.driver.name + ' - ' + data.driver.rating + (data.driver.deliveries ? ' - ' + data.driver.deliveries + ' deliveries' : ''), inline: false });
  if (data.orderFor) embed.addFields({ name: 'Order For', value: data.orderFor, inline: true });
  embed.addFields({ name: 'Items', value: itemsText.slice(0, 1024) });
  if (pointsText) embed.addFields({ name: 'Points', value: pointsText });
  embed.setFooter({ text: 'Auto-read from DoorDash tracker' }).setTimestamp();

  await thinking.edit({ content: '', embeds: [embed] });
});

client.once('ready', async () => {
  console.log('Bot online: ' + client.user.tag);
  client.user.setActivity('watching your inbox');
  await startEmailMonitor();
});

client.login(TOKEN);