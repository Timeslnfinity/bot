require('dotenv').config();

const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');

const TOKEN = process.env.DISCORD_TOKEN;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

if (!TOKEN || !VOICE_CHANNEL_ID) {
  throw new Error(
    'Missing DISCORD_TOKEN or VOICE_CHANNEL_ID. Add them to your host environment variables.'
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

async function joinTargetVoiceChannel() {
  const channel = await client.channels.fetch(VOICE_CHANNEL_ID);

  if (!channel) {
    throw new Error('Voice channel not found. Check VOICE_CHANNEL_ID.');
  }

  const validVoiceChannel =
    channel.type === ChannelType.GuildVoice ||
    channel.type === ChannelType.GuildStageVoice;

  if (!validVoiceChannel) {
    throw new Error('VOICE_CHANNEL_ID must be a normal voice or stage channel.');
  }

  const oldConnection = getVoiceConnection(channel.guild.id);

  if (
    oldConnection &&
    oldConnection.joinConfig.channelId === channel.id &&
    oldConnection.state.status === VoiceConnectionStatus.Ready
  ) {
    console.log(`Already connected to: ${channel.name}`);
    return;
  }

  if (oldConnection) {
    oldConnection.destroy();
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
  } catch (error) {
    connection.destroy();
    console.error('Could not connect to the VC:', error);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await joinTargetVoiceChannel();
  } catch (error) {
    console.error('Startup voice error:', error);
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (oldState.member?.id !== client.user.id) return;

  if (oldState.channelId !== newState.channelId) {
    console.log('Bot was moved/disconnected. Rejoining in 5 seconds...');

    setTimeout(() => {
      joinTargetVoiceChannel().catch((error) => {
        console.error('Rejoin error:', error);
      });
    }, 5_000);
  }
});

client.login(TOKEN);
