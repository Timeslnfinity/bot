require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');

const TOKEN = process.env.DISCORD_TOKEN;
const DEFAULT_VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !DEFAULT_VOICE_CHANNEL_ID || !CLIENT_ID || !GUILD_ID) {
  throw new Error(
    'Missing DISCORD_TOKEN, VOICE_CHANNEL_ID, CLIENT_ID, or GUILD_ID in environment variables.'
  );
}

let targetVoiceChannelId = DEFAULT_VOICE_CHANNEL_ID;
let autoRejoinEnabled = true;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const adminOnly = PermissionFlagsBits.Administrator;

const commands = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check voice connection, target channel, and auto-rejoin status.')
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
    .setName('setchannel')
    .setDescription('Set the voice channel the bot should join.')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('The voice channel for the bot to join.')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    )
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('shutdown')
    .setDescription('Leave voice and stop the bot process.')
    .setDefaultMemberPermissions(adminOnly),
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  console.log(`Registering ${commands.length} slash commands...`);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log('Slash commands registered successfully.');
}

async function getTargetVoiceChannel() {
  const channel = await client.channels.fetch(targetVoiceChannelId);

  if (!channel) {
    throw new Error('Target voice channel was not found.');
  }

  const isVoiceChannel =
    channel.type === ChannelType.GuildVoice ||
    channel.type === ChannelType.GuildStageVoice;

  if (!isVoiceChannel) {
    throw new Error('The target channel is not a voice or stage channel.');
  }

  return channel;
}

async function joinTargetVoiceChannel() {
  const channel = await getTargetVoiceChannel();
  const existingConnection = getVoiceConnection(channel.guild.id);

  if (
    existingConnection &&
    existingConnection.joinConfig.channelId === channel.id &&
    existingConnection.state.status === VoiceConnectionStatus.Ready
  ) {
    return `Already connected to **${channel.name}**.`;
  }

  if (existingConnection) {
    existingConnection.destroy();
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  connection.on('stateChange', (oldState, newState) => {
    console.log(`Voice state: ${oldState.status} -> ${newState.status}`);
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    console.log(`Connected to: ${channel.name}`);
    return `Connected to **${channel.name}**.`;
  } catch (error) {
    connection.destroy();
    throw error;
  }
}

function leaveVoiceChannel() {
  for (const [, guild] of client.guilds.cache) {
    const connection = getVoiceConnection(guild.id);

    if (connection) {
      connection.destroy();
      return true;
    }
  }

  return false;
}

function isAdministrator(interaction) {
  return interaction.memberPermissions?.has(
    PermissionFlagsBits.Administrator
  );
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await registerCommands();
  } catch (error) {
    console.error('Command registration error:', error);
  }

  try {
    const message = await joinTargetVoiceChannel();
    console.log(message);
  } catch (error) {
    console.error('Startup voice error:', error);
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (oldState.member?.id !== client.user.id) return;
  if (!autoRejoinEnabled) return;
  if (oldState.channelId === newState.channelId) return;

  console.log('Bot was moved or disconnected. Rejoining in 5 seconds...');

  setTimeout(() => {
    if (!autoRejoinEnabled) return;

    joinTargetVoiceChannel().catch((error) => {
      console.error('Rejoin error:', error);
    });
  }, 5_000);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!isAdministrator(interaction)) {
    await interaction.reply({
      content: 'You need the Administrator permission to use this bot.',
      ephemeral: true,
    });
    return;
  }

  try {
    if (interaction.commandName === 'status') {
      const connection = [...client.guilds.cache.values()]
        .map((guild) => getVoiceConnection(guild.id))
        .find(Boolean);

      const voiceStatus = connection?.state.status ?? 'disconnected';

      let targetName = 'Unknown channel';

      try {
        const target = await getTargetVoiceChannel();
        targetName = target.name;
      } catch {
        // Keeps /status usable if the target channel was deleted or made inaccessible.
      }

      await interaction.reply({
        content:
          `Voice status: **${voiceStatus}**\n` +
          `Auto-rejoin: **${autoRejoinEnabled ? 'enabled' : 'disabled'}**\n` +
          `Target channel: **${targetName}**\n` +
          `Target ID: \`${targetVoiceChannelId}\``,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'leave') {
      autoRejoinEnabled = false;
      const left = leaveVoiceChannel();

      await interaction.reply({
        content: left
          ? 'Left voice. Auto-rejoin is now **disabled**.'
          : 'Auto-rejoin is now **disabled**. I was not in voice.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'join') {
      autoRejoinEnabled = true;

      await interaction.deferReply({ ephemeral: true });

      const message = await joinTargetVoiceChannel();

      await interaction.editReply(
        `${message}\nAuto-rejoin is now **enabled**.`
      );
      return;
    }

    if (interaction.commandName === 'setchannel') {
      const selectedChannel = interaction.options.getChannel('channel', true);

      const isVoiceChannel =
        selectedChannel.type === ChannelType.GuildVoice ||
        selectedChannel.type === ChannelType.GuildStageVoice;

      if (!isVoiceChannel) {
        await interaction.reply({
          content: 'Please select a normal voice channel or stage channel.',
          ephemeral: true,
        });
        return;
      }

      targetVoiceChannelId = selectedChannel.id;
      autoRejoinEnabled = true;

      await interaction.deferReply({ ephemeral: true });

      const message = await joinTargetVoiceChannel();

      await interaction.editReply(
        `Target channel changed to **${selectedChannel.name}**.\n` +
        `${message}\n` +
        'Auto-rejoin is now **enabled**.'
      );

      console.log(
        `Target channel changed to ${selectedChannel.name} (${selectedChannel.id}) by ${interaction.user.tag}.`
      );
      return;
    }

    if (interaction.commandName === 'shutdown') {
      autoRejoinEnabled = false;
      leaveVoiceChannel();

      await interaction.reply({
        content:
          'Shutting down. I left voice and will not rejoin unless the host starts me again.',
        ephemeral: true,
      });

      console.log(`Shutdown requested by ${interaction.user.tag}.`);

      setTimeout(() => {
        client.destroy();
        process.exit(0);
      }, 1_000);
    }
  } catch (error) {
    console.error(`Command error for /${interaction.commandName}:`, error);

    const response = {
      content: `Something went wrong: \`${error.message}\``,
      ephemeral: true,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(response);
    } else {
      await interaction.reply(response);
    }
  }
});

client.login(TOKEN);