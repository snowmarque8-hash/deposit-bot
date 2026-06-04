const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { readDB } = require('../utils/db');
const config = require('../config.json');
const { isStaff, isMod, isAdmin } = require('../utils/perms');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('View employee stats dashboard')
    .addUserOption(o => o.setName('employee').setDescription('Employee to view (defaults to yourself)')),

  async execute(interaction, client) {
    const target = interaction.options.getUser('employee') || interaction.user;
    const staff = isStaff(interaction.member);

    // Non-staff can only view their own stats
    if (!staff && target.id !== interaction.user.id) {
      return interaction.reply({ content: '❌ You can only view your own stats.', ephemeral: true });
    }

    const ordersDB = readDB('orders');
    const vouchDB  = readDB('vouches');
    const invDB    = readDB('invites');

    const allOrders     = ordersDB.orders.filter(o => o.employeeId === target.id);
    const completed     = allOrders.filter(o => o.status === 'Completed');
    const pending       = allOrders.filter(o => !['Completed'].includes(o.status));
    const totalRevenue  = completed.reduce((sum, o) => sum + o.price, 0);
    const vouches       = vouchDB.vouches.filter(v => v.employeeId === target.id);
    const avgRating     = vouches.length
      ? (vouches.reduce((s, v) => s + v.rating, 0) / vouches.length).toFixed(1)
      : 'N/A';
    const inviteData    = invDB.invites[target.id];

    // Avg completion time
    let avgCompTime = 'N/A';
    const timed = completed.filter(o => o.completedAt && o.createdAt);
    if (timed.length > 0) {
      const avgMs = timed.reduce((sum, o) => sum + (o.completedAt - o.createdAt), 0) / timed.length;
      const hrs = (avgMs / 3600000).toFixed(1);
      avgCompTime = `${hrs}h`;
    }

    // Weekly completed
    const weekCutoff = Date.now() - 7 * 86400000;
    const weeklyCompleted = completed.filter(o => o.completedAt >= weekCutoff).length;

    const embed = new EmbedBuilder()
      .setTitle(`📊 Staff Dashboard — ${target.username}`)
      .setColor(0x3498db)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: '📦 Total Orders',     value: `${allOrders.length}`,        inline: true },
        { name: '✅ Completed',         value: `${completed.length}`,        inline: true },
        { name: '🕐 Active/Pending',    value: `${pending.length}`,          inline: true },
        { name: '💰 Total Revenue',     value: `$${totalRevenue.toFixed(2)}`, inline: true },
        { name: '⚡ Avg Completion',    value: avgCompTime,                  inline: true },
        { name: '📅 Completed (7d)',    value: `${weeklyCompleted}`,         inline: true },
        { name: '⭐ Avg Vouch Rating',  value: `${avgRating}/5`,             inline: true },
        { name: '💬 Total Vouches',     value: `${vouches.length}`,          inline: true },
        { name: '📨 Invites',           value: inviteData ? `${inviteData.valid} valid` : '0', inline: true },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: !staff });
  }
};
