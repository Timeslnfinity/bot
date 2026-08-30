require('dotenv').config();

const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error(
    'Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in environment variables.'
  );
}

const adminOnly = PermissionFlagsBits.Administrator;

const commands = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check voice connection and auto-rejoin status.')
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave voice and disable automatic rejoining.')
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join the configured voice channel and enable rejoining.')
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('shutdown')
    .setDescription('Leave voice and stop the bot process.')
    .setDefaultMemberPermissions(adminOnly),
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log(`Registering ${commands.length} server slash commands...`);

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log('Slash commands registered successfully.');
  } catch (error) {
    console.error('Failed to register slash commands:', error);
    process.exit(1);
  }
})();