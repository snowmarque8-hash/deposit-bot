require('dotenv').config();
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');

// Secrets come from environment variables first (Railway), then fall back to config.json (local)
const token    = process.env.RESELL_TOKEN     || config.token;
const clientId  = process.env.RESELL_CLIENT_ID || config.clientId;
const guildId   = process.env.RESELL_GUILD_ID  || config.guildId;

const { initDB } = require('./utils/db');
const { startInviteTracker } = require('./utils/inviteTracker');
const { startGiveawayChecker } = require('./utils/giveawayChecker');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildInvites,
  ],
});

client.commands = new Collection();

// Load all commands
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

const slashCommands = [];
for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
    slashCommands.push(command.data.toJSON());
  }
}

// Register slash commands
const rest = new REST({ version: '10' }).setToken(token);
(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: slashCommands });
    console.log('Slash commands registered!');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();

client.once('ready', async () => {
  console.log(`✅ Resell Bot online as ${client.user.tag}`);
  initDB();
  await startInviteTracker(client);
  startGiveawayChecker(client);
});

// Handle slash commands
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction, client);
  } catch (err) {
    console.error(`Error in /${interaction.commandName}:`, err);
    const msg = { content: '❌ Something went wrong running that command.', ephemeral: true };
    interaction.replied ? interaction.followUp(msg) : interaction.reply(msg);
  }
});

// Invite tracking — member join
client.on('guildMemberAdd', async member => {
  const { handleMemberJoin } = require('./utils/inviteTracker');
  await handleMemberJoin(member, client);
});

// Invite tracking — member leave
client.on('guildMemberRemove', async member => {
  const { handleMemberLeave } = require('./utils/inviteTracker');
  handleMemberLeave(member);
});

client.login(token);
