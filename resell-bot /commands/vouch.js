const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { readDB, writeDB } = require('../utils/db');
const config = require('../config.json');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('vouch')
    .setDescription('Leave a review for an employee')
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('Leave a vouch')
      .addUserOption(o => o.setName('employee').setDescription('Employee to vouch').setRequired(true))
      .addIntegerOption(o => o.setName('rating').setDescription('Rating 1-5').setRequired(true)
        .setMinValue(1).setMaxValue(5))
      .addStringOption(o => o.setName('comment').setDescription('Your review').setRequired(true))
      .addStringOption(o => o.setName('order_id').setDescription('Order ID (optional)'))
    )
    .addSubcommand(sub => sub
      .setName('check')
      .setDescription('View vouches for an employee')
      .addUserOption(o => o.setName('employee').setDescription('Employee').setRequired(true))
    ),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const employee = interaction.options.getUser('employee');
      const rating   = interaction.options.getInteger('rating');
      const comment  = interaction.options.getString('comment');
      const orderId  = interaction.options.getString('order_id');

      if (employee.id === interaction.user.id) {
        return interaction.reply({ content: '❌ You cannot vouch for yourself.', ephemeral: true });
      }

      const db = readDB('vouches');
      const stars = '⭐'.repeat(rating) + '☆'.repeat(5 - rating);

      const vouch = {
        id:         db.vouches.length + 1,
        employeeId: employee.id,
        authorId:   interaction.user.id,
        rating,
        comment,
        orderId:    orderId || null,
        createdAt:  Date.now(),
      };

      db.vouches.push(vouch);
      writeDB('vouches', db);

      const embed = new EmbedBuilder()
        .setTitle('⭐ New Vouch!')
        .setColor(0xf1c40f)
        .addFields(
          { name: 'Employee', value: `<@${employee.id}>`,          inline: true },
          { name: 'From',     value: `<@${interaction.user.id}>`,  inline: true },
          { name: 'Rating',   value: stars,                         inline: true },
          { name: 'Review',   value: comment },
        );

      if (orderId) embed.addFields({ name: 'Order ID', value: `ORDER-${orderId}`, inline: true });

      await interaction.reply({ embeds: [embed] });

      // Post to vouch channel
      try {
        const vouchCh = await client.channels.fetch(config.vouchChannelId);
        await vouchCh.send({ embeds: [embed] });
      } catch {}
    }

    else if (sub === 'check') {
      const employee = interaction.options.getUser('employee');
      const db = readDB('vouches');
      const vouches = db.vouches.filter(v => v.employeeId === employee.id);

      if (vouches.length === 0) {
        return interaction.reply({ content: `📭 No vouches yet for ${employee.username}.`, ephemeral: true });
      }

      const avg = (vouches.reduce((sum, v) => sum + v.rating, 0) / vouches.length).toFixed(1);
      const recent = vouches.slice(-5).reverse().map(v => {
        const stars = '⭐'.repeat(v.rating);
        return `${stars} — ${v.comment} — <@${v.authorId}>`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`⭐ Vouches — ${employee.username}`)
        .setColor(0xf1c40f)
        .setThumbnail(employee.displayAvatarURL())
        .addFields(
          { name: 'Total Vouches', value: `${vouches.length}`, inline: true },
          { name: 'Avg Rating',    value: `${avg}/5`,           inline: true },
          { name: 'Recent Reviews', value: recent.join('\n') || 'None' },
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }
  }
};
