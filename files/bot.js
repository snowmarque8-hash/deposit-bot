// bot.js — Discord Deposit Bot | Per-deposit unique codes + Gmail auto-tracking
require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const fs = require('fs');
const { getGmailAuth, checkEmails } = require('./email-monitor');
const { createDepositCode, lookupCode, markPaid, getPendingForUser, getAllForUser, getAllPending } = require('./registry');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const DEPOSIT_CHANNEL_ID = process.env.DEPOSIT_CHANNEL_ID;
const CHECK_INTERVAL_MS = 60_000;
const DB_FILE = './balances.json';
const LOG_FILE = './transactions.json';

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

// ── Slash commands ────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('newdeposit')
    .setDescription('Generate a unique code for your next deposit')
    .addNumberOption(o => o.setName('amount').setDescription('Expected amount (optional)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('mypending')
    .setDescription('See all your pending deposit codes'),

  new SlashCommandBuilder()
    .setName('myhistory')
    .setDescription('See all your past deposits'),

  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check a balance')
    .addUserOption(o => o.setName('user').setDescription('Discord user (leave blank for yourself)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('pending')
    .setDescription('See ALL pending deposit codes (Admin)')
    ,

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
    .setName('leaderboard')
    .setDescription('Top 10 balances'),

  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Last 10 transactions (Admin)'),

  new SlashCommandBuilder()
    .setName('checkmail')
    .setDescription('Manually trigger Gmail check now'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Slash commands registered.');
  } catch (e) { console.error(e); }
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── Auto-deposit handler ──────────────────────────────────────────────────────
async function handleAutoDeposit(payment) {
  const { platform, amount, senderName, depositCode } = payment;
  const style = PLATFORM_STYLE[platform] ?? { color: 0x888888, emoji: '💰' };
  const channel = client.channels.cache.get(DEPOSIT_CHANNEL_ID);

  // ── No code in email ──────────────────────────────────────────────────────
  if (!depositCode) {
    console.log(`⚠️  Payment from "${senderName}" — no deposit code found in memo.`);
    if (channel) {
      await channel.send({ embeds: [new EmbedBuilder()
        .setColor(0xFF9800)
        .setTitle(`${style.emoji} Payment Received — No Code!`)
        .setDescription('A payment came in but the sender **did not include a deposit code** in the memo.\nAsk them to run `/newdeposit` first next time.')
        .addFields(
          { name: 'Platform', value: platform, inline: true },
          { name: 'Amount', value: `$${amount.toFixed(2)}`, inline: true },
          { name: 'Sender Name', value: senderName, inline: true },
        )
        .setFooter({ text: 'Use /withdraw or /setbalance to manually adjust if needed' })
        .setTimestamp()] });
    }
    return;
  }

  // ── Look up the code ──────────────────────────────────────────────────────
  const deposit = lookupCode(depositCode);

  if (!deposit) {
    console.log(`⚠️  Unknown code: ${depositCode}`);
    if (channel) {
      await channel.send({ embeds: [new EmbedBuilder()
        .setColor(0xF44336)
        .setTitle('❌ Unknown Deposit Code!')
        .addFields(
          { name: 'Code', value: depositCode, inline: true },
          { name: 'Platform', value: platform, inline: true },
          { name: 'Amount', value: `$${amount.toFixed(2)}`, inline: true },
          { name: 'Sender', value: senderName, inline: true },
        )
        .setFooter({ text: 'This code was not generated by the bot.' })
        .setTimestamp()] });
    }
    return;
  }

  if (deposit.status === 'paid') {
    console.log(`⚠️  Code ${depositCode} already used!`);
    if (channel) {
      await channel.send({ embeds: [new EmbedBuilder()
        .setColor(0xF44336)
        .setTitle('⚠️ Deposit Code Already Used!')
        .setDescription(`Code \`${depositCode}\` was already paid on ${new Date(deposit.paidAt).toLocaleDateString()}.`)
        .addFields(
          { name: 'Sender', value: senderName, inline: true },
          { name: 'Amount', value: `$${amount.toFixed(2)}`, inline: true },
        )
        .setTimestamp()] });
    }
    return;
  }

  // ── Valid! Mark paid and update balance ───────────────────────────────────
  markPaid(depositCode, { amount, platform, senderName });
  const balanceKey = `discord_${deposit.discordId}`;
  const newBalance = addBalance(balanceKey, amount);
  logTx({ type: 'auto_deposit', platform, senderName, discordId: deposit.discordId, depositCode, amount, newBalance });

  console.log(`💰 Deposit matched! ${deposit.username} | ${depositCode} | $${amount} via ${platform}`);

  if (channel) {
    const amountWarning = deposit.expectedAmount && Math.abs(deposit.expectedAmount - amount) > 0.01
      ? `\n⚠️ Expected $${deposit.expectedAmount.toFixed(2)} but received $${amount.toFixed(2)}`
      : '';

    await channel.send({ embeds: [new EmbedBuilder()
      .setColor(style.color)
      .setTitle(`${style.emoji} Deposit Confirmed via ${platform}!`)
      .addFields(
        { name: 'User', value: `<@${deposit.discordId}>`, inline: true },
        { name: 'Amount', value: `$${amount.toFixed(2)}`, inline: true },
        { name: 'New Balance', value: `$${newBalance.toFixed(2)}`, inline: true },
        { name: 'Code', value: `\`${depositCode}\``, inline: true },
        { name: 'Sender Name', value: senderName, inline: true },
      )
      .setDescription(amountWarning || null)
      .setFooter({ text: '🤖 Auto-detected via Gmail' })
      .setTimestamp()] });
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

    const embed = new EmbedBuilder()
      .setColor(0x00C853)
      .setTitle('🔑 New Deposit Code Generated!')
      .setDescription('Put this code in the **memo/note** when you send the payment:')
      .addFields(
        { name: '📋 Your Code', value: `\`\`\`${deposit.code}\`\`\``, },
        { name: '💰 Expected Amount', value: expectedAmount ? `$${expectedAmount.toFixed(2)}` : 'Any amount', inline: true },
        { name: '📅 Expires', value: 'Never (until used)', inline: true },
      )
      .addFields({ name: 'Where to put it', value:
        `> **PayPal** → Add a note: \`${deposit.code}\`\n` +
        `> **Venmo** → Add a note: \`${deposit.code}\`\n` +
        `> **Cash App** → Add a note: \`${deposit.code}\`\n` +
        `> **Zelle** → Add a memo: \`${deposit.code}\`\n` +
        `> **Chime** → Add a note: \`${deposit.code}\``
      })
      .setFooter({ text: 'This code is single-use. Run /newdeposit again for your next payment.' })
      .setTimestamp();

    // Ephemeral — only they see their code
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /mypending ────────────────────────────────────────────────────────────
  if (commandName === 'mypending') {
    const pending = getPendingForUser(interaction.user.id);
    if (!pending.length) {
      return interaction.reply({ content: '✅ You have no pending deposit codes. Run `/newdeposit` to create one!', ephemeral: true });
    }
    const lines = pending.map(d =>
      `\`${d.code}\` — ${d.expectedAmount ? `$${d.expectedAmount.toFixed(2)}` : 'Any amount'} — Created ${new Date(d.createdAt).toLocaleDateString()}`
    );
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder()
      .setColor(0xFF9800)
      .setTitle('⏳ Your Pending Deposit Codes')
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'These codes are waiting for payment. Put the code in your payment memo!' })
      .setTimestamp()] });
  }

  // ── /myhistory ────────────────────────────────────────────────────────────
  if (commandName === 'myhistory') {
    const all = getAllForUser(interaction.user.id);
    if (!all.length) {
      return interaction.reply({ content: 'You have no deposit history yet. Run `/newdeposit` to get started!', ephemeral: true });
    }
    const lines = all.slice(0, 15).map(d => {
      const icon = d.status === 'paid' ? '✅' : '⏳';
      const amount = d.amount ? `$${d.amount.toFixed(2)}` : (d.expectedAmount ? `$${d.expectedAmount.toFixed(2)} expected` : 'Any');
      const date = d.status === 'paid'
        ? new Date(d.paidAt).toLocaleDateString()
        : `Created ${new Date(d.createdAt).toLocaleDateString()}`;
      return `${icon} \`${d.code}\` — ${amount} — ${d.platform ?? 'Pending'} — ${date}`;
    });
    const balance = getBalance(`discord_${interaction.user.id}`);
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder()
      .setColor(0x2196F3)
      .setTitle('📋 Your Deposit History')
      .setDescription(lines.join('\n'))
      .addFields({ name: '💳 Current Balance', value: `$${balance.toFixed(2)}` })
      .setTimestamp()] });
  }

  // ── /balance ──────────────────────────────────────────────────────────────
  if (commandName === 'balance') {
    const targetUser = interaction.options.getUser('user') ?? interaction.user;
    const balance = getBalance(`discord_${targetUser.id}`);
    const pending = getPendingForUser(targetUser.id);
    return interaction.reply({ embeds: [new EmbedBuilder()
      .setColor(0x2196F3)
      .setTitle('💳 Balance')
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: 'User', value: `<@${targetUser.id}>`, inline: true },
        { name: 'Balance', value: `$${balance.toFixed(2)}`, inline: true },
        { name: 'Pending Codes', value: `${pending.length}`, inline: true },
      )
      .setTimestamp()] });
  }

  // ── /pending (admin) ──────────────────────────────────────────────────────
  if (commandName === 'pending') {
    if (!interaction.member.permissions.has('Administrator'))
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const all = getAllPending();
    if (!all.length) return interaction.reply({ content: '✅ No pending deposit codes.', ephemeral: true });
    const lines = all.map(d =>
      `\`${d.code}\` — <@${d.discordId}> — ${d.expectedAmount ? `$${d.expectedAmount.toFixed(2)}` : 'Any'} — ${new Date(d.createdAt).toLocaleDateString()}`
    );
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder()
      .setColor(0xFF9800)
      .setTitle(`⏳ All Pending Codes (${all.length})`)
      .setDescription(lines.join('\n'))
      .setTimestamp()] });
  }

  // ── /withdraw ─────────────────────────────────────────────────────────────
  if (commandName === 'withdraw') {
    if (!interaction.member.permissions.has('Administrator'))
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const amount = interaction.options.getNumber('amount');
    const newBalance = addBalance(`discord_${targetUser.id}`, -amount);
    logTx({ type: 'withdraw', discordId: targetUser.id, amount, newBalance });
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFF5722)
      .setTitle('📤 Withdrawal')
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
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x9C27B0)
      .setTitle('✏️ Balance Set')
      .addFields({ name: `<@${targetUser.id}>`, value: `$${amount.toFixed(2)}` })
      .setTimestamp()] });
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

  // ── /history ──────────────────────────────────────────────────────────────
  if (commandName === 'history') {
    if (!interaction.member.permissions.has('Administrator'))
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const log = getLog(10);
    if (!log.length) return interaction.reply({ content: 'No transactions yet.', ephemeral: true });
    const lines = log.map(t => {
      const icon = t.type.includes('deposit') ? '💚' : '🔴';
      return `${icon} <@${t.discordId}> | $${t.amount.toFixed(2)} | ${t.platform ?? 'Manual'} | \`${t.depositCode ?? '—'}\` | ${new Date(t.timestamp).toLocaleDateString()}`;
    });
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x607D8B)
      .setTitle('📋 Recent Transactions').setDescription(lines.join('\n')).setTimestamp()] });
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
