const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { readDB } = require('../utils/db');
const config = require('../config.json');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Check invite stats')
    .addSubcommand(sub => sub
      .setName('check')
      .setDescription('Check invite count for a user')
      .addUserOption(o => o.setName('user').setDescription('User to check (defaults to yourself)'))
    )
    .addSubcommand(sub => sub
      .setName('leaderboard')
      .setDescription('Top inviters on the server')
    ),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const db = readDB('invites');

    if (sub === 'check') {
      const target = interaction.options.getUser('user') || interaction.user;
      const data = db.invites[target.id];

      if (!data) {
        return interaction.reply({ content: `📭 No invite data found for ${target.username}.`, ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle(`📨 Invites — ${target.username}`)
        .setColor(0x3498db)
        .addFields(
          { name: 'Total Invites', value: `${data.total}`,  inline: true },
          { name: 'Valid (stayed)', value: `${data.valid}`, inline: true },
          { name: 'Left Server',   value: `${data.left}`,  inline: true },
        )
        .setThumbnail(target.displayAvatarURL())
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }

    else if (sub === 'leaderboard') {
      const entries = Object.entries(db.invites)
        .map(([id, data]) => ({ id, valid: data.valid, total: data.total }))
        .sort((a, b) => b.valid - a.valid)
        .slice(0, 10);

      if (entries.length === 0) {
        return interaction.reply({ content: '📭 No invite data yet.', ephemeral: true });
      }

      const medals = ['🥇', '🥈', '🥉'];
      const lines = await Promise.all(entries.map(async (e, i) => {
        const medal = medals[i] || `**#${i + 1}**`;
        try {
          const user = await client.users.fetch(e.id);
          return `${medal} ${user.username} — **${e.valid} valid** (${e.total} total)`;
        } catch {
          return `${medal} <@${e.id}> — **${e.valid} valid** (${e.total} total)`;
        }
      }));

      const embed = new EmbedBuilder()
        .setTitle('📨 Invite Leaderboard')
        .setColor(0x9b59b6)
        .setDescription(lines.join('\n'))
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }
  }
};
