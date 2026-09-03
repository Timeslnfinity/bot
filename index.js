require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');

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

const DATA_DIR = path.join(__dirname, 'data');
const TRUSTED_USERS_FILE = path.join(DATA_DIR, 'trusted-users.json');
const PARTICIPANTS_FILE = path.join(DATA_DIR, 'activity-participants.json');
const ACTIVITY_CONFIG_FILE = path.join(DATA_DIR, 'activity-config.json');

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(TRUSTED_USERS_FILE)) {
    fs.writeFileSync(TRUSTED_USERS_FILE, '[]\n');
  }

  if (!fs.existsSync(PARTICIPANTS_FILE)) {
    fs.writeFileSync(PARTICIPANTS_FILE, '[]\n');
  }

  if (!fs.existsSync(ACTIVITY_CONFIG_FILE)) {
    fs.writeFileSync(
      ACTIVITY_CONFIG_FILE,
      JSON.stringify({ channelIds: [] }, null, 2) + '\n'
    );
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`Could not read ${path.basename(file)}:`, error);
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

ensureDataFiles();

let trustedUserIds = new Set(readJson(TRUSTED_USERS_FILE, []));
let activityParticipantIds = new Set(readJson(PARTICIPANTS_FILE, []));
let activityConfig = readJson(ACTIVITY_CONFIG_FILE, { channelIds: [] });

if (!Array.isArray(activityConfig.channelIds)) {
  activityConfig.channelIds = [];
}

let targetVoiceChannelId = DEFAULT_VOICE_CHANNEL_ID;
let autoRejoinEnabled = true;

let activityRunning = false;
let activityStartedBy = null;
let activityEndsAt = null;
let activityStopTimer = null;
let activityMoveTimer = null;
let activityRunId = 0;
const activityMovePromises = new Set();

const ACTIVITY_MOVE_INTERVAL_MS = 500;

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
    .setDescription('Check normal voice connection and auto-rejoin status.'),

  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join the configured voice channel and enable rejoining.'),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave voice and disable automatic rejoining.'),

  new SlashCommandBuilder()
    .setName('trusted')
    .setDescription('List users allowed to control normal voice joining.')
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('allow')
    .setDescription('Allow a user to use join, leave, and status.')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('User to allow.')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('deny')
    .setDescription('Remove a user from normal voice-control access.')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('User to remove.')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Set the voice channel the bot should join.')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('New target voice channel.')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    )
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('shutdown')
    .setDescription('Leave voice and stop the bot process.')
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('optin')
    .setDescription('Add a user to the activity participant list.')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('User to add.')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('optout')
    .setDescription('Remove a user from the activity participant list.')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('User to remove.')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('participants')
    .setDescription('List users opted in to the activity.')
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('activity-channel-add')
    .setDescription('Add a voice channel to the activity channel list.')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Voice channel to add.')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    )
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('activity-channel-remove')
    .setDescription('Remove a voice channel from the activity list.')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Voice channel to remove.')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    )
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('activity-channels')
    .setDescription('List all saved activity voice channels.')
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('activity-channel-clear')
    .setDescription('Remove every channel from the activity channel list.')
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('activity-start')
    .setDescription('Start a timed opt-in activity session.')
    .addIntegerOption((option) =>
      option
        .setName('duration')
        .setDescription('Duration in seconds, from 5 to 300.')
        .setRequired(true)
        .setMinValue(5)
        .setMaxValue(300)
    )
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('activity-stop')
    .setDescription('Stop the active opt-in activity session.')
    .setDefaultMemberPermissions(adminOnly),

  new SlashCommandBuilder()
    .setName('activity-status')
    .setDescription('Show opt-in activity status and channel count.')
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

function isAdministrator(interaction) {
  return interaction.memberPermissions?.has(
    PermissionFlagsBits.Administrator
  );
}

function canControlVoice(interaction) {
  return isAdministrator(interaction) || trustedUserIds.has(interaction.user.id);
}

function saveTrustedUsers() {
  writeJson(TRUSTED_USERS_FILE, [...trustedUserIds]);
}

function saveParticipants() {
  writeJson(PARTICIPANTS_FILE, [...activityParticipantIds]);
}

function saveActivityConfig() {
  writeJson(ACTIVITY_CONFIG_FILE, activityConfig);
}

function logActivityMoveError(participantId, error) {
  const isRateLimited = error?.status === 429 || error?.code === 429;

  if (isRateLimited) {
    const retryAfter = error.rawError?.retry_after ?? error.data?.retry_after;
    const retryMessage = retryAfter == null
      ? ''
      : ` Retry after ${retryAfter} seconds.`;

    console.warn(
      `Discord rate limited the move for participant ${participantId}.${retryMessage}`
    );
    return;
  }

  console.warn(
    `Could not move activity participant ${participantId}: ${error.message}`
  );
}

function isVoiceChannel(channel) {
  return (
    channel &&
    (channel.type === ChannelType.GuildVoice ||
      channel.type === ChannelType.GuildStageVoice)
  );
}

async function getTargetVoiceChannel() {
  const channel = await client.channels.fetch(targetVoiceChannelId);

  if (!isVoiceChannel(channel)) {
    throw new Error('The target channel is not a voice or stage channel.');
  }

  return channel;
}

async function getActivityChannels() {
  if (activityConfig.channelIds.length === 0) {
    throw new Error(
      'No activity channels are configured. Use /activity-channel-add first.'
    );
  }

  const channels = [];

  for (const channelId of activityConfig.channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);

      if (isVoiceChannel(channel)) {
        channels.push(channel);
      } else {
        console.warn(`Ignoring invalid activity channel ID: ${channelId}`);
      }
    } catch (error) {
      console.warn(
        `Could not fetch activity channel ${channelId}: ${error.message}`
      );
    }
  }

  if (channels.length === 0) {
    throw new Error(
      'No saved activity channels are accessible. Check the list and bot permissions.'
    );
  }

  return channels;
}

async function moveActivityParticipant(
  channels,
  participantId,
  destinationIndex,
  runId
) {
  if (!activityRunning || runId !== activityRunId || channels.length < 2) {
    return;
  }

  try {
    const guild = channels[0].guild;
    const member = await guild.members.fetch(participantId);

    if (!activityRunning || runId !== activityRunId) return;

    const destination = channels[destinationIndex % channels.length];

    if (!activityRunning || runId !== activityRunId) return;

    await member.voice.setChannel(destination);

    if (!activityRunning || runId !== activityRunId) return;

    console.log(
      `Moved ${member.user.tag} to activity channel ${destination.name}.`
    );
  } catch (error) {
    logActivityMoveError(participantId, error);
  }
}

async function startActivityMovement(channels, runId) {
  let participantIndex = 0;
  let destinationIndex = 0;

  const moveAndScheduleNext = () => {
    if (!activityRunning || runId !== activityRunId) return;

    const participantIds = [...activityParticipantIds];
    if (participantIds.length > 0) {
      const participantId =
        participantIds[participantIndex % participantIds.length];
      participantIndex += 1;
      const currentDestinationIndex = destinationIndex;
      destinationIndex += 1;

      const movePromise = moveActivityParticipant(
        channels,
        participantId,
        currentDestinationIndex,
        runId
      ).catch((error) => {
        console.error('Activity movement error:', error);
      });

      activityMovePromises.add(movePromise);
      movePromise.finally(() => activityMovePromises.delete(movePromise));
    }

    activityMoveTimer = setTimeout(() => {
      moveAndScheduleNext();
    }, ACTIVITY_MOVE_INTERVAL_MS);
  };

  moveAndScheduleNext();
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

async function stopActivity(reason = 'Stopped.') {
  activityRunning = false;
  activityRunId += 1;
  activityStartedBy = null;
  activityEndsAt = null;

  if (activityStopTimer) {
    clearTimeout(activityStopTimer);
    activityStopTimer = null;
  }

  if (activityMoveTimer) {
    clearTimeout(activityMoveTimer);
    activityMoveTimer = null;
  }

  await Promise.allSettled([...activityMovePromises]);

  console.log(`Activity stopped: ${reason}`);
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

  const normalVoiceCommands = ['status', 'join', 'leave'];

  const adminCommands = [
    'trusted',
    'allow',
    'deny',
    'setchannel',
    'shutdown',
    'optin',
    'optout',
    'participants',
    'activity-channel-add',
    'activity-channel-remove',
    'activity-channels',
    'activity-channel-clear',
    'activity-start',
    'activity-stop',
    'activity-status',
  ];

  if (
    normalVoiceCommands.includes(interaction.commandName) &&
    !canControlVoice(interaction)
  ) {
    await interaction.reply({
      content: 'You do not have permission to control the normal voice bot.',
      ephemeral: true,
    });
    return;
  }

  if (
    adminCommands.includes(interaction.commandName) &&
    !isAdministrator(interaction)
  ) {
    await interaction.reply({
      content: 'You need the Administrator permission to use this command.',
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
        // Keep status usable even if the channel was deleted.
      }

      await interaction.reply({
        content:
          `Voice status: **${voiceStatus}**\n` +
          `Auto-rejoin: **${autoRejoinEnabled ? 'enabled' : 'disabled'}**\n` +
          `Target channel: **${targetName}**`,
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

    if (interaction.commandName === 'allow') {
      const user = interaction.options.getUser('user', true);

      if (user.bot) {
        await interaction.reply({
          content: 'You cannot add another bot as a trusted user.',
          ephemeral: true,
        });
        return;
      }

      trustedUserIds.add(user.id);
      saveTrustedUsers();

      await interaction.reply({
        content: `${user} can now use **/join**, **/leave**, and **/status**.`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'deny') {
      const user = interaction.options.getUser('user', true);
      const removed = trustedUserIds.delete(user.id);

      if (removed) {
        saveTrustedUsers();
      }

      await interaction.reply({
        content: removed
          ? `${user} can no longer control the normal voice bot.`
          : `${user} was not on the trusted-user list.`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'trusted') {
      const users = [...trustedUserIds];

      await interaction.reply({
        content:
          users.length > 0
            ? `Trusted users:\n${users.map((id) => `<@${id}>`).join('\n')}`
            : 'No trusted users have been added.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'setchannel') {
      const channel = interaction.options.getChannel('channel', true);

      targetVoiceChannelId = channel.id;
      autoRejoinEnabled = true;

      await interaction.deferReply({ ephemeral: true });

      const message = await joinTargetVoiceChannel();

      await interaction.editReply(
        `Target channel changed to **${channel.name}**.\n${message}`
      );
      return;
    }

    if (interaction.commandName === 'optin') {
      const user = interaction.options.getUser('user', true);

      if (user.bot) {
        await interaction.reply({
          content: 'You cannot add another bot as an activity participant.',
          ephemeral: true,
        });
        return;
      }

      activityParticipantIds.add(user.id);
      saveParticipants();

      await interaction.reply({
        content: `${user} is now opted in to the activity participant list.`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'optout') {
      const user = interaction.options.getUser('user', true);
      const removed = activityParticipantIds.delete(user.id);

      if (removed) {
        saveParticipants();
      }

      await interaction.reply({
        content: removed
          ? `${user} is no longer opted in to the activity participant list.`
          : `${user} was not opted in.`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'participants') {
      const users = [...activityParticipantIds];

      await interaction.reply({
        content:
          users.length > 0
            ? `Opted-in participants:\n${users.map((id) => `<@${id}>`).join('\n')}`
            : 'No users are currently opted in.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'activity-channel-add') {
      const channel = interaction.options.getChannel('channel', true);

      if (activityConfig.channelIds.includes(channel.id)) {
        await interaction.reply({
          content: `**${channel.name}** is already in the activity channel list.`,
          ephemeral: true,
        });
        return;
      }

      activityConfig.channelIds.push(channel.id);
      saveActivityConfig();

      await interaction.reply({
        content:
          `Added **${channel.name}**.\n` +
          `Saved activity channels: **${activityConfig.channelIds.length}**`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'activity-channel-remove') {
      const channel = interaction.options.getChannel('channel', true);
      const oldLength = activityConfig.channelIds.length;

      activityConfig.channelIds = activityConfig.channelIds.filter(
        (channelId) => channelId !== channel.id
      );

      if (activityConfig.channelIds.length === oldLength) {
        await interaction.reply({
          content: `**${channel.name}** was not in the activity channel list.`,
          ephemeral: true,
        });
        return;
      }

      saveActivityConfig();

      await interaction.reply({
        content:
          `Removed **${channel.name}**.\n` +
          `Saved activity channels: **${activityConfig.channelIds.length}**`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'activity-channels') {
      if (activityConfig.channelIds.length === 0) {
        await interaction.reply({
          content: 'No activity channels have been saved.',
          ephemeral: true,
        });
        return;
      }

      const channelList = activityConfig.channelIds
        .map((channelId, index) => `${index + 1}. <#${channelId}>`)
        .join('\n');

      await interaction.reply({
        content:
          `Saved activity channels (**${activityConfig.channelIds.length}**):\n` +
          channelList,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'activity-channel-clear') {
      activityConfig.channelIds = [];
      saveActivityConfig();

      await interaction.reply({
        content: 'Removed all saved activity channels.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'activity-start') {
      if (activityRunning) {
        await interaction.reply({
          content: 'The activity is already running.',
          ephemeral: true,
        });
        return;
      }

      const durationSeconds = interaction.options.getInteger('duration', true);
      const channels = await getActivityChannels();

      if (channels.length < 2) {
        await interaction.reply({
          content: 'Configure at least two accessible activity channels before starting the activity.',
          ephemeral: true,
        });
        return;
      }

      activityRunning = true;
      activityRunId += 1;
      const runId = activityRunId;
      activityStartedBy = interaction.user.id;
      activityEndsAt = Date.now() + durationSeconds * 1000;

      activityStopTimer = setTimeout(() => {
        stopActivity('Duration completed.').catch((error) => {
          console.error('Could not finish stopping the activity:', error);
        });
      }, durationSeconds * 1000);

      startActivityMovement(channels, runId).catch((error) => {
        console.error('Could not start activity movement:', error);
        stopActivity('Movement failed to start.').catch((stopError) => {
          console.error('Could not stop the activity:', stopError);
        });
      });

      await interaction.reply({
        content:
          `Activity started for **${durationSeconds} seconds**.\n` +
          `Opted-in participants: **${activityParticipantIds.size}**\n` +
          `Valid configured channels: **${channels.length}**.\n` +
          `Participants in voice will move every **${ACTIVITY_MOVE_INTERVAL_MS / 1000} second(s)**.`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'activity-stop') {
      if (!activityRunning) {
        await interaction.reply({
          content: 'The activity is not running.',
          ephemeral: true,
        });
        return;
      }

      await stopActivity(`Stopped by ${interaction.user.tag}.`);

      await interaction.reply({
        content: 'Activity stopped.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'activity-status') {
      const secondsRemaining = activityRunning
        ? Math.max(0, Math.ceil((activityEndsAt - Date.now()) / 1000))
        : 0;

      let validChannelCount = 0;

      if (activityConfig.channelIds.length > 0) {
        try {
          validChannelCount = (await getActivityChannels()).length;
        } catch {
          validChannelCount = 0;
        }
      }

      await interaction.reply({
        content:
          `Activity running: **${activityRunning ? 'yes' : 'no'}**\n` +
          `Time remaining: **${secondsRemaining} seconds**\n` +
          `Opted-in participants: **${activityParticipantIds.size}**\n` +
          `Saved channel IDs: **${activityConfig.channelIds.length}**\n` +
          `Accessible voice channels: **${validChannelCount}**`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'shutdown') {
      autoRejoinEnabled = false;
      stopActivity('Bot shutdown.');
      leaveVoiceChannel();

      await interaction.reply({
        content:
          'Shutting down. I left voice and will not rejoin unless the host starts me again.',
        ephemeral: true,
      });

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