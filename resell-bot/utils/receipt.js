const { EmbedBuilder } = require('discord.js');

function generateReceipt(order) {
  const statusEmojis = {
    Pending:   '🕐',
    Paid:      '💰',
    Sourcing:  '🔍',
    Shipped:   '📦',
    Delivered: '🚚',
    Completed: '✅',
  };

  const emoji = statusEmojis[order.status] || '❓';

  const embed = new EmbedBuilder()
    .setTitle('🧾 Order Receipt')
    .setColor(0x2ecc71)
    .setThumbnail('https://i.imgur.com/placeholder.png') // replace with your logo
    .addFields(
      { name: '📋 Order ID',        value: `\`ORDER-${order.id}\``,         inline: true },
      { name: '👤 Customer',        value: `<@${order.customerId}>`,        inline: true },
      { name: '🛍️ Item',            value: order.item,                      inline: true },
      { name: '💵 Price',           value: `$${order.price}`,               inline: true },
      { name: '💳 Payment Status',  value: order.paymentStatus,             inline: true },
      { name: `${emoji} Status`,    value: order.status,                    inline: true },
      { name: '👷 Employee',        value: `<@${order.employeeId}>`,        inline: true },
      { name: '📅 Date',            value: new Date(order.createdAt).toLocaleDateString(), inline: true },
    )
    .setFooter({ text: 'Thank you for your order!' })
    .setTimestamp();

  if (order.notes) embed.addFields({ name: '📝 Notes', value: order.notes });

  return embed;
}

module.exports = { generateReceipt };
