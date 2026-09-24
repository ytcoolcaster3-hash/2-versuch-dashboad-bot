const express = require('express');
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const session = require('express-session');
const { saveToken, loadToken } = require('./lib/configStore');
const { parseMentionText } = require('./lib/messageMentions');
const {
  DEFAULT_PERMISSIONS,
  ensureUsersFile,
  loadUsers,
  createUser,
  deleteUser,
  getUserByName,
  sanitizePermissions,
  verifyPassword,
  hashPassword,
  saveUsers
} = require('./lib/usersStore');
const { addLog, readLogs } = require('./lib/logStore');
const { addAuthorized, readAuthorized } = require('./lib/authorizedStore');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(process.cwd(), 'data');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'local-dashboard-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 }
}));

app.use((req, res, next) => {
  const originalRedirect = res.redirect.bind(res);
  res.redirect = (target) => {
    const returnTab = req.method === 'POST' ? String(req.body?.returnTab || '').trim() : '';
    if (target === '/' && returnTab) {
      return originalRedirect(`/?tab=${encodeURIComponent(returnTab)}`);
    }
    return originalRedirect(target);
  };
  next();
});

const state = {
  client: null,
  botStatus: 'offline',
  lastAction: null,
  startedAt: null,
  voiceChannelId: null,
  dmThreads: new Map(),
  guildDataCache: null,
  guildDataCacheAt: 0,
  aiGuildId: null,
  aiChannelId: null,
  aiEnabled: false
};

const permissionLabels = {
  overview: 'Übersicht ansehen',
  messages: 'Nachrichten senden',
  commands: 'Commands ansehen',
  server: 'Server ansehen',
  roles: 'Rollen bearbeiten',
  settings: 'Bot starten und stoppen',
  users: 'Benutzer verwalten',
  voice: 'Voice-Kanal steuern'
};

const logTypeLabels = {
  message_received: 'Nachricht',
  message_sent: 'Bot-Nachricht',
  dm_received: 'DM erhalten',
  dm_sent: 'DM gesendet',
  role_assigned: 'Rolle hinzugefügt',
  role_removed: 'Rolle entfernt',
  role_reordered: 'Rolle sortiert',
  role_edited: 'Rolle bearbeitet',
  member_warned: 'Verwarnung',
  member_timeout: 'Timeout',
  member_kicked: 'Kick',
  member_banned: 'Ban',
  bot_ready: 'Bot online',
  bot_stopped: 'Bot gestoppt',
  ai_reply: 'KI-Antwort',
  ai_error: 'KI-Fehler'
};

function getOwnerIds() {
  const value = process.env.DISCORD_OWNER_IDS || '1430522427884179566';
  return value.split(',').map((id) => String(id).trim()).filter(Boolean);
}

function getToken() {
  return loadToken(process.cwd()) || process.env.BOT_TOKEN || null;
}

function requireAuth(req, res, next) {
  if (req.session.user) return next();
  return res.redirect('/login');
}

function requirePermission(permission) {
  return (req, res, next) => {
    const userPermissions = req.session.user?.permissions || [];
    if (userPermissions.includes(permission)) return next();
    state.lastAction = { type: 'error', text: 'Du hast für diese Aktion keine Berechtigung.' };
    return res.redirect('/');
  };
}

function redirectToTab(req, res) {
  const tab = String(req.body?.returnTab || '').trim();
  return res.redirect(tab ? `/?tab=${encodeURIComponent(tab)}` : '/');
}

function hasAnyPermission(user) {
  return Boolean(user?.permissions?.some((permission) => DEFAULT_PERMISSIONS.includes(permission)));
}

function publicUser(user) {
  return {
    username: user.username,
    permissions: user.permissions || []
  };
}

function formatDuration(milliseconds) {
  const totalMinutes = Math.floor(milliseconds / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days) return `${days}T ${hours}Std`;
  if (hours) return `${hours}Std ${minutes}Min`;
  return `${minutes}Min`;
}

function ensureDashboardData() {
  ensureUsersFile();
  const defaultAuthorized = path.join(DATA_DIR, 'authorized.json');
  if (!fs.existsSync(defaultAuthorized)) {
    fs.writeFileSync(defaultAuthorized, JSON.stringify([], null, 2));
  }
  const defaultLogs = path.join(DATA_DIR, 'logs.json');
  if (!fs.existsSync(defaultLogs)) {
    fs.writeFileSync(defaultLogs, JSON.stringify([], null, 2));
  }
}

async function buildGuildData(client) {
  if (!client || !client.guilds?.cache) return [];
  if (state.guildDataCache && Date.now() - state.guildDataCacheAt < 5000) {
    return state.guildDataCache;
  }

  const guilds = [];

  for (const guild of client.guilds.cache.values()) {
    await Promise.all([
      guild.members.fetch({ limit: 1000 }).catch(() => null),
      guild.channels.fetch().catch(() => null),
      guild.roles.fetch().catch(() => null)
    ]);

    const textChannels = guild.channels.cache
      .filter((channel) => channel && channel.isTextBased && typeof channel.send === 'function')
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        category: channel.parent?.name || 'Allgemein'
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const messageChannels = [...guild.channels.cache.values()]
      .filter((item) => item && item.isTextBased && typeof item.messages?.fetch === 'function');
    const fetchedMessages = await Promise.all(messageChannels.map(async (channel) => {
      const messages = await channel.messages.fetch({ limit: 15 }).catch(() => null);
      if (!messages) return null;
      return [channel.id, [...messages.values()]
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map((message) => ({
          author: message.author?.tag || 'Unbekannt',
          avatar: message.author?.displayAvatarURL?.({ extension: 'png', size: 64 }) || null,
          content: message.content || '(kein Text)',
          timestamp: message.createdTimestamp,
          bot: Boolean(message.author?.bot)
        }))];
    }));
    const channelMessages = Object.fromEntries(fetchedMessages.filter(Boolean));

    const voiceChannels = guild.channels.cache
      .filter((channel) => channel && channel.isVoiceBased && typeof channel.join === 'function')
      .map((channel) => ({ id: channel.id, name: channel.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const members = guild.members.cache
      .filter((member) => member && member.user)
      .map((member) => ({
        id: member.id,
        username: member.user?.username || 'Unbekannt',
        tag: member.user?.tag || 'Unbekannt',
          displayName: member.displayName || member.user?.username || 'Unbekannt',
        avatar: member.displayAvatarURL?.({ extension: 'png', size: 64 }) || member.user?.displayAvatarURL?.({ extension: 'png', size: 64 }) || null,
        bot: Boolean(member.user.bot),
        roleIds: [...(member.roles?.cache?.keys?.() || [])],
        highestRoleName: member.roles?.highest?.name || '@everyone',
        highestRolePosition: member.roles?.highest?.position || 0
      }))
      .sort((a, b) => b.highestRolePosition - a.highestRolePosition || a.username.localeCompare(b.username));

    const guildData = {
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL?.({ extension: 'png', size: 128 }) || null,
      memberCount: guild.memberCount,
      roleCount: guild.roles.cache.filter((role) => role && role.name !== '@everyone').size,
      channels: textChannels,
      channelMessages,
      voiceChannels,
      members,
      roles: guild.roles.cache
        .filter((role) => role && role.name !== '@everyone')
        .map((role) => ({
          id: role.id,
          name: role.name,
            position: role.position,
          color: role.color,
          mentionable: role.mentionable,
          hoist: role.hoist
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    };

    guilds.push(guildData);
  }

  state.guildDataCache = guilds.sort((a, b) => a.name.localeCompare(b.name));
  state.guildDataCacheAt = Date.now();
  return state.guildDataCache;
}

async function registerSlashCommands(client) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!clientId || !guildId || !client.application) return;

  const rest = new REST({ version: '10' }).setToken(getToken());
  const commands = [
    new SlashCommandBuilder()
      .setName('verify')
      .setDescription('Autorisiert dich für das Dashboard.')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('dm')
      .setDescription('Sendet eine Direktnachricht an einen User.')
      .addUserOption((option) => option.setName('user').setDescription('User').setRequired(true))
      .addStringOption((option) => option.setName('text').setDescription('Nachricht').setRequired(true))
      .toJSON()
  ];

  try {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('Slash-Commands registered');
  } catch (error) {
    console.error('Failed to register slash commands:', error.message);
  }
}

async function sendDirectMessage(userId, text) {
  if (!state.client) return null;
  const user = await state.client.users.fetch(userId).catch(() => null);
  if (!user) return null;
  await user.send(String(text).slice(0, 2000));
  return user;
}

function logAction(type, message, meta = {}) {
  addLog({
    type,
    message,
    ...meta
  }, process.cwd());
}

async function generateAiReply(message) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY fehlt.');

  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 500,
      messages: [
        { role: 'system', content: 'Du bist ein freundlicher Discord-Bot. Antworte kurz, hilfreich und auf Deutsch.' },
        { role: 'user', content: String(message.content).slice(0, 4000) }
      ]
    })
  });

  if (!response.ok) throw new Error(`KI API Fehler: ${response.status}`);
  const data = await response.json();
  return String(data.choices?.[0]?.message?.content || '').trim().slice(0, 2000);
}

function stopBotClient() {
  const client = state.client;

  if (!client) {
    state.botStatus = 'offline';
    state.startedAt = null;
    state.voiceChannelId = null;
    state.client = null;
    return;
  }

  try {
    for (const guild of client.guilds.cache.values()) {
      const connection = getVoiceConnection(guild.id);
      if (connection) connection.destroy();
    }

    client.removeAllListeners();
    client.destroy();
  } catch (error) {
    console.error('Failed to destroy client:', error.message);
  }

  state.client = null;
  state.botStatus = 'offline';
  state.startedAt = null;
  state.voiceChannelId = null;
}

function connectBot(token) {
  if (!token || state.client) return state.client;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent
    ]
  });

  client.once('ready', async () => {
    state.botStatus = 'online';
    state.startedAt = new Date();
    state.lastAction = { type: 'success', text: `Bot online: ${client.user.tag}` };
    logAction('bot_ready', `Bot online: ${client.user.tag}`);
    await registerSlashCommands(client);
  });

  client.on('messageCreate', (message) => {
    if (message.author.bot) return;
    if (message.channel.isDMBased?.()) {
      const userId = message.author.id;
      const thread = state.dmThreads.get(userId) || {
        userId,
        username: message.author.tag,
        messages: []
      };
      thread.username = message.author.tag;
      thread.messages.push({
        author: message.author.tag,
        avatar: message.author.displayAvatarURL?.({ extension: 'png', size: 64 }) || null,
        content: message.content || '(kein Text)',
        timestamp: message.createdTimestamp,
        bot: false
      });
      thread.messages = thread.messages.slice(-30);
      state.dmThreads.set(userId, thread);
      logAction('dm_received', `DM von ${message.author.tag}`);
      return;
    }
    logAction('message_received', `${message.author.tag} schrieb in #${message.channel.name}: ${message.content || '(kein Text)'}`, {
      author: message.author.tag,
      channel: message.channel.name,
      guild: message.guild?.name || 'Unbekannt'
    });
    if (state.aiEnabled && message.guild && message.channel.id === state.aiChannelId) {
      generateAiReply(message)
        .then((reply) => reply ? message.channel.send(reply) : null)
        .then(() => {
          state.lastAction = { type: 'success', text: `KI hat in #${message.channel.name} geantwortet.` };
          logAction('ai_reply', `KI antwortete in #${message.channel.name}`);
        })
        .catch((error) => {
          console.error('AI reply failed:', error.message);
          state.lastAction = { type: 'error', text: 'KI-Antwort konnte nicht erstellt werden.' };
          logAction('ai_error', error.message);
        });
    }
    if (message.content === '!ping') {
      message.reply('Pong!');
      logAction('message_command', `!ping von ${message.author.tag} in #${message.channel.name}`);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'verify') {
      const userId = interaction.user.id;
      addAuthorized(userId, process.cwd());
      logAction('verify', `${interaction.user.tag} verified dashboard access`);
      await interaction.reply({
        content: `✅ Du bist jetzt für das Dashboard freigeschaltet. ${process.env.DASHBOARD_URL || 'http://localhost:3000'}`,
        ephemeral: true
      });
      return;
    }

    if (interaction.commandName === 'dm') {
      const targetUser = interaction.options.getUser('user');
      const text = interaction.options.getString('text');
      const ownerIds = getOwnerIds();
      const canUse = ownerIds.includes(interaction.user.id) || interaction.user.id === '1430522427884179566';
      if (!canUse) {
        await interaction.reply({ content: '❌ Du bist nicht berechtigt, DMs zu senden.', ephemeral: true });
        return;
      }
      await sendDirectMessage(targetUser.id, text);
      logAction('dm', `${interaction.user.tag} sent DM to ${targetUser.tag}`);
      await interaction.reply({ content: `✅ DM an ${targetUser.tag} wurde gesendet.`, ephemeral: true });
    }
  });

  client.on('voiceStateUpdate', (oldState, newState) => {
    const memberName = newState.member?.user?.tag || 'Unbekannt';
    if (!oldState.channelId && newState.channelId) {
      logAction('voice_join', `${memberName} joined voice channel ${newState.channel?.name || 'unknown'}`);
    }
    if (oldState.channelId && !newState.channelId) {
      logAction('voice_leave', `${memberName} left voice channel ${oldState.channel?.name || 'unknown'}`);
    }
  });

  client.on('guildMemberAdd', (member) => {
    logAction('member_join', `${member.user.tag} joined ${member.guild.name}`);
  });

  client.on('guildMemberRemove', (member) => {
    logAction('member_leave', `${member.user.tag} left ${member.guild.name}`);
  });

  client.on('guildMemberUpdate', (oldMember, newMember) => {
    const oldRoles = new Set(oldMember.roles.cache.keys());
    const newRoles = new Set(newMember.roles.cache.keys());
    const addedRoles = [...newRoles].filter((roleId) => !oldRoles.has(roleId));
    const removedRoles = [...oldRoles].filter((roleId) => !newRoles.has(roleId));

    addedRoles.forEach((roleId) => {
      const role = newMember.guild.roles.cache.get(roleId);
      if (role) logAction('role_assigned', `${newMember.user.tag} bekam die Rolle ${role.name} in ${newMember.guild.name}`, {
        user: newMember.user.tag,
        role: role.name,
        guild: newMember.guild.name
      });
    });
    removedRoles.forEach((roleId) => {
      const role = oldMember.guild.roles.cache.get(roleId);
      if (role) logAction('role_removed', `${newMember.user.tag} verlor die Rolle ${role.name} in ${newMember.guild.name}`, {
        user: newMember.user.tag,
        role: role.name,
        guild: newMember.guild.name
      });
    });
  });

  client.on('error', (error) => {
    console.error('Discord client error:', error);
    state.botStatus = 'error';
    state.lastAction = { type: 'error', text: 'Discord-Verbindung fehlgeschlagen.' };
    logAction('bot_error', error.message || 'Discord error');
  });

  client.on('disconnect', () => {
    state.botStatus = 'offline';
    state.startedAt = null;
    state.voiceChannelId = null;
    if (state.client === client) {
      state.client = null;
    }
  });

  client.login(token).catch((error) => {
    console.error('Login failed:', error.message);
    state.botStatus = 'error';
    state.lastAction = { type: 'error', text: 'Token ungültig oder Login fehlgeschlagen.' };
    logAction('bot_login_error', error.message || 'Login failed');
  });

  state.client = client;
  return client;
}

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = getUserByName(username);

  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).render('login', { error: 'Benutzername oder Passwort ist falsch.' });
  }

  if (!String(user.password).startsWith('sha256:')) {
    const users = loadUsers();
    const storedUser = users.find((item) => item.username === user.username);
    if (storedUser) {
      storedUser.password = hashPassword(password);
      saveUsers(users);
    }
  }

  req.session.user = publicUser(user);
  res.redirect('/');
});

app.post('/quick-admin-login', (req, res) => {
  ensureUsersFile();
  const users = loadUsers();
  const existingAdmin = users.find((user) => user.username === 'admin');

  if (!existingAdmin) {
    users.push({
      username: 'admin',
      password: hashPassword('admin123'),
      permissions: [...DEFAULT_PERMISSIONS]
    });
    saveUsers(users);
  }

  req.session.user = {
    username: 'admin',
    permissions: [...DEFAULT_PERMISSIONS]
  };
  res.redirect('/');
});

app.get('/', requireAuth, async (req, res) => {
  if (!hasAnyPermission(req.session.user)) {
    return res.status(403).send('Dein Benutzerkonto hat noch keine Dashboard-Rechte. Bitte einen Admin kontaktieren.');
  }

  const token = getToken();
  if (!token) {
    if (!req.session.user.permissions.includes('settings')) {
      return res.status(403).send('Der Bot wurde noch nicht eingerichtet. Dafür brauchst du das Recht Einstellungen.');
    }
    return res.render('setup', { error: null, user: req.session.user });
  }

  const botInfo = state.client?.user
    ? {
        username: state.client.user.username,
        tag: state.client.user.tag,
        status: state.botStatus
      }
    : {
        username: 'Nicht verbunden',
        tag: '—',
        status: state.botStatus
      };

  const guilds = await buildGuildData(state.client);
  const activeTab = String(req.query.tab || 'overview').trim() || 'overview';
  const dashboardStats = {
    guildCount: guilds.length,
    memberCount: guilds.reduce((total, guild) => total + (guild.memberCount || 0), 0),
    channelCount: guilds.reduce((total, guild) => total + guild.channels.length, 0),
    roleCount: guilds.reduce((total, guild) => total + guild.roleCount, 0),
    voiceChannelCount: guilds.reduce((total, guild) => total + guild.voiceChannels.length, 0),
    uptime: state.startedAt && state.botStatus === 'online'
      ? formatDuration(Date.now() - state.startedAt.getTime())
      : 'Nicht aktiv'
  };

  res.render('dashboard', {
    botInfo,
    tokenPresent: true,
    guilds,
    dashboardStats,
    statusMessage: state.lastAction,
    currentUser: req.session.user,
    users: loadUsers().map((user) => publicUser(user)),
    logs: readLogs(process.cwd())
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 100),
    authorizedUsers: readAuthorized(process.cwd()),
    permissionLabels,
    logTypeLabels,
    defaultPermissions: DEFAULT_PERMISSIONS,
    hasPermission: (permission) => (req.session.user.permissions || []).includes(permission),
    ownerIds: getOwnerIds(),
    joinedVoiceChannelId: state.voiceChannelId || null,
    dmThreads: [...state.dmThreads.values()],
    aiSettings: {
      guildId: state.aiGuildId,
      channelId: state.aiChannelId,
      enabled: state.aiEnabled,
      configured: Boolean(process.env.OPENAI_API_KEY)
    },
    activeTab
  });
});

app.post('/setup', requireAuth, requirePermission('settings'), (req, res) => {
  const token = (req.body.token || '').trim();
  if (!token) {
    return res.render('setup', { error: 'Bitte gib einen gültigen Token ein.' });
  }

  saveToken(token, process.cwd());
  state.lastAction = { type: 'success', text: 'Token gespeichert. Der Bot kann jetzt gestartet werden.' };
  logAction('token_saved', 'Token saved for bot dashboard');
  res.redirect('/');
});

app.post('/logout', requireAuth, requirePermission('settings'), (req, res) => {
  const configPath = path.join(DATA_DIR, 'config.json');
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  stopBotClient();
  state.lastAction = { type: 'info', text: 'Token gelöscht. Gib einen neuen Bot-Token ein.' };
  logAction('token_deleted', 'Token deleted by admin');
  req.session.destroy(() => res.redirect('/login'));
});

app.post('/start-bot', requireAuth, requirePermission('settings'), (req, res) => {
  const token = getToken();
  if (!token) return res.redirect('/');
  if (state.client) {
    state.lastAction = { type: 'info', text: 'Der Bot ist bereits verbunden.' };
    return res.redirect('/');
  }

  connectBot(token);
  res.redirect('/');
});

app.post('/stop-bot', requireAuth, requirePermission('settings'), async (req, res) => {
  stopBotClient();
  state.lastAction = { type: 'info', text: 'Bot gestoppt.' };
  logAction('bot_stopped', 'Bot manually stopped from dashboard');
  res.redirect('/');
});

app.post('/send-message', requireAuth, requirePermission('messages'), async (req, res) => {
  const ajax = req.get('X-Requested-With') === 'XMLHttpRequest';
  if (!getToken() || !state.client) {
    state.lastAction = { type: 'error', text: 'Bot ist nicht verbunden.' };
    if (ajax) return res.status(409).json({ ok: false, message: state.lastAction.text });
    return res.redirect('/');
  }

  const channelId = String(req.body.channelId || '').trim();
  const text = String(req.body.message || '').trim();

  if (!channelId || !text) {
    state.lastAction = { type: 'error', text: 'Wähle einen Kanal und schreibe eine Nachricht.' };
    if (ajax) return res.status(400).json({ ok: false, message: state.lastAction.text });
    return res.redirect('/');
  }

  try {
    const channel = state.client.channels.cache.get(channelId) || await state.client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== 'function') throw new Error('Kanal gefunden, aber keine Sendefunktion vorhanden.');

    const parsedText = parseMentionText(text, channel.guild || null);
    await channel.send(parsedText);
    state.guildDataCache = null;
    state.guildDataCacheAt = 0;
    logAction('message_sent', `Message sent to #${channel.name}`, { channel: channel.name });
    state.lastAction = { type: 'success', text: `Nachricht an #${channel.name} gesendet.` };
    if (ajax) return res.json({ ok: true, message: state.lastAction.text, channelId, text: parsedText });
  } catch (error) {
    console.error('Send message failed:', error);
    state.lastAction = { type: 'error', text: 'Nachricht konnte nicht gesendet werden.' };
    if (ajax) return res.status(500).json({ ok: false, message: state.lastAction.text });
  }

  res.redirect('/');
});

app.post('/send-dm', requireAuth, requirePermission('messages'), async (req, res) => {
  const ajax = req.get('X-Requested-With') === 'XMLHttpRequest';
  const userId = String(req.body.userId || '').trim();
  const text = String(req.body.message || '').trim();

  if (!userId || !text) {
    state.lastAction = { type: 'error', text: 'Bitte User und Text angeben.' };
    if (ajax) return res.status(400).json({ ok: false, message: state.lastAction.text });
    return res.redirect('/');
  }

  try {
    await sendDirectMessage(userId, text);
    state.guildDataCache = null;
    state.guildDataCacheAt = 0;
    logAction('dm_sent', `DM sent to user ${userId}`);
    state.lastAction = { type: 'success', text: 'DM wurde gesendet.' };
    if (ajax) return res.json({ ok: true, message: state.lastAction.text, userId, text });
  } catch (error) {
    state.lastAction = { type: 'error', text: 'DM konnte nicht gesendet werden.' };
    if (ajax) return res.status(500).json({ ok: false, message: state.lastAction.text });
  }

  res.redirect('/');
});

app.post('/ai-channel', requireAuth, requirePermission('commands'), (req, res) => {
  const guildId = String(req.body.guildId || '').trim();
  const channelId = String(req.body.channelId || '').trim();
  const enabled = req.body.enabled === 'on';
  const channel = state.client?.channels.cache.get(channelId);

  if (!guildId || !channelId || !channel || channel.guild?.id !== guildId || !channel.isTextBased?.()) {
    state.lastAction = { type: 'error', text: 'Bitte einen gültigen Textkanal auswählen.' };
    return res.redirect('/');
  }

  state.aiGuildId = guildId;
  state.aiChannelId = channelId;
  state.aiEnabled = enabled;
  state.lastAction = {
    type: 'success',
    text: enabled ? `KI-Antworten für #${channel.name} aktiviert.` : 'KI-Antworten pausiert.'
  };
  logAction(enabled ? 'ai_enabled' : 'ai_disabled', `${enabled ? 'Enabled' : 'Disabled'} AI in #${channel.name}`);
  res.redirect('/');
});

app.post('/reorder-role', requireAuth, requirePermission('roles'), async (req, res) => {
  const guildId = String(req.body.guildId || '').trim();
  const roleId = String(req.body.roleId || '').trim();
  const direction = String(req.body.direction || '').trim();
  const rawTargetPosition = req.body.targetPosition;

  if (!guildId || !roleId || !state.client) {
    state.lastAction = { type: 'error', text: 'Bitte Server und Rolle auswählen.' };
    return res.redirect('/');
  }

  try {
    const guild = state.client.guilds.cache.get(guildId);
    const role = guild?.roles.cache.get(roleId);
    if (!guild || !role) throw new Error('Rolle oder Server nicht gefunden.');

    const orderedRoles = guild.roles.cache
      .filter((item) => item && item.id !== guild.id)
      .sort((a, b) => a.position - b.position);

    const currentIndex = orderedRoles.findIndex((item) => item.id === role.id);
    if (currentIndex === -1) throw new Error('Rolle nicht in der Reihenfolge gefunden.');

    let targetIndex = currentIndex;

    if (direction === 'up') {
      targetIndex = Math.max(0, currentIndex - 1);
    } else if (direction === 'down') {
      targetIndex = Math.min(orderedRoles.length - 1, currentIndex + 1);
    } else if (rawTargetPosition !== undefined && rawTargetPosition !== null && String(rawTargetPosition).trim() !== '') {
      const targetPosition = Number(rawTargetPosition);
      if (!Number.isInteger(targetPosition) || targetPosition < 1 || targetPosition > orderedRoles.length) {
        throw new Error('Bitte eine gültige Reihenfolge von 1 bis ' + orderedRoles.length + ' eingeben.');
      }
      targetIndex = targetPosition - 1;
    }

    if (targetIndex === currentIndex) {
      state.lastAction = { type: 'info', text: `Rolle ${role.name} steht bereits an dieser Position.` };
      return res.redirect('/');
    }

    const targetRole = orderedRoles[targetIndex];
    if (!targetRole) throw new Error('Zielposition nicht gefunden.');

    await role.setPosition(targetRole.position);
    logAction('role_reordered', `Role ${role.name} moved to position ${targetIndex + 1} in ${guild.name}`);
    state.lastAction = { type: 'success', text: `Rolle ${role.name} wurde auf Position ${targetIndex + 1} gesetzt.` };
  } catch (error) {
    console.error('Reorder role failed:', error);
    state.lastAction = { type: 'error', text: error.message || 'Rolle konnte nicht sortiert werden.' };
  }

  res.redirect('/');
});

app.post('/voice/join', requireAuth, requirePermission('voice'), async (req, res) => {
  const guildId = String(req.body.guildId || '').trim();
  const channelId = String(req.body.channelId || '').trim();

  if (!guildId || !channelId || !state.client) {
    state.lastAction = { type: 'error', text: 'Bot oder Voice-Kanal nicht verfügbar.' };
    return res.redirect('/');
  }

  try {
    const guild = state.client.guilds.cache.get(guildId);
    const channel = guild ? guild.channels.cache.get(channelId) : null;
    if (!guild || !channel || !channel.isVoiceBased?.()) throw new Error('Voice-Kanal ungültig.');

    joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false
    });
    state.voiceChannelId = channelId;
    logAction('voice_join', `Bot joined ${channel.name} in ${guild.name}`);
    state.lastAction = { type: 'success', text: `Bot ist dem Voicekanal ${channel.name} beigetreten.` };
  } catch (error) {
    console.error('Voice join failed:', error);
    state.lastAction = { type: 'error', text: 'Voice-Kanal konnte nicht betreten werden.' };
  }

  res.redirect('/');
});

app.post('/voice/leave', requireAuth, requirePermission('voice'), async (req, res) => {
  if (!state.client) {
    state.lastAction = { type: 'error', text: 'Bot ist nicht verbunden.' };
    return res.redirect('/');
  }

  try {
    const guildId = String(req.body.guildId || '').trim();
    let connection = guildId ? getVoiceConnection(guildId) : null;
    if (!connection) {
      for (const guild of state.client.guilds.cache.values()) {
        connection = getVoiceConnection(guild.id);
        if (connection) break;
      }
    }
    if (connection) {
      connection.destroy();
      state.voiceChannelId = null;
      logAction('voice_leave', 'Bot left voice channel');
      state.lastAction = { type: 'success', text: 'Bot hat den Voicekanal verlassen.' };
    } else {
      state.lastAction = { type: 'info', text: 'Es ist derzeit kein Voicekanal aktiv.' };
    }
  } catch (error) {
    state.lastAction = { type: 'error', text: 'Voice-Kanal konnte nicht verlassen werden.' };
  }

  res.redirect('/');
});

app.post('/edit-role', requireAuth, requirePermission('roles'), async (req, res) => {
  const token = getToken();
  if (!token || !state.client) {
    state.lastAction = { type: 'error', text: 'Bot ist nicht verbunden.' };
    return res.redirect('/');
  }

  const guildId = String(req.body.guildId || '').trim();
  const roleId = String(req.body.roleId || '').trim();
  const name = String(req.body.roleName || '').trim();
  const color = String(req.body.roleColor || '').trim();
  const hoist = req.body.hoist === 'on';
  const mentionable = req.body.mentionable === 'on';

  if (!guildId || !roleId) {
    state.lastAction = { type: 'error', text: 'Bitte Server und Rolle auswählen.' };
    return res.redirect('/');
  }

  try {
    const guild = state.client.guilds.cache.get(guildId);
    const role = guild?.roles.cache.get(roleId);
    if (!role) throw new Error('Rolle nicht gefunden.');

    const updates = { hoist, mentionable };
    if (name) updates.name = name;
    if (color) {
      const clean = color.replace('#', '').trim();
      if (/^[0-9a-fA-F]{6}$/.test(clean)) updates.color = parseInt(clean, 16);
    }

    await role.edit(updates);
    logAction('role_edited', `Role ${role.name} edited`);
    state.lastAction = { type: 'success', text: `Rolle ${role.name} erfolgreich bearbeitet.` };
  } catch (error) {
    console.error('Edit role failed:', error);
    state.lastAction = { type: 'error', text: 'Rolle konnte nicht bearbeitet werden.' };
  }

  res.redirect('/');
});

app.post('/assign-role', requireAuth, requirePermission('roles'), async (req, res) => {
  const guildId = String(req.body.guildId || '').trim();
  const memberId = String(req.body.memberId || '').trim();
  const roleId = String(req.body.roleId || '').trim();
  const ajax = req.get('X-Requested-With') === 'XMLHttpRequest';
  let succeeded = false;

  if (!guildId || !memberId || !roleId || !state.client) {
    state.lastAction = { type: 'error', text: 'Bitte Server, User und Rolle auswählen.' };
    return res.redirect('/');
  }

  try {
    const guild = state.client.guilds.cache.get(guildId);
    const member = guild?.members.cache.get(memberId);
    const role = guild?.roles.cache.get(roleId);
    if (!member || !role) throw new Error('Mitglied oder Rolle nicht gefunden.');

    await member.roles.add(role);
    succeeded = true;
    logAction('role_assigned', `${member.user.tag} got role ${role.name}`);
    state.lastAction = { type: 'success', text: `Rolle ${role.name} wurde zu ${member.user.tag} hinzugefügt.` };
  } catch (error) {
    console.error('Assign role failed:', error);
    state.lastAction = { type: 'error', text: 'Rolle konnte nicht zugewiesen werden.' };
  }

  if (ajax) return res.json({ ok: succeeded, action: 'assigned', roleId, memberId, message: state.lastAction.text });
  res.redirect('/');
});

app.post('/remove-role', requireAuth, requirePermission('roles'), async (req, res) => {
  const guildId = String(req.body.guildId || '').trim();
  const memberId = String(req.body.memberId || '').trim();
  const roleId = String(req.body.roleId || '').trim();
  const ajax = req.get('X-Requested-With') === 'XMLHttpRequest';
  let succeeded = false;

  if (!guildId || !memberId || !roleId || !state.client) {
    state.lastAction = { type: 'error', text: 'Bitte Server, User und Rolle auswählen.' };
    return res.redirect('/');
  }

  try {
    const guild = state.client.guilds.cache.get(guildId);
    const member = guild?.members.cache.get(memberId);
    const role = guild?.roles.cache.get(roleId);
    if (!member || !role) throw new Error('Mitglied oder Rolle nicht gefunden.');

    await member.roles.remove(role);
    succeeded = true;
    logAction('role_removed', `${member.user.tag} lost role ${role.name}`);
    state.lastAction = { type: 'success', text: `Rolle ${role.name} wurde von ${member.user.tag} entfernt.` };
  } catch (error) {
    console.error('Remove role failed:', error);
    state.lastAction = { type: 'error', text: 'Rolle konnte nicht entfernt werden.' };
  }

  if (ajax) return res.json({ ok: succeeded, action: 'removed', roleId, memberId, message: state.lastAction.text });
  res.redirect('/');
});

app.post('/moderation', requireAuth, requirePermission('server'), async (req, res) => {
  const guildId = String(req.body.guildId || '').trim();
  const memberId = String(req.body.memberId || '').trim();
  const action = String(req.body.action || '').trim();
  const reason = String(req.body.reason || '').trim() || 'Dashboard-Moderation';

  if (!guildId || !memberId || !['warn', 'timeout', 'kick', 'ban'].includes(action) || !state.client) {
    state.lastAction = { type: 'error', text: 'Server, User und Moderationsaktion auswählen.' };
    return res.redirect('/');
  }

  try {
    const guild = state.client.guilds.cache.get(guildId);
    const member = guild?.members.cache.get(memberId) || await guild?.members.fetch(memberId).catch(() => null);
    if (!guild || !member) throw new Error('Mitglied nicht gefunden.');
    if (member.id === guild.ownerId) throw new Error('Der Serverbesitzer kann nicht moderiert werden.');

    if (action === 'warn') {
      logAction('member_warned', `${member.user.tag} warned in ${guild.name}`, { reason });
      state.lastAction = { type: 'success', text: `${member.user.tag} wurde verwarnt.` };
    } else if (action === 'timeout') {
      const minutes = Math.min(Math.max(Number(req.body.duration || 10), 1), 40320);
      await member.timeout(minutes * 60 * 1000, reason);
      logAction('member_timeout', `${member.user.tag} timed out for ${minutes} minutes`, { reason });
      state.lastAction = { type: 'success', text: `${member.user.tag} hat ${minutes} Minuten Timeout erhalten.` };
    } else if (action === 'kick') {
      await member.kick(reason);
      logAction('member_kicked', `${member.user.tag} kicked from ${guild.name}`, { reason });
      state.lastAction = { type: 'success', text: `${member.user.tag} wurde gekickt.` };
    } else {
      await member.ban({ reason, deleteMessageSeconds: 0 });
      logAction('member_banned', `${member.user.tag} banned from ${guild.name}`, { reason });
      state.lastAction = { type: 'success', text: `${member.user.tag} wurde gebannt.` };
    }
    state.guildDataCache = null;
    state.guildDataCacheAt = 0;
  } catch (error) {
    console.error('Moderation failed:', error);
    state.lastAction = { type: 'error', text: error.message || 'Moderationsaktion konnte nicht ausgeführt werden.' };
  }

  res.redirect('/');
});

app.post('/users/create', requireAuth, requirePermission('users'), (req, res) => {
  try {
    createUser({
      username: req.body.username,
      password: req.body.password,
      permissions: req.body.permissions
    });
    logAction('user_created', `User ${req.body.username} created`);
    state.lastAction = { type: 'success', text: 'Benutzer wurde angelegt.' };
  } catch (error) {
    state.lastAction = { type: 'error', text: error.message };
  }
  return res.redirect('/');
});

app.post('/users/update', requireAuth, requirePermission('users'), (req, res) => {
  const username = String(req.body.username || '').trim();
  const users = loadUsers();
  const user = users.find((item) => item.username === username);

  if (!user) {
    state.lastAction = { type: 'error', text: 'Benutzer wurde nicht gefunden.' };
  } else if (username === req.session.user.username && !req.body.permissions) {
    state.lastAction = { type: 'error', text: 'Du kannst dir nicht alle Rechte entziehen.' };
  } else {
    user.permissions = sanitizePermissions(req.body.permissions);
    saveUsers(users);
    if (username === req.session.user.username) req.session.user.permissions = user.permissions;
    logAction('user_updated', `Updated permissions for ${username}`);
    state.lastAction = { type: 'success', text: `Rechte für ${username} wurden gespeichert.` };
  }
  res.redirect('/');
});

app.post('/users/delete', requireAuth, requirePermission('users'), (req, res) => {
  const username = String(req.body.username || '').trim();
  if (username === req.session.user.username || username === 'admin') {
    state.lastAction = { type: 'error', text: 'Der aktuelle Admin kann nicht gelöscht werden.' };
  } else {
    deleteUser(username);
    logAction('user_deleted', `User ${username} deleted`);
    state.lastAction = { type: 'success', text: `Benutzer ${username} wurde gelöscht.` };
  }
  res.redirect('/');
});

app.post('/session-logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_REDIRECT_URI) {
  app.get('/auth/discord', (req, res) => {
    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
      response_type: 'code',
      scope: 'identify guilds',
      state: 'dashboard-auth'
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
  });

  app.get('/auth/discord/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/');

    try {
      const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: process.env.DISCORD_REDIRECT_URI
        })
      });

      const tokenData = await tokenResponse.json();
      const userResponse = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const userData = await userResponse.json();
      const ownerIds = getOwnerIds();
      if (ownerIds.includes(String(userData.id))) {
        addAuthorized(userData.id, process.cwd());
        state.lastAction = { type: 'success', text: `Discord-Account ${userData.username} verifiziert.` };
      }
      res.redirect('/');
    } catch (error) {
      console.error('Discord auth callback failed:', error);
      res.redirect('/');
    }
  });
}

ensureDashboardData();
const existingToken = getToken();
if (existingToken) connectBot(existingToken);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard läuft auf http://localhost:${PORT}`);
});

