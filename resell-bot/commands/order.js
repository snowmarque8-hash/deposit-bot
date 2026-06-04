const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { readDB, writeDB } = require('../utils/db');
const { generateReceipt } = require('../utils/receipt');
const {
  checkDepositForOrder,
  markDepositUsed,
  deductDepositBalance,
  getDepositBalance,
  hasEnoughBalance,
  logToDepositBot,
} = require('../utils/bridge');
const config = require('../config.json');
const { isStaff, isMod, isAdmin } = require('../utils/perms');

const STATUSES = ['Pending', 'Paid', 'Sourcing', 'Shipped', 'Delivered', 'Completed'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('order')
    .setDescription('Manage orders')
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('Log a new order')
      .addUserOption(o => o.setName('customer').setDescription('Customer').setRequired(true))
      .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true))
      .addNumberOption(o => o.setName('price').setDescription('Price in USD').setRequired(true))
      .addStringOption(o => o.setName('status').setDescription('Order status').setRequired(true)
        .addChoices(...STATUSES.map(s => ({ name: s, value: s }))))
      .addStringOption(o => o.setName('notes').setDescription('Optional notes'))
      .addBooleanOption(o => o.setName('check_deposit').setDescription('Check deposit bot for payment?'))
    )
    .addSubcommand(sub => sub
      .setName('status')
      .setDescription('Update order status')
      .addStringOption(o => o.setName('order_id').setDescription('Order ID (e.g. 1042)').setRequired(true))
      .addStringOption(o => o.setName('status').setDescription('New status').setRequired(true)
        .addChoices(...STATUSES.map(s => ({ name: s, value: s }))))
    )
    .addSubcommand(sub => sub
      .setName('view')
      .setDescription('View a specific order')
      .addStringOption(o => o.setName('order_id').setDescription('Order ID').setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('List orders')
      .addUserOption(o => o.setName('customer').setDescription('Filter by customer'))
      .addStringOption(o => o.setName('status').setDescription('Filter by status')
        .addChoices(...STATUSES.map(s => ({ name: s, value: s }))))
      .addUserOption(o => o.setName('employee').setDescription('Filter by employee'))
    )
    .addSubcommand(sub => sub
      .setName('history')
      .setDescription('View a customer\'s order history')
      .addUserOption(o => o.setName('customer').setDescription('Customer').setRequired(true))
    ),

  async execute(interaction, client) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: '❌ You need the Staff role to use this.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    // ── ADD ORDER ──────────────────────────────────────────────────────────
    if (sub === 'add') {
      await interaction.deferReply({ ephemeral: false });

      const customer  = interaction.options.getUser('customer');
      const item      = interaction.options.getString('item');
      const price     = interaction.options.getNumber('price');
      const status    = interaction.options.getString('status');
      const notes     = interaction.options.getString('notes') || null;
      const checkDep  = interaction.options.getBoolean('check_deposit') ?? false;

      const db = readDB('orders');
      const empDB = readDB('employees');
      const custDB = readDB('customers');

      // Check deposit bot — reads balances.json and deposits.json directly
      // balances.json: { 'discord_USERID': number }
      // deposits.json: { 'DEP-XXXX': { discordId, status, amount, code, ... } }
      let paymentStatus = 'Unpaid';
      let depositNote = '';
      if (checkDep) {
        const balance = getDepositBalance(customer.id);
        if (balance !== null && balance >= price) {
          const newBal = deductDepositBalance(customer.id, price);
          if (newBal !== false) {
            paymentStatus = 'Paid (Balance)';
            depositNote = `\n✅ Deducted **$${price.toFixed(2)}** from balance. Remaining: **$${newBal.toFixed(2)}**`;
          } else {
            depositNote = '\n⚠️ Deduction failed — check depositBotDataPath in config.json.';
          }
        } else {
          const deposit = checkDepositForOrder(customer.id, price);
          if (deposit) {
            paymentStatus = 'Paid (Deposit)';
            markDepositUsed(deposit.code, db.nextId);
            depositNote = `\n✅ Matched deposit \`${deposit.code}\` ($${deposit.amount}) from deposit bot.`;
          } else {
            const balStr = balance !== null ? `$${balance.toFixed(2)}` : 'unavailable';
            depositNote = `\n⚠️ No match. Current balance: **${balStr}** (order needs $${price.toFixed(2)}).`;
          }
        }
      }

      const order = {
        id:            db.nextId++,
        customerId:    customer.id,
        employeeId:    interaction.user.id,
        item,
        price,
        status,
        paymentStatus,
        notes,
        createdAt:     Date.now(),
        updatedAt:     Date.now(),
        completedAt:   status === 'Completed' ? Date.now() : null,
      };

      db.orders.push(order);
      writeDB('orders', db);

      // Update employee stats
      if (!empDB.employees[interaction.user.id]) {
        empDB.employees[interaction.user.id] = { orders: 0, completed: 0, revenue: 0, activeTickets: 0 };
      }
      empDB.employees[interaction.user.id].orders++;
      if (status === 'Completed') {
        empDB.employees[interaction.user.id].completed++;
        empDB.employees[interaction.user.id].revenue += price;
      }
      writeDB('employees', empDB);

      // Update customer history
      if (!custDB.customers[customer.id]) {
        custDB.customers[customer.id] = { orders: [], verified: false, role: 'none', blacklisted: false };
      }
      custDB.customers[customer.id].orders.push(order.id);
      writeDB('customers', custDB);

      // Notify deposit bot
      logToDepositBot({ type: 'resell_order_created', orderId: order.id, discordId: customer.id, amount: price });

      const receipt = generateReceipt(order);
      await interaction.editReply({ content: `✅ Order \`ORDER-${order.id}\` created!${depositNote}`, embeds: [receipt] });

      // Send to receipt channel
      try {
        const receiptCh = await client.channels.fetch(config.receiptChannelId);
        await receiptCh.send({ embeds: [receipt] });
      } catch {}
    }

    // ── UPDATE STATUS ──────────────────────────────────────────────────────
    else if (sub === 'status') {
      const orderId  = parseInt(interaction.options.getString('order_id'));
      const newStatus = interaction.options.getString('status');

      const db = readDB('orders');
      const empDB = readDB('employees');
      const order = db.orders.find(o => o.id === orderId);

      if (!order) return interaction.reply({ content: `❌ Order \`ORDER-${orderId}\` not found.`, ephemeral: true });

      const oldStatus = order.status;
      order.status = newStatus;
      order.updatedAt = Date.now();

      if (newStatus === 'Completed' && oldStatus !== 'Completed') {
        order.completedAt = Date.now();
        const emp = empDB.employees[order.employeeId];
        if (emp) {
          emp.completed++;
          emp.revenue += order.price;
        }
        writeDB('employees', empDB);
        logToDepositBot({ type: 'resell_order_completed', orderId: order.id, discordId: order.customerId, amount: order.price });
      }

      writeDB('orders', db);

      const receipt = generateReceipt(order);
      await interaction.reply({ content: `✅ ORDER-${orderId} updated to **${newStatus}**`, embeds: [receipt] });
    }

    // ── VIEW ORDER ─────────────────────────────────────────────────────────
    else if (sub === 'view') {
      const orderId = parseInt(interaction.options.getString('order_id'));
      const db = readDB('orders');
      const order = db.orders.find(o => o.id === orderId);

      if (!order) return interaction.reply({ content: `❌ Order \`ORDER-${orderId}\` not found.`, ephemeral: true });

      await interaction.reply({ embeds: [generateReceipt(order)] });
    }

    // ── LIST ORDERS ────────────────────────────────────────────────────────
    else if (sub === 'list') {
      const filterCustomer = interaction.options.getUser('customer');
      const filterStatus   = interaction.options.getString('status');
      const filterEmployee = interaction.options.getUser('employee');

      const db = readDB('orders');
      let orders = db.orders;

      if (filterCustomer) orders = orders.filter(o => o.customerId === filterCustomer.id);
      if (filterStatus)   orders = orders.filter(o => o.status === filterStatus);
      if (filterEmployee) orders = orders.filter(o => o.employeeId === filterEmployee.id);

      if (orders.length === 0) return interaction.reply({ content: '📭 No orders found.', ephemeral: true });

      const lines = orders.slice(-20).map(o =>
        `\`ORDER-${o.id}\` • ${o.item} • $${o.price} • **${o.status}** • <@${o.customerId}>`
      );

      const embed = new EmbedBuilder()
        .setTitle(`📋 Orders (${orders.length} total)`)
        .setColor(0x3498db)
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Showing last 20 results' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }

    // ── CUSTOMER HISTORY ───────────────────────────────────────────────────
    else if (sub === 'history') {
      const customer = interaction.options.getUser('customer');
      const db = readDB('orders');
      const orders = db.orders.filter(o => o.customerId === customer.id);

      if (orders.length === 0) return interaction.reply({ content: `📭 No orders found for ${customer.tag}.`, ephemeral: true });

      const total = orders.reduce((sum, o) => sum + o.price, 0);
      const lines = orders.slice(-15).map(o =>
        `\`ORDER-${o.id}\` • ${o.item} • $${o.price} • **${o.status}**`
      );

      const embed = new EmbedBuilder()
        .setTitle(`📦 Order History — ${customer.username}`)
        .setColor(0x9b59b6)
        .setDescription(lines.join('\n'))
        .addFields(
          { name: 'Total Orders', value: `${orders.length}`, inline: true },
          { name: 'Total Spent',  value: `$${total.toFixed(2)}`, inline: true },
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }
  }
};
