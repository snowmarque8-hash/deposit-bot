const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../config.json');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('faq')
    .setDescription('Get answers to common questions')
    .addStringOption(o => o.setName('topic').setDescription('What do you need help with?').setRequired(true)
      .addChoices(
        { name: '📦 Shipping',    value: 'shipping' },
        { name: '💸 Refunds',     value: 'refunds' },
        { name: '📋 Rules',       value: 'rules' },
        { name: '💰 Prices',      value: 'prices' },
        { name: '🤝 Middleman',   value: 'middleman' },
      )),

  async execute(interaction) {
    const topic = interaction.options.getString('topic');
    const faq = config.faq || {};
    const answer = faq[topic];

    const emojis = {
      shipping:   '📦',
      refunds:    '💸',
      rules:      '📋',
      prices:     '💰',
      middleman:  '🤝',
    };

    if (!answer) {
      return interaction.reply({ content: '❌ No answer found for that topic.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle(`${emojis[topic]} ${topic.charAt(0).toUpperCase() + topic.slice(1)}`)
      .setColor(0x3498db)
      .setDescription(answer)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
};
