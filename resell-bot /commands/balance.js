const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getDepositBalance, getUserDepositHistory } = require('../utils/bridge');
const { readDB } = require('../utils/db');
const config = require('../config.json');
const { isStaff, isMod, isAdmin } = require('../utils/perms');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check a customer\'s deposit bot balance')
    .addUserOption(o => o.setName('user').setDescription('User to check').setRequired(true)),

  async execute(interaction, client) {
    const allowed = isStaff(interaction.member);
    if (!allowed) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });

    const target = interaction.options.getUser('user');

    // Pull balance from deposit bot's balances.json
    const balance = getDepositBalance(target.id);

    // Pull deposit history from deposit bot's deposits.json
    const deposits = getUserDepositHistory(target.id);
    const paidDeposits = deposits.filter(d => d.status === 'paid');
    const totalDeposited = paidDeposits.reduce((sum, d) => sum + (d.amount || 0), 0);

    // Pull resell order history from resell bot's orders.json
    const ordersDB = readDB('orders');
    const orders = ordersDB.orders.filter(o => o.customerId === target.id);
    const totalSpent = orders.filter(o => o.status === 'Completed').reduce((sum, o) => sum + o.price, 0);

    const recentDeposits = paidDeposits.slice(0, 5).map(d =>
      `\`${d.code}\` — $${d.amount?.toFixed(2)} via ${d.platform || 'Unknown'} — <t:${Math.floor(new Date(d.paidAt).getTime() / 1000)}:d>`
    );

    const embed = new EmbedBuilder()
      .setTitle(`💰 Balance — ${target.username}`)
      .setColor(balance > 0 ? 0x2ecc71 : 0x95a5a6)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: '💵 Current Balance',    value: balance !== null ? `$${balance.toFixed(2)}` : '⚠️ Deposit bot not connected', inline: true },
        { name: '📥 Total Deposited',    value: `$${totalDeposited.toFixed(2)}`,  inline: true },
        { name: '🛍️ Total Spent (Orders)', value: `$${totalSpent.toFixed(2)}`,   inline: true },
        { name: '📦 Resell Orders',      value: `${orders.length}`,              inline: true },
        { name: '💳 Deposit Count',      value: `${paidDeposits.length}`,        inline: true },
      );

    if (recentDeposits.length > 0) {
      embed.addFields({ name: '🕐 Recent Deposits', value: recentDeposits.join('\n') });
    }

    if (balance === null) {
      embed.setFooter({ text: '⚠️ Could not reach deposit bot — check depositBotDataPath in config.json' });
    } else {
      embed.setFooter({ text: 'Balance pulled live from deposit bot' });
    }

    embed.setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
};
