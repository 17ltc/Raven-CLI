'use strict';
/**
 * Read-only Discord bot client scoped to configured guild and channels.
 * Port of Raven/discord_bot_tools.py
 *
 * Uses discord.js gateway mode when installed, with REST polling as a
 * dependency-free fallback.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { HumanConfirmation } = require('./confirmation');

const API = 'https://discord.com/api/v10';

class DiscordTools {
  constructor(token, guildId = '', channelIds = null) {
    this.token = token;
    this.guildId = guildId;
    this.channelIds = new Set(channelIds || []);
    this.confirmation = new HumanConfirmation();
  }

  async _get(p, params = {}) {
    const query = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null))
    ).toString();
    const url = `${API}${p}${query ? `?${query}` : ''}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const resp = await fetch(url, { headers: { Authorization: `Bot ${this.token}` }, signal: controller.signal });
      if (resp.status >= 400) {
        const text = (await resp.text().catch(() => '')).slice(0, 300);
        return { error: `Discord API ${resp.status}: ${text}` };
      }
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async _post(p, body = {}) {
    const url = `${API}${p}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bot ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (resp.status >= 400) {
        const text = (await resp.text().catch(() => '')).slice(0, 300);
        return { error: `Discord API ${resp.status}: ${text}` };
      }
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async _approved(action) {
    return this.confirmation.require(action);
  }

  async listGuilds() {
    if (!(await this._approved('list Discord servers accessible to the bot'))) return { status: 'denied' };
    const guilds = await this._get('/users/@me/guilds');
    if (guilds && guilds.error) return guilds;
    return { guilds: guilds.map((g) => ({ id: g.id, name: g.name })) };
  }

  async configureScope(guildId, channelIds) {
    if (!guildId || !channelIds || !channelIds.length) {
      return { error: 'guild_id and at least one channel_id are required' };
    }
    const isDigits = (s) => /^\d+$/.test(String(s));
    if (!isDigits(guildId) || channelIds.some((c) => !isDigits(c))) {
      return { error: 'Discord IDs must contain digits only' };
    }
    if (!(await this._approved(`save Discord scope guild=${guildId} channels=${channelIds.length}`))) {
      return { status: 'denied' };
    }
    const configPath = path.join(os.homedir(), '.raven', 'config.json');
    try {
      let data = {};
      if (fs.existsSync(configPath)) {
        data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
      data.discord = data.discord || {};
      Object.assign(data.discord, {
        enabled: true,
        token_env: 'DISCORD_BOT_TOKEN',
        guild_id: guildId,
        channel_ids: [...channelIds],
      });
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8');
      this.guildId = guildId;
      this.channelIds = new Set(channelIds);
      return { status: 'saved', guild_id: guildId, channel_ids: channelIds };
    } catch (e) {
      return { error: e.message };
    }
  }

  async guildChannels() {
    if (!this.guildId) return { error: 'No Discord server configured. Use discord_list_guilds then discord_configure_scope.' };
    if (!(await this._approved('list Discord channels'))) return { status: 'denied' };
    const channels = await this._get(`/guilds/${this.guildId}/channels`);
    if (channels && channels.error) return channels;
    const wanted = new Set([0, 5, 10, 11, 12]);
    return {
      channels: channels.filter((c) => wanted.has(c.type)).map((c) => ({ id: c.id, name: c.name, type: c.type })),
    };
  }

  async lookupUser(userId) {
    if (!(await this._approved(`look up Discord user ${userId}`))) return { status: 'denied' };
    return this._get(`/users/${userId}`);
  }

  async searchMessages(query, channelId = '', authorId = '', limit = 50) {
    if (!query || !query.trim()) return { error: 'query is required' };
    if (channelId && this.channelIds.size && !this.channelIds.has(channelId)) {
      return { error: 'channel is outside the configured Discord scope' };
    }
    if (!(await this._approved(`search Discord messages for '${query.slice(0, 80)}'`))) {
      return { status: 'denied' };
    }
    const targets = channelId ? [channelId] : [...this.channelIds].sort();
    if (!targets.length) return { error: 'configure channel_ids or provide a channel_id' };

    const matches = [];
    for (const target of targets) {
      let before = null;
      for (let i = 0; i < 4; i++) {
        const params = { limit: Math.min(Math.max(limit, 1), 100) };
        if (before) params.before = before;
        const messages = await this._get(`/channels/${target}/messages`, params);
        if (messages && messages.error) return messages;
        if (!messages || !messages.length) break;
        for (const message of messages) {
          const content = message.content || '';
          const author = message.author || {};
          if (content.toLowerCase().includes(query.toLowerCase()) && (!authorId || author.id === authorId)) {
            matches.push({
              id: message.id,
              channel_id: target,
              author_id: author.id,
              author_name: author.username,
              timestamp: message.timestamp,
              content,
            });
            if (matches.length >= Math.min(limit, 100)) return { count: matches.length, messages: matches };
          }
        }
        before = messages[messages.length - 1].id;
      }
    }
    return { count: matches.length, messages: matches };
  }

  async sendMessage(channelId, content, replyTo = '') {
    if (this.channelIds.size && !this.channelIds.has(String(channelId))) {
      return { error: 'channel is outside the configured Discord scope' };
    }
    const body = { content: String(content || '').slice(0, 2000) };
    if (replyTo) body.message_reference = { message_id: String(replyTo), fail_if_not_exists: false };
    return this._post(`/channels/${channelId}/messages`, body);
  }
}

class RavenDiscordBridge {
  constructor(discord, cli, opts = {}) {
    this.discord = discord;
    this.cli = cli;
    this.prefix = opts.prefix || '!raven';
    this.ownerIds = new Set((opts.owner_ids || []).map(String).filter(Boolean));
    this.useGateway = opts.use_gateway !== false;
    this.pollMs = Math.max(1500, Number(opts.poll_ms) || 3500);
    this.channelIds = [...discord.channelIds];
    this.lastSeen = new Map();
    this.timer = null;
    this.running = false;
    this.me = null;
    this.processing = new Set();
    this.client = null;
    this.mode = 'rest-polling';
  }

  async start() {
    if (this.running) return { success: true, status: 'already running', prefix: this.prefix };
    if (!this.channelIds.length) return { success: false, error: 'No Discord channels configured' };
    if (this.useGateway) {
      const gateway = await this._startGateway();
      if (gateway.success) return gateway;
    }
    this.me = await this.discord._get('/users/@me');
    if (this.me && this.me.error) return { success: false, error: this.me.error };
    for (const channelId of this.channelIds) {
      const messages = await this.discord._get(`/channels/${channelId}/messages`, { limit: 1 });
      if (Array.isArray(messages) && messages[0]) this.lastSeen.set(channelId, messages[0].id);
    }
    this.running = true;
    this.timer = setInterval(() => this.poll().catch(() => {}), this.pollMs);
    if (this.timer.unref) this.timer.unref();
    this.mode = 'rest-polling';
    return { success: true, status: 'running', mode: this.mode, channels: this.channelIds, prefix: this.prefix };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.running = false;
    return { success: true, status: 'stopped' };
  }

  status() {
    return { running: this.running, mode: this.mode, channels: this.channelIds, prefix: this.prefix, owners: [...this.ownerIds], poll_ms: this.pollMs };
  }

  async _startGateway() {
    let discordJs;
    try {
      discordJs = require('discord.js');
    } catch (e) {
      return { success: false, error: 'discord.js is not installed; falling back to REST polling' };
    }
    const { Client, GatewayIntentBits, Partials } = discordJs;
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel],
    });
    this.client = client;
    client.on('messageCreate', (message) => {
      this._handleGatewayMessage(message).catch(() => {});
    });
    await client.login(this.discord.token);
    this.me = client.user ? { id: client.user.id } : null;
    this.running = true;
    this.mode = 'discord.js';
    return { success: true, status: 'running', mode: this.mode, user: client.user && client.user.tag, channels: this.channelIds, prefix: this.prefix };
  }

  async poll() {
    if (!this.running) return;
    for (const channelId of this.channelIds) {
      const after = this.lastSeen.get(channelId);
      const params = { limit: 20 };
      if (after) params.after = after;
      const messages = await this.discord._get(`/channels/${channelId}/messages`, params);
      if (!Array.isArray(messages) || !messages.length) continue;
      const ordered = messages.slice().sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
      for (const message of ordered) {
        this.lastSeen.set(channelId, message.id);
        await this._handleMessage(channelId, message);
      }
    }
  }

  async _handleMessage(channelId, message) {
    if (!message || !message.content || (message.author && message.author.bot)) return;
    if (this.ownerIds.size && (!message.author || !this.ownerIds.has(String(message.author.id)))) return;
    if (this.me && message.author && message.author.id === this.me.id) return;
    const content = String(message.content || '').trim();
    const mention = this.me && this.me.id ? `<@${this.me.id}>` : '';
    let text = '';
    if (content.toLowerCase().startsWith(this.prefix.toLowerCase())) text = content.slice(this.prefix.length).trim();
    else if (mention && content.startsWith(mention)) text = content.slice(mention.length).trim();
    else return;
    if (!text) text = '/help';
    const key = `${channelId}:${message.id}`;
    if (this.processing.has(key)) return;
    this.processing.add(key);
    await this.discord.sendMessage(channelId, 'Raven travaille dessus...', message.id);
    try {
      const output = await this.cli.processExternal(text, { source: 'discord', channel_id: channelId, user_id: message.author && message.author.id });
      await this._sendLong(channelId, output || 'Done.', message.id);
    } catch (e) {
      await this._sendLong(channelId, `Erreur Raven: ${e.message || e}`, message.id);
    } finally {
      this.processing.delete(key);
    }
  }

  async _handleGatewayMessage(message) {
    if (!message || !message.content || (message.author && message.author.bot)) return;
    const channelId = String(message.channelId || (message.channel && message.channel.id) || '');
    if (this.channelIds.length && !this.channelIds.includes(channelId)) return;
    if (this.ownerIds.size && (!message.author || !this.ownerIds.has(String(message.author.id)))) return;
    const content = String(message.content || '').trim();
    const mention = this.me && this.me.id ? `<@${this.me.id}>` : '';
    let text = '';
    if (content.toLowerCase().startsWith(this.prefix.toLowerCase())) text = content.slice(this.prefix.length).trim();
    else if (mention && content.startsWith(mention)) text = content.slice(mention.length).trim();
    else return;
    if (!text) text = '/help';
    const key = `${channelId}:${message.id}`;
    if (this.processing.has(key)) return;
    this.processing.add(key);
    try {
      await message.reply('Raven travaille dessus...');
      const output = await this.cli.processExternal(text, { source: 'discord', channel_id: channelId, user_id: message.author && message.author.id });
      await this._replyLong(message, output || 'Done.');
    } catch (e) {
      await this._replyLong(message, `Erreur Raven: ${e.message || e}`);
    } finally {
      this.processing.delete(key);
    }
  }

  async _replyLong(message, text) {
    const clean = String(text || '').slice(0, 8000);
    const chunks = clean.match(/[\s\S]{1,1900}/g) || [''];
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) await message.reply(chunks[i]);
      else await message.channel.send(chunks[i]);
    }
  }

  async _sendLong(channelId, text, replyTo) {
    const clean = String(text || '').slice(0, 8000);
    const chunks = clean.match(/[\s\S]{1,1900}/g) || [''];
    for (let i = 0; i < chunks.length; i++) await this.discord.sendMessage(channelId, chunks[i], i === 0 ? replyTo : '');
  }
}

let bridgeSingleton = null;

function getDiscordBridge(discord, cli, opts) {
  if (!bridgeSingleton) bridgeSingleton = new RavenDiscordBridge(discord, cli, opts);
  else {
    bridgeSingleton.discord = discord;
    bridgeSingleton.cli = cli;
    bridgeSingleton.prefix = opts && opts.prefix || bridgeSingleton.prefix;
    if (opts && opts.owner_ids) bridgeSingleton.ownerIds = new Set(opts.owner_ids.map(String));
  }
  return bridgeSingleton;
}

module.exports = { DiscordTools, RavenDiscordBridge, getDiscordBridge };
