const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { readDB, writeDB } = require('../utils/db');
const config = require('../config.json');
const { isStaff, isMod, isAdmin } = require('../utils/perms');

const ROLES = {
  verified:    { label: '✅ Verified Buyer', key: 'verifiedRoleId' },
  reseller:    { label: '💰 Reseller',       key: 'resellerRoleId' },
  vip:         { label: '⭐ VIP',            key: 'vipRoleId' },
  blacklisted: { label: '🚫 Blacklisted',    key: 'blacklistedRoleId' },
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Manage customer verification')
    .addSubcommand(sub => sub
      .setName('set')
      .setDescription('Set a customer\'s verification status')
      .addUserOption(o => o.setName('user').setDescription('Customer').setRequired(true))
      .addStringOption(o => o.setName('status').setDescription('Status').setRequired(true)
        .addChoices(
          { name: '✅ Verified Buyer', value: 'verified' },
          { name: '💰 Reseller',       value: 'reseller' },
          { name: '⭐ VIP',            value: 'vip' },
          { name: '🚫 Blacklisted',    value: 'blacklisted' },
        ))
      .addStringOption(o => o.setName('reason').setDescription('Reason (required for blacklist)'))
    )
    .addSubcommand(sub => sub
      .setName('check')
      .setDescription('Check a customer\'s status')
      .addUserOption(o => o.setName('user').setDescription('Customer').setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName('remove')
      .setDescription('Remove a verification status from a user')
      .addUserOption(o => o.setName('user').setDescription('Customer').setRequired(true))
      .addStringOption(o => o.setName('status').setDescription('Status to remove').setRequired(true)
        .addChoices(
          { name: '✅ Verified Buyer', value: 'verified' },
          { name: '💰 Reseller',       value: 'reseller' },
          { name: '⭐ VIP',            value: 'vip' },
          { name: '🚫 Blacklisted',    value: 'blacklisted' },
        ))
    ),

  async execute(interaction, client) {
    const allowed = isMod(interaction.member);
    if (!allowed) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });

    const sub = interaction.options.getSubcommand();
    const target = interaction.options.getUser('user');
    const db = readDB('customers');

    if (!db.customers[target.id]) {
      db.customers[target.id] = { orders: [], verified: false, role: 'none', blacklisted: false, flags: [] };
    }

    const customer = db.customers[target.id];

    // ── SET STATUS ─────────────────────────────────────────────────────────
    if (sub === 'set') {
      const status = interaction.options.getString('status');
      const reason = interaction.options.getString('reason') || 'No reason provided';

      if (status === 'blacklisted' && !interaction.options.getString('reason')) {
        return interaction.reply({ content: '❌ Please provide a reason for blacklisting.', ephemeral: true });
      }

      customer.role = status;
      customer.blacklisted = status === 'blacklisted';
      customer.verifiedAt = Date.now();
      customer.verifiedBy = interaction.user.id;
      if (status === 'blacklisted') customer.blacklistReason = reason;

      writeDB('customers', db);

      // Apply Discord role
      try {
        const member = await interaction.guild.members.fetch(target.id);
        const roleId = config[ROLES[status].key];
        if (roleId) await member.roles.add(roleId);

        // Remove conflicting roles
        for (const [key, roleInfo] of Object.entries(ROLES)) {
          if (key !== status) {
            const rid = config[roleInfo.key];
            if (rid && member.roles.cache.has(rid)) await member.roles.remove(rid);
          }
        }
      } catch (err) {
        console.error('Role assignment error:', err);
      }

      const embed = new EmbedBuilder()
        .setTitle(`${ROLES[status].label} — Status Set`)
        .setColor(status === 'blacklisted' ? 0xe74c3c : 0x2ecc71)
        .addFields(
          { name: 'User',   value: `<@${target.id}>`,          inline: true },
          { name: 'Status', value: ROLES[status].label,         inline: true },
          { name: 'By',     value: `<@${interaction.user.id}>`, inline: true },
        );
      if (status === 'blacklisted') embed.addFields({ name: 'Reason', value: reason });

      await interaction.reply({ embeds: [embed] });

      // Log to log channel
      try {
        const logCh = await client.channels.fetch(config.logChannelId);
        await logCh.send({ embeds: [embed] });
      } catch {}
    }

    // ── CHECK STATUS ───────────────────────────────────────────────────────
    else if (sub === 'check') {
      const ordersDB = readDB('orders');
      const userOrders = ordersDB.orders.filter(o => o.customerId === target.id);
      const totalSpent = userOrders.reduce((sum, o) => sum + o.price, 0);

      const embed = new EmbedBuilder()
        .setTitle(`👤 Customer Profile — ${target.username}`)
        .setColor(0x3498db)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: 'Status',       value: ROLES[customer.role]?.label || '❓ None', inline: true },
          { name: 'Blacklisted',  value: customer.blacklisted ? '🚫 Yes' : '✅ No', inline: true },
          { name: 'Total Orders', value: `${userOrders.length}`,            inline: true },
          { name: 'Total Spent',  value: `$${totalSpent.toFixed(2)}`,       inline: true },
        );

      if (customer.blacklisted && customer.blacklistReason) {
        embed.addFields({ name: '🚫 Blacklist Reason', value: customer.blacklistReason });
      }

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── REMOVE STATUS ──────────────────────────────────────────────────────
    else if (sub === 'remove') {
      const status = interaction.options.getString('status');
      customer.role = 'none';
      customer.blacklisted = false;
      writeDB('customers', db);

      try {
        const member = await interaction.guild.members.fetch(target.id);
        const roleId = config[ROLES[status].key];
        if (roleId && member.roles.cache.has(roleId)) await member.roles.remove(roleId);
      } catch {}

      await interaction.reply({ content: `✅ Removed **${ROLES[status].label}** from <@${target.id}>.` });
    }
  }
};
