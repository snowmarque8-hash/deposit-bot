const { readDB, writeDB } = require('./db');
const { EmbedBuilder } = require('discord.js');

function startGiveawayChecker(client) {
  setInterval(async () => {
    const db = readDB('giveaways');
    const now = Date.now();

    for (const giveaway of db.giveaways) {
      if (giveaway.ended || giveaway.endsAt > now) continue;

      giveaway.ended = true;

      try {
        const channel = await client.channels.fetch(giveaway.channelId);
        const message = await channel.messages.fetch(giveaway.messageId);

        const reaction = message.reactions.cache.get('🎉');
        const users = await reaction?.users.fetch();
        const eligible = users?.filter(u => !u.bot).map(u => u.id) || [];

        if (eligible.length === 0) {
          await channel.send(`🎉 Giveaway for **${giveaway.prize}** ended — no valid entries!`);
        } else {
          const winners = [];
          const pool = [...eligible];
          for (let i = 0; i < Math.min(giveaway.winners, pool.length); i++) {
            const idx = Math.floor(Math.random() * pool.length);
            winners.push(pool.splice(idx, 1)[0]);
          }

          giveaway.winnerIds = winners;

          const winnerMentions = winners.map(id => `<@${id}>`).join(', ');
          const embed = new EmbedBuilder()
            .setTitle('🎉 Giveaway Ended!')
            .setColor(0xf1c40f)
            .addFields(
              { name: '🏆 Prize',   value: giveaway.prize,   inline: true },
              { name: '🥇 Winners', value: winnerMentions,   inline: true },
            )
            .setTimestamp();

          await channel.send({ content: `Congratulations ${winnerMentions}!`, embeds: [embed] });
        }
      } catch (err) {
        console.error('Giveaway check error:', err);
      }
    }

    writeDB('giveaways', db);
  }, 15000); // check every 15 seconds
}

module.exports = { startGiveawayChecker };
