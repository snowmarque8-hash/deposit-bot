const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { readDB, writeDB } = require('../utils/db');
const config = require('../config.json');
const { isStaff, isMod, isAdmin } = require('../utils/perms');

function parseDuration(str) {
  const match = str.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2];
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return val * mult[unit];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Manage giveaways')
    .addSubcommand(sub => sub
      .setName('start')
      .setDescription('Start a giveaway')
      .addStringOption(o => o.setName('prize').setDescription('Prize').setRequired(true))
      .addStringOption(o => o.setName('duration').setDescription('Duration e.g. 1h, 30m, 2d').setRequired(true))
      .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('ping').setDescription('Ping role name from config'))
    )
    .addSubcommand(sub => sub
      .setName('end')
      .setDescription('End a giveaway early')
      .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName('reroll')
      .setDescription('Reroll winners')
      .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true))
    ),

  async execute(interaction, client) {
    const allowed = isMod(interaction.member);
    if (!allowed) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });

    const sub = interaction.options.getSubcommand();

    if (sub === 'start') {
      const prize    = interaction.options.getString('prize');
      const durStr   = interaction.options.getString('duration');
      const winners  = interaction.options.getInteger('winners');
      const pingKey  = interaction.options.getString('ping');

      const duration = parseDuration(durStr);
      if (!duration) return interaction.reply({ content: '❌ Invalid duration. Use e.g. `1h`, `30m`, `2d`.', ephemeral: true });

      const endsAt = Date.now() + duration;
      const endsDate = new Date(endsAt);

      const embed = new EmbedBuilder()
        .setTitle('🎉 GIVEAWAY!')
        .setColor(0xf1c40f)
        .setDescription(`React with 🎉 to enter!\n\n**Prize:** ${prize}\n**Winners:** ${winners}\n**Ends:** <t:${Math.floor(endsAt / 1000)}:R>`)
        .setFooter({ text: `Ends at ${endsDate.toUTCString()}` })
        .setTimestamp(endsDate);

      let pingContent = '';
      if (pingKey && config.pingRoles?.[pingKey]) {
        pingContent = `<@&${config.pingRoles[pingKey]}>`;
      }

      const channel = interaction.channel;
      const msg = await channel.send({ content: pingContent || undefined, embeds: [embed] });
      await msg.react('🎉');

      // Save giveaway
      const db = readDB('giveaways');
      db.giveaways.push({
        messageId: msg.id,
        channelId: channel.id,
        prize,
        winners,
        endsAt,
        ended: false,
        winnerIds: [],
      });
      writeDB('giveaways', db);

      await interaction.reply({ content: `✅ Giveaway started! [Jump to message](${msg.url})`, ephemeral: true });
    }

    else if (sub === 'end') {
      const msgId = interaction.options.getString('message_id');
      const db = readDB('giveaways');
      const ga = db.giveaways.find(g => g.messageId === msgId && !g.ended);

      if (!ga) return interaction.reply({ content: '❌ Giveaway not found or already ended.', ephemeral: true });

      ga.endsAt = Date.now(); // trigger the checker on next cycle
      writeDB('giveaways', db);
      await interaction.reply({ content: '✅ Giveaway will end on the next check cycle (within 15 seconds).', ephemeral: true });
    }

    else if (sub === 'reroll') {
      const msgId = interaction.options.getString('message_id');
      const db = readDB('giveaways');
      const ga = db.giveaways.find(g => g.messageId === msgId && g.ended);

      if (!ga) return interaction.reply({ content: '❌ Ended giveaway not found.', ephemeral: true });

      try {
        const channel = await client.channels.fetch(ga.channelId);
        const message = await channel.messages.fetch(ga.messageId);
        const reaction = message.reactions.cache.get('🎉');
        const users = await reaction?.users.fetch();
        const eligible = users?.filter(u => !u.bot && !ga.winnerIds.includes(u.id)).map(u => u.id) || [];

        if (eligible.length === 0) {
          return interaction.reply({ content: '❌ No eligible users to reroll.', ephemeral: true });
        }

        const newWinner = eligible[Math.floor(Math.random() * eligible.length)];
        await channel.send(`🎉 **Reroll!** The new winner is <@${newWinner}>! Congratulations!`);
        await interaction.reply({ content: '✅ Rerolled!', ephemeral: true });
      } catch (err) {
        await interaction.reply({ content: `❌ Error: ${err.message}`, ephemeral: true });
      }
    }
  }
};
