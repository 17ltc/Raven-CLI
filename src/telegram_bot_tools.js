'use strict';

class RavenTelegramBridge {
  constructor(token, cli, opts = {}) {
    this.token = token;
    this.cli = cli;
    this.prefix = opts.prefix || '/raven';
    this.chatIds = new Set((opts.chat_ids || []).map(String).filter(Boolean));
    this.ownerIds = new Set((opts.owner_ids || []).map(String).filter(Boolean));
    this.polling = opts.polling !== false;
    this.bot = null;
    this.running = false;
    this.processing = new Set();
  }

  async start() {
    if (this.running) return { success: true, status: 'already running', prefix: this.prefix };
    let TelegramBot;
    try {
      TelegramBot = require('node-telegram-bot-api');
    } catch (e) {
      return { success: false, error: 'node-telegram-bot-api is not installed. Run npm install first.' };
    }
    this.bot = new TelegramBot(this.token, { polling: this.polling });
    this.bot.on('message', (message) => this._handleMessage(message).catch(() => {}));
    this.running = true;
    return { success: true, status: 'running', prefix: this.prefix, chats: [...this.chatIds], owners: [...this.ownerIds] };
  }

  stop() {
    if (this.bot) {
      try {
        this.bot.stopPolling();
      } catch (e) {
        /* ignore */
      }
      this.bot = null;
    }
    this.running = false;
    return { success: true, status: 'stopped' };
  }

  status() {
    return { running: this.running, prefix: this.prefix, chats: [...this.chatIds], owners: [...this.ownerIds], polling: this.polling };
  }

  async _handleMessage(message) {
    if (!message || !message.text || !message.chat) return;
    const chatId = String(message.chat.id);
    const userId = String(message.from && message.from.id);
    if (this.chatIds.size && !this.chatIds.has(chatId)) return;
    if (this.ownerIds.size && !this.ownerIds.has(userId)) return;
    const content = String(message.text || '').trim();
    if (!content.toLowerCase().startsWith(this.prefix.toLowerCase())) return;
    const text = content.slice(this.prefix.length).trim() || '/help';
    const key = `${chatId}:${message.message_id}`;
    if (this.processing.has(key)) return;
    this.processing.add(key);
    try {
      await this.bot.sendMessage(chatId, 'Raven travaille dessus...', { reply_to_message_id: message.message_id });
      const output = await this.cli.processExternal(text, { source: 'telegram', chat_id: chatId, user_id: userId });
      await this._sendLong(chatId, output || 'Done.', message.message_id);
    } catch (e) {
      await this._sendLong(chatId, `Erreur Raven: ${e.message || e}`, message.message_id);
    } finally {
      this.processing.delete(key);
    }
  }

  async _sendLong(chatId, text, replyTo = null) {
    const clean = String(text || '').slice(0, 8000);
    const chunks = clean.match(/[\s\S]{1,3900}/g) || [''];
    for (let i = 0; i < chunks.length; i++) {
      const opts = i === 0 && replyTo ? { reply_to_message_id: replyTo } : {};
      await this.bot.sendMessage(chatId, chunks[i], opts);
    }
  }
}

let singleton = null;

function getTelegramBridge(token, cli, opts) {
  if (!singleton) singleton = new RavenTelegramBridge(token, cli, opts);
  else {
    singleton.token = token || singleton.token;
    singleton.cli = cli;
    singleton.prefix = opts && opts.prefix || singleton.prefix;
    if (opts && opts.owner_ids) singleton.ownerIds = new Set(opts.owner_ids.map(String));
    if (opts && opts.chat_ids) singleton.chatIds = new Set(opts.chat_ids.map(String));
  }
  return singleton;
}

module.exports = { RavenTelegramBridge, getTelegramBridge };
