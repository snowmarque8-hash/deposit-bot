const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../config.json');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pingroles')
    .setDescription('Manage your notification ping roles')
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('Add a ping role')
      .addStringOption(o => {
        o.setName('role').setDescription('Category to get pinged for').setRequired(true);
        const roles = Object.keys(config.pingRoles || {});
        roles.forEach(r => o.addChoices({ name: r, value: r }));
        return o;
      })
    )
    .addSubcommand(sub => sub
      .setName('remove')
      .setDescription('Remove a ping role')
      .addStringOption(o => {
        o.setName('role').setDescription('Category to stop getting pinged for').setRequired(true);
        const roles = Object.keys(config.pingRoles || {});
        roles.forEach(r => o.addChoices({ name: r, value: r }));
        return o;
      })
    )
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('View all available ping roles')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      const roles = Object.keys(config.pingRoles || {});
      const embed = new EmbedBuilder()
        .setTitle('🔔 Available Ping Roles')
        .setColor(0x3498db)
        .setDescription(roles.map(r => `• **${r}**`).join('\n') || 'No ping roles configured.')
        .setFooter({ text: 'Use /pingroles add to subscribe' });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    const roleName = interaction.options.getString('role');
    const roleId = config.pingRoles?.[roleName];

    if (!roleId) return interaction.reply({ content: `❌ Role **${roleName}** not found in config.`, ephemeral: true });

    const member = interaction.member;

    if (sub === 'add') {
      if (member.roles.cache.has(roleId)) {
        return interaction.reply({ content: `⚠️ You already have the **${roleName}** ping role.`, ephemeral: true });
      }
      await member.roles.add(roleId);
      await interaction.reply({ content: `✅ You'll now be pinged for **${roleName}** updates!`, ephemeral: true });
    }

    else if (sub === 'remove') {
      if (!member.roles.cache.has(roleId)) {
        return interaction.reply({ content: `⚠️ You don't have the **${roleName}** ping role.`, ephemeral: true });
      }
      await member.roles.remove(roleId);
      await interaction.reply({ content: `✅ Removed **${roleName}** ping role.`, ephemeral: true });
    }
  }
};
