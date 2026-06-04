const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../config.json');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Show payment methods'),

  async execute(interaction) {
    const methods = config.paymentMethods || {};
    const lines = Object.entries(methods).map(([method, info]) => `**${method}:** \`${info}\``);

    const embed = new EmbedBuilder()
      .setTitle('💳 Payment Methods')
      .setColor(0x2ecc71)
      .setDescription(lines.join('\n') || 'No payment methods configured.')
      .setFooter({ text: 'Do NOT send payment until your order is confirmed by staff.' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
};
