const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { readDB, writeDB } = require('../utils/db');
const config = require('../config.json');
const { isStaff, isMod } = require('../utils/perms');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stock')
    .setDescription('Manage inventory')
    .addSubcommand(sub => sub
      .setName('view')
      .setDescription('View current stock')
      .addStringOption(o => o.setName('category').setDescription('Filter by category'))
    )
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('Add item to stock')
      .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true))
      .addIntegerOption(o => o.setName('quantity').setDescription('Quantity').setRequired(true))
      .addNumberOption(o => o.setName('price').setDescription('Price').setRequired(true))
      .addStringOption(o => o.setName('category').setDescription('Category (Shoes, Electronics, etc.)'))
      .addStringOption(o => o.setName('description').setDescription('Item description'))
    )
    .addSubcommand(sub => sub
      .setName('update')
      .setDescription('Update stock quantity')
      .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true))
      .addIntegerOption(o => o.setName('quantity').setDescription('New quantity').setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName('remove')
      .setDescription('Remove item from stock')
      .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true))
    ),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const staff = isStaff(interaction.member);

    // ── VIEW STOCK ─────────────────────────────────────────────────────────
    if (sub === 'view') {
      const db = readDB('stock');
      const filterCat = interaction.options.getString('category')?.toLowerCase();
      let items = db.items.filter(i => i.quantity > 0);
      if (filterCat) items = items.filter(i => i.category?.toLowerCase().includes(filterCat));

      if (items.length === 0) {
        return interaction.reply({ content: '📭 No items in stock right now.', ephemeral: false });
      }

      // Group by category
      const grouped = {};
      for (const item of items) {
        const cat = item.category || 'Uncategorized';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(item);
      }

      const embed = new EmbedBuilder()
        .setTitle('🛍️ Current Stock')
        .setColor(0x2ecc71)
        .setTimestamp();

      for (const [cat, catItems] of Object.entries(grouped)) {
        const lines = catItems.map(i => {
          const stockLabel = i.quantity <= config.lowStockThreshold
            ? `⚠️ LOW (${i.quantity})`
            : `${i.quantity} in stock`;
          return `• **${i.name}** — $${i.price} — ${stockLabel}`;
        });
        embed.addFields({ name: `📁 ${cat}`, value: lines.join('\n') });
      }

      return interaction.reply({ embeds: [embed] });
    }

    // Staff-only below (add/update need support+, remove needs mod+)
    if (!staff) {
      return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
    }
    if (sub === 'remove' && !isMod(interaction.member)) {
      return interaction.reply({ content: '❌ Removing stock requires Mod or Admin.', ephemeral: true });
    }

    // ── ADD ITEM ───────────────────────────────────────────────────────────
    if (sub === 'add') {
      const name     = interaction.options.getString('name');
      const quantity = interaction.options.getInteger('quantity');
      const price    = interaction.options.getNumber('price');
      const category = interaction.options.getString('category') || 'Miscellaneous';
      const desc     = interaction.options.getString('description') || '';

      const db = readDB('stock');
      const existing = db.items.find(i => i.name.toLowerCase() === name.toLowerCase());

      if (existing) {
        existing.quantity += quantity;
        existing.price = price;
      } else {
        db.items.push({ name, quantity, price, category, description: desc, addedAt: Date.now() });
      }

      writeDB('stock', db);

      const embed = new EmbedBuilder()
        .setTitle('✅ Stock Updated')
        .setColor(0x2ecc71)
        .addFields(
          { name: 'Item',     value: name,       inline: true },
          { name: 'Qty',      value: `${quantity}`, inline: true },
          { name: 'Price',    value: `$${price}`, inline: true },
          { name: 'Category', value: category,   inline: true },
        );

      await interaction.reply({ embeds: [embed] });

      // Notify waitlist users
      const waitDB = readDB('waitlist');
      const waiters = waitDB.waitlist[name.toLowerCase()] || [];
      if (waiters.length > 0) {
        for (const userId of waiters) {
          try {
            const user = await client.users.fetch(userId);
            await user.send(`🔔 **${name}** is back in stock! Price: $${price}. Head to the server to order.`);
          } catch {}
        }
        waitDB.waitlist[name.toLowerCase()] = [];
        writeDB('waitlist', waitDB);
        await interaction.followUp({ content: `📣 Notified ${waiters.length} waitlist member(s) for **${name}**.`, ephemeral: true });
      }

      // Low stock ping in stock channel
      if (quantity <= config.lowStockThreshold) {
        try {
          const stockCh = await client.channels.fetch(config.stockChannelId);
          await stockCh.send(`⚠️ **Low Stock Alert:** **${name}** only has **${quantity}** left!`);
        } catch {}
      }
    }

    // ── UPDATE QUANTITY ────────────────────────────────────────────────────
    else if (sub === 'update') {
      const name     = interaction.options.getString('name');
      const quantity = interaction.options.getInteger('quantity');

      const db = readDB('stock');
      const item = db.items.find(i => i.name.toLowerCase() === name.toLowerCase());

      if (!item) return interaction.reply({ content: `❌ Item **${name}** not found in stock.`, ephemeral: true });

      item.quantity = quantity;
      writeDB('stock', db);

      await interaction.reply({ content: `✅ **${item.name}** quantity updated to **${quantity}**.` });

      if (quantity <= config.lowStockThreshold && quantity > 0) {
        try {
          const stockCh = await client.channels.fetch(config.stockChannelId);
          await stockCh.send(`⚠️ **Low Stock Alert:** **${name}** only has **${quantity}** left!`);
        } catch {}
      }
    }

    // ── REMOVE ITEM ────────────────────────────────────────────────────────
    else if (sub === 'remove') {
      const name = interaction.options.getString('name');
      const db = readDB('stock');
      const idx = db.items.findIndex(i => i.name.toLowerCase() === name.toLowerCase());

      if (idx === -1) return interaction.reply({ content: `❌ Item **${name}** not found.`, ephemeral: true });

      db.items.splice(idx, 1);
      writeDB('stock', db);
      await interaction.reply({ content: `🗑️ **${name}** removed from stock.` });
    }
  }
};
