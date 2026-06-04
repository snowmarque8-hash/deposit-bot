const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { readDB, writeDB } = require('../utils/db');
const config = require('../config.json');
const { isStaff, isMod, isAdmin } = require('../utils/perms');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('scamreport')
    .setDescription('Report a suspicious user')
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('Log a scam report')
      .addUserOption(o => o.setName('user').setDescription('Suspicious user').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('What happened?').setRequired(true))
      .addStringOption(o => o.setName('evidence').setDescription('Evidence URL or description').setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName('view')
      .setDescription('View reports for a user')
      .addUserOption(o => o.setName('user').setDescription('User to check').setRequired(true))
    ),

  async execute(interaction, client) {
    const allowed = isStaff(interaction.member);
    if (!allowed) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });

    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const target   = interaction.options.getUser('user');
      const reason   = interaction.options.getString('reason');
      const evidence = interaction.options.getString('evidence');

      const db = readDB('scamreports');
      const report = {
        id:         db.reports.length + 1,
        targetId:   target.id,
        reporterId: interaction.user.id,
        reason,
        evidence,
        createdAt:  Date.now(),
      };
      db.reports.push(report);
      writeDB('scamreports', db);

      const embed = new EmbedBuilder()
        .setTitle('🚨 Scam Report Filed')
        .setColor(0xe74c3c)
        .addFields(
          { name: '👤 Reported User', value: `<@${target.id}> (${target.tag})`, inline: true },
          { name: '🕵️ Reported By',  value: `<@${interaction.user.id}>`,        inline: true },
          { name: '📝 Reason',        value: reason },
          { name: '🔗 Evidence',      value: evidence },
        )
        .setFooter({ text: `Report #${report.id}` })
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });

      try {
        const logCh = await client.channels.fetch(config.logChannelId);
        await logCh.send({ embeds: [embed] });
      } catch {}
    }

    else if (sub === 'view') {
      const target = interaction.options.getUser('user');
      const db = readDB('scamreports');
      const reports = db.reports.filter(r => r.targetId === target.id);

      if (reports.length === 0) {
        return interaction.reply({ content: `✅ No reports found for ${target.username}.`, ephemeral: true });
      }

      const lines = reports.map(r =>
        `**Report #${r.id}** — ${r.reason}\nEvidence: ${r.evidence}\nBy <@${r.reporterId}> on <t:${Math.floor(r.createdAt / 1000)}:D>`
      );

      const embed = new EmbedBuilder()
        .setTitle(`🚨 Reports — ${target.username}`)
        .setColor(0xe74c3c)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: `${reports.length} report(s) total` })
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }
};
