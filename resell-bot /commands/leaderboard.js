const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { readDB } = require('../utils/db');
const config = require('../config.json');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View employee leaderboard')
    .addStringOption(o => o.setName('category').setDescription('What to rank by').setRequired(true)
      .addChoices(
        { name: 'Most Orders Completed', value: 'orders' },
        { name: 'Most Revenue Generated', value: 'revenue' },
        { name: 'Most Invite Referrals', value: 'invites' },
        { name: 'Fastest Avg Completion', value: 'speed' },
      ))
    .addStringOption(o => o.setName('period').setDescription('Time period').setRequired(true)
      .addChoices(
        { name: 'Weekly',   value: 'weekly' },
        { name: 'Monthly',  value: 'monthly' },
        { name: 'All Time', value: 'alltime' },
      )),

  async execute(interaction, client) {
    const category = interaction.options.getString('category');
    const period   = interaction.options.getString('period');

    const empDB    = readDB('employees');
    const ordersDB = readDB('orders');
    const invDB    = readDB('invites');

    const now  = Date.now();
    const ms   = period === 'weekly'  ? 7 * 86400000
               : period === 'monthly' ? 30 * 86400000
               : Infinity;

    const cutoff = now - ms;

    // Filter orders by period
    const periodOrders = ordersDB.orders.filter(o =>
      o.status === 'Completed' && (period === 'alltime' || o.completedAt >= cutoff)
    );

    let entries = [];

    if (category === 'orders') {
      const counts = {};
      for (const o of periodOrders) {
        counts[o.employeeId] = (counts[o.employeeId] || 0) + 1;
      }
      entries = Object.entries(counts)
        .map(([id, val]) => ({ id, val }))
        .sort((a, b) => b.val - a.val);
    }

    else if (category === 'revenue') {
      const rev = {};
      for (const o of periodOrders) {
        rev[o.employeeId] = (rev[o.employeeId] || 0) + o.price;
      }
      entries = Object.entries(rev)
        .map(([id, val]) => ({ id, val: `$${val.toFixed(2)}` }))
        .sort((a, b) => parseFloat(b.val.slice(1)) - parseFloat(a.val.slice(1)));
    }

    else if (category === 'invites') {
      entries = Object.entries(invDB.invites)
        .map(([id, data]) => ({ id, val: data.valid }))
        .sort((a, b) => b.val - a.val);
    }

    else if (category === 'speed') {
      const times = {};
      const counts = {};
      for (const o of periodOrders) {
        if (!o.completedAt || !o.createdAt) continue;
        const hrs = (o.completedAt - o.createdAt) / 3600000;
        times[o.employeeId]  = (times[o.employeeId]  || 0) + hrs;
        counts[o.employeeId] = (counts[o.employeeId] || 0) + 1;
      }
      entries = Object.entries(times)
        .map(([id, totalHrs]) => ({
          id,
          val: `${(totalHrs / counts[id]).toFixed(1)}h avg`,
          raw: totalHrs / counts[id],
        }))
        .sort((a, b) => a.raw - b.raw); // faster = lower time = better
    }

    if (entries.length === 0) {
      return interaction.reply({ content: '📭 No data for this leaderboard yet.', ephemeral: true });
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines = await Promise.all(
      entries.slice(0, 10).map(async (entry, i) => {
        const medal = medals[i] || `**#${i + 1}**`;
        try {
          const user = await client.users.fetch(entry.id);
          return `${medal} ${user.username} — **${entry.val}**`;
        } catch {
          return `${medal} <@${entry.id}> — **${entry.val}**`;
        }
      })
    );

    const titles = {
      orders:  '📦 Most Orders Completed',
      revenue: '💰 Most Revenue Generated',
      invites: '📨 Most Invite Referrals',
      speed:   '⚡ Fastest Order Completion',
    };

    const embed = new EmbedBuilder()
      .setTitle(`${titles[category]} — ${period.charAt(0).toUpperCase() + period.slice(1)}`)
      .setColor(0xf1c40f)
      .setDescription(lines.join('\n'))
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }
};
