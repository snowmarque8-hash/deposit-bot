const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../config.json');
const { isStaff, isMod, isAdmin } = require('../utils/perms');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Send a clean announcement embed')
    .addStringOption(o => o.setName('title').setDescription('Announcement title').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Announcement body').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('Type of announcement').setRequired(true)
      .addChoices(
        { name: '📦 Drop',         value: 'drop' },
        { name: '🔄 Restock',      value: 'restock' },
        { name: '🎉 Giveaway',     value: 'giveaway' },
        { name: '📋 Rules',        value: 'rules' },
        { name: '📣 General',      value: 'general' },
        { name: '🏆 Contest',      value: 'contest' },
        { name: '💰 Deal',         value: 'deal' },
      ))
    .addStringOption(o => o.setName('image').setDescription('Image URL (optional)'))
    .addStringOption(o => o.setName('ping').setDescription('Role to ping (optional, use role name from config)'))
    .addStringOption(o => o.setName('footer').setDescription('Footer text (optional)')),

  async execute(interaction, client) {
    const allowed = isMod(interaction.member);
    if (!allowed) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });

    const title   = interaction.options.getString('title');
    const message = interaction.options.getString('message');
    const type    = interaction.options.getString('type');
    const image   = interaction.options.getString('image');
    const pingKey = interaction.options.getString('ping');
    const footer  = interaction.options.getString('footer');

    const colors = {
      drop:     0xe74c3c,
      restock:  0x2ecc71,
      giveaway: 0xf1c40f,
      rules:    0x3498db,
      general:  0x95a5a6,
      contest:  0x9b59b6,
      deal:     0xe67e22,
    };

    const typeEmojis = {
      drop:     '📦',
      restock:  '🔄',
      giveaway: '🎉',
      rules:    '📋',
      general:  '📣',
      contest:  '🏆',
      deal:     '💰',
    };

    const embed = new EmbedBuilder()
      .setTitle(`${typeEmojis[type]} ${title}`)
      .setDescription(message)
      .setColor(colors[type] || 0x3498db)
      .setTimestamp();

    if (image) embed.setImage(image);
    if (footer) embed.setFooter({ text: footer });

    // Determine ping
    let pingContent = '';
    if (pingKey) {
      const roleId = config.pingRoles?.[pingKey];
      if (roleId) pingContent = `<@&${roleId}>`;
    }

    try {
      const announceCh = await client.channels.fetch(config.announcementChannelId);
      await announceCh.send({ content: pingContent || undefined, embeds: [embed] });
      await interaction.reply({ content: '✅ Announcement sent!', ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: `❌ Failed to send: ${err.message}`, ephemeral: true });
    }
  }
};
