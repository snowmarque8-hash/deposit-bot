const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { readDB, writeDB } = require('../utils/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('waitlist')
    .setDescription('Join a waitlist for an out-of-stock item')
    .addSubcommand(sub => sub
      .setName('join')
      .setDescription('Join a waitlist')
      .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName('leave')
      .setDescription('Leave a waitlist')
      .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName('view')
      .setDescription('View who is on a waitlist (staff)')
      .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true))
    ),

  async execute(interaction, client) {
    const sub  = interaction.options.getSubcommand();
    const item = interaction.options.getString('item').toLowerCase();
    const db   = readDB('waitlist');

    if (!db.waitlist[item]) db.waitlist[item] = [];

    if (sub === 'join') {
      if (db.waitlist[item].includes(interaction.user.id)) {
        return interaction.reply({ content: `⚠️ You're already on the waitlist for **${item}**.`, ephemeral: true });
      }
      db.waitlist[item].push(interaction.user.id);
      writeDB('waitlist', db);
      await interaction.reply({ content: `✅ Added to waitlist for **${item}**! You'll be DM'd when it's restocked.`, ephemeral: true });
    }

    else if (sub === 'leave') {
      const idx = db.waitlist[item].indexOf(interaction.user.id);
      if (idx === -1) return interaction.reply({ content: `❌ You're not on the waitlist for **${item}**.`, ephemeral: true });
      db.waitlist[item].splice(idx, 1);
      writeDB('waitlist', db);
      await interaction.reply({ content: `✅ Removed from waitlist for **${item}**.`, ephemeral: true });
    }

    else if (sub === 'view') {
      const list = db.waitlist[item];
      if (!list || list.length === 0) {
        return interaction.reply({ content: `📭 No one on the waitlist for **${item}**.`, ephemeral: true });
      }

      const mentions = list.map((id, i) => `${i + 1}. <@${id}>`).join('\n');
      const embed = new EmbedBuilder()
        .setTitle(`📋 Waitlist — ${item}`)
        .setColor(0xe67e22)
        .setDescription(mentions)
        .setFooter({ text: `${list.length} user(s) waiting` })
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }
};
