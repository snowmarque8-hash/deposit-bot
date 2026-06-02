// bot.js — Discord Deposit Bot | Tickets + Per-deposit codes + Gmail auto-tracking
require('dotenv').config();

const {
  Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder,
  ChannelType, PermissionFlagsBits
} = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const fs = require('fs');
const { getGmailAuth, checkEmails } = require('./email-monitor');
const { createDepositCode, lookupCode, markPaid, getPendingForUser, getAllForUser, getAllPending } = require('./registry');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID; // category where ticket channels go
const CHECK_INTERVAL_MS = 60_000;
const DB_FILE = './balances.json';
const LOG_FILE = './transactions.json';
const TICKETS_FILE = './tickets.json'; // maps depositCode -> channelId

const PLATFORM_STYLE = {
  PayPal:     { color: 0x003087, emoji: '🅿️' },
  Venmo:      { color: 0x3396CD, emoji: '💙' },
  'Cash App': { color: 0x00D632, emoji: '💚' },
  Zelle:      { color: 0x6D1ED4, emoji: '💜' },
  Chime:      { color: 0x00C300, emoji: '🟢' },
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
function saveTicket(code, channelId) {
  const t = loadTickets(); t[code] = channelId; saveTickets(t);
}
function getTicketChannel(code) {
  return loadTickets()[code] ?? null;
}
function removeTicket(code) {
  const t = loadTickets(); delete t[code]; saveTickets(t);
}

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

  // Admin only
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
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Slash commands registered.');
  } catch (e) { console.error(e); }
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── Create a ticket channel ───────────────────────────────────────────────────
async function createTicketChannel(guild, user, deposit) {
  const category = TICKET_CATEGORY_ID ? guild.channels.cache.get(TICKET_CATEGORY_ID) : null;

  const channel = await guild.channels.create({
    name: `deposit-${user.username.toLowerCase()}-${deposit.code.toLowerCase()}`,
    type: ChannelType.GuildText,
    parent: category ?? undefined,
    permissionOverwrites: [
      {
        // Hide from everyone by default
        id: guild.roles.everyone,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        // Only the user can see it
        id: user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
      {
        // Bot can see it
        id: client.user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels],
      },
    ],
  });

  saveTicket(deposit.code, channel.id);
  return channel;
}

// ── Close a ticket channel (with delay) ──────────────────────────────────────
async function closeTicket(code, channel, delayMs = 10000) {
  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(0x607D8B)
      .setTitle('🔒 Ticket Closing')
      .setDescription(`This ticket will be deleted in **10 seconds**...`)
      .setTimestamp()],
  });

  setTimeout(async () => {
    try {
      await channel.delete();
      removeTicket(code);
    } catch (e) {
      console.error('Failed to delete ticket channel:', e.message);
    }
  }, delayMs);
}

// ── Auto-deposit handler (called by Gmail monitor) ────────────────────────────
async function handleAutoDeposit(payment) {
  const { platform, amount, senderName, depositCode } = payment;
  const style = PLATFORM_STYLE[platform] ?? { color: 0x888888, emoji: '💰' };

  // ── No code ───────────────────────────────────────────────────────────────
  if (!depositCode) {
    console.log(`⚠️  Payment from "${senderName}" — no deposit code in memo.`);
    return;
  }

  const deposit = lookupCode(depositCode);

  // ── Unknown code ──────────────────────────────────────────────────────────
  if (!deposit) {
    console.log(`⚠️  Unknown code: ${depositCode}`);
    return;
  }

  // ── Already paid ──────────────────────────────────────────────────────────
  if (deposit.status === 'paid') {
    console.log(`⚠️  Code ${depositCode} already used!`);
    return;
  }

  // ── Valid! Mark paid + update balance ─────────────────────────────────────
  markPaid(depositCode, { amount, platform, senderName });
  const balanceKey = `discord_${deposit.discordId}`;
  const newBalance = addBalance(balanceKey, amount);
  logTx({ type: 'auto_deposit', platform, senderName, discordId: deposit.discordId, depositCode, amount, newBalance });
  console.log(`💰 Deposit confirmed! ${deposit.username} | ${depositCode} | $${amount} via ${platform}`);

  // ── Post in the user's ticket channel ────────────────────────────────────
  const ticketChannelId = getTicketChannel(depositCode);
  const guild = client.guilds.cache.get(GUILD_ID);

  let ticketChannel = ticketChannelId ? guild?.channels.cache.get(ticketChannelId) : null;

  if (ticketChannel) {
    const amountWarning = deposit.expectedAmount && Math.abs(deposit.expectedAmount - amount) > 0.01
      ? `\n⚠️ Expected $${deposit.expectedAmount.toFixed(2)} but received $${amount.toFixed(2)}`
      : '';

    await ticketChannel.send({
      content: `<@${deposit.discordId}>`,
      embeds: [new EmbedBuilder()
        .setColor(style.color)
        .setTitle(`${style.emoji} Payment Confirmed!`)
        .setDescription(`Your deposit has been received and your balance has been updated!${amountWarning}`)
        .addFields(
          { name: 'Platform', value: platform, inline: true },
          { name: 'Amount', value: `$${amount.toFixed(2)}`, inline: true },
          { name: 'New Balance', value: `$${newBalance.toFixed(2)}`, inline: true },
          { name: 'Code', value: `\`${depositCode}\``, inline: true },
        )
        .setFooter({ text: '🤖 Detected automatically via Gmail' })
        .setTimestamp()],
    });

    // Auto close after 10 seconds
    await closeTicket(depositCode, ticketChannel);
  }
}

// ── Email polling ─────────────────────────────────────────────────────────────
let gmailAuth = null;
async function startEmailMonitor() {
  try {
    gmailAuth = await getGmailAuth();
    console.log('📧 Gmail connected. Polling every 60s...');
    await runEmailCheck();
    setInterval(runEmailCheck, CHECK_INTERVAL_MS);
  } catch (e) { console.error('❌ Gmail setup failed:', e.message); }
}
async function runEmailCheck() {
  if (!gmailAuth) return;
  try { await checkEmails(gmailAuth, handleAutoDeposit); }
  catch (e) { console.error('Email check error:', e.message); }
}

// ── Command handler ───────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  // ── /newdeposit ───────────────────────────────────────────────────────────
  if (commandName === 'newdeposit') {
    const expectedAmount = interaction.options.getNumber('amount') ?? null;
    const deposit = createDepositCode(interaction.user.id, interaction.user.username, expectedAmount);

    // Create private ticket channel
    const ticketChannel = await createTicketChannel(interaction.guild, interaction.user, deposit);

    // Confirm to user (ephemeral so others don't see)
    await interaction.reply({
      content: `✅ Your deposit ticket has been created! Head to <#${ticketChannel.id}>`,
      ephemeral: true,
    });

    // Post instructions inside the ticket
    await ticketChannel.send({
      content: `<@${interaction.user.id}>`,
      embeds: [new EmbedBuilder()
        .setColor(0x00C853)
        .setTitle('💰 Deposit Ticket')
        .setDescription('Here is your **one-time deposit code**. Put it in the memo/note when you send your payment:')
        .addFields(
          { name: '🔑 Your Code', value: `\`\`\`${deposit.code}\`\`\`` },
          { name: '💵 Expected Amount', value: expectedAmount ? `$${expectedAmount.toFixed(2)}` : 'Any amount', inline: true },
          { name: '⏳ Status', value: 'Waiting for payment...', inline: true },
        )
        .addFields({ name: '📋 Where to put the code', value:
          `> **PayPal** → Note field: \`${deposit.code}\`\n` +
          `> **Venmo** → Note field: \`${deposit.code}\`\n` +
          `> **Cash App** → Note field: \`${deposit.code}\`\n` +
          `> **Zelle** → Memo field: \`${deposit.code}\`\n` +
          `> **Chime** → Note field: \`${deposit.code}\``
        })
        .setFooter({ text: 'This ticket will automatically close once your payment is confirmed.' })
        .setTimestamp()],
    });

    return;
  }

  // ── /balance ──────────────────────────────────────────────────────────────
  if (commandName === 'balance') {
    const targetUser = interaction.options.getUser('user') ?? interaction.user;
    const balance = getBalance(`discord_${targetUser.id}`);
    const pending = getPendingForUser(targetUser.id);
    return interaction.reply({
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
      ephemeral: true,
    });
  }

  // ── /myhistory ────────────────────────────────────────────────────────────
  if (commandName === 'myhistory') {
    const all = getAllForUser(interaction.user.id);
    if (!all.length) return interaction.reply({ content: 'No deposit history yet. Run `/newdeposit` to get started!', ephemeral: true });
    const lines = all.slice(0, 15).map(d => {
      const icon = d.status === 'paid' ? '✅' : '⏳';
      const amount = d.amount ? `$${d.amount.toFixed(2)}` : (d.expectedAmount ? `$${d.expectedAmount.toFixed(2)} expected` : 'Any');
      const date = d.status === 'paid' ? new Date(d.paidAt).toLocaleDateString() : `Created ${new Date(d.createdAt).toLocaleDateString()}`;
      return `${icon} \`${d.code}\` — ${amount} — ${d.platform ?? 'Pending'} — ${date}`;
    });
    const balance = getBalance(`discord_${interaction.user.id}`);
    return interaction.reply({
      ephemeral: true,
      embeds: [new EmbedBuilder()
        .setColor(0x2196F3)
        .setTitle('📋 Your Deposit History')
        .setDescription(lines.join('\n'))
        .addFields({ name: '💳 Current Balance', value: `$${balance.toFixed(2)}` })
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
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xFFD700)
        .setTitle('🏆 Leaderboard').setDescription(lines.join('\n')).setTimestamp()],
    });
  }

  // ── /withdraw (admin) ─────────────────────────────────────────────────────
  if (commandName === 'withdraw') {
    if (!interaction.member.permissions.has('Administrator'))
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const amount = interaction.options.getNumber('amount');
    const newBalance = addBalance(`discord_${targetUser.id}`, -amount);
    logTx({ type: 'withdraw', discordId: targetUser.id, amount, newBalance });
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xFF5722).setTitle('📤 Withdrawal')
        .addFields(
          { name: 'User', value: `<@${targetUser.id}>`, inline: true },
          { name: 'Deducted', value: `$${amount.toFixed(2)}`, inline: true },
          { name: 'New Balance', value: `$${newBalance.toFixed(2)}`, inline: true },
        ).setTimestamp()],
    });
  }

  // ── /setbalance (admin) ───────────────────────────────────────────────────
  if (commandName === 'setbalance') {
    if (!interaction.member.permissions.has('Administrator'))
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const amount = interaction.options.getNumber('amount');
    setBalance(`discord_${targetUser.id}`, amount);
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x9C27B0).setTitle('✏️ Balance Set')
        .addFields({ name: `<@${targetUser.id}>`, value: `$${amount.toFixed(2)}` }).setTimestamp()],
    });
  }

  // ── /history (admin) ──────────────────────────────────────────────────────
  if (commandName === 'history') {
    if (!interaction.member.permissions.has('Administrator'))
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const log = getLog(10);
    if (!log.length) return interaction.reply({ content: 'No transactions yet.', ephemeral: true });
    const lines = log.map(t => {
      const icon = t.type.includes('deposit') ? '💚' : '🔴';
      return `${icon} <@${t.discordId}> | $${t.amount.toFixed(2)} | ${t.platform ?? 'Manual'} | \`${t.depositCode ?? '—'}\` | ${new Date(t.timestamp).toLocaleDateString()}`;
    });
    return interaction.reply({
      ephemeral: true,
      embeds: [new EmbedBuilder().setColor(0x607D8B)
        .setTitle('📋 Recent Transactions').setDescription(lines.join('\n')).setTimestamp()],
    });
  }

  // ── /pending (admin) ──────────────────────────────────────────────────────
  if (commandName === 'pending') {
    if (!interaction.member.permissions.has('Administrator'))
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const all = getAllPending();
    if (!all.length) return interaction.reply({ content: '✅ No pending deposits.', ephemeral: true });
    const lines = all.map(d =>
      `\`${d.code}\` — <@${d.discordId}> — ${d.expectedAmount ? `$${d.expectedAmount.toFixed(2)}` : 'Any'} — ${new Date(d.createdAt).toLocaleDateString()}`
    );
    return interaction.reply({
      ephemeral: true,
      embeds: [new EmbedBuilder().setColor(0xFF9800)
        .setTitle(`⏳ All Pending Codes (${all.length})`).setDescription(lines.join('\n')).setTimestamp()],
    });
  }

  // ── /closeticket (admin manual close) ────────────────────────────────────
  if (commandName === 'closeticket') {
    if (!interaction.member.permissions.has('Administrator'))
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    await interaction.reply({ content: '🔒 Closing ticket in 10 seconds...', ephemeral: false });
    setTimeout(async () => {
      try { await interaction.channel.delete(); }
      catch (e) { console.error('Failed to close ticket:', e.message); }
    }, 10000);
  }

  // ── /checkmail ────────────────────────────────────────────────────────────
  if (commandName === 'checkmail') {
    await interaction.reply({ content: '📧 Checking Gmail now...', ephemeral: true });
    await runEmailCheck();
    return interaction.followUp({ content: '✅ Done!', ephemeral: true });
  }
});

client.once('ready', async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  client.user.setActivity('watching your inbox 📧');
  await startEmailMonitor();
});

client.login(TOKEN);
