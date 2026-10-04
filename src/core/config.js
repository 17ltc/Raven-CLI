'use strict';
/**
 * Core Configuration Module
 * Port of Raven/core/config.py
 *
 * Settings are stored in ~/.raven/config.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function backendConfigDefaults() {
  return {
    type: 'ollama',
    base_url: '',
    api_key: '',
    model: 'llama3.1',
    temperature: 0.3,
    max_tokens: 16384,
    timeout: 300,
  };
}

function databaseConfigDefaults(name, url, readOnly = true) {
  return { name, url, read_only: readOnly, type: 'auto' };
}

function workspaceConfigDefaults() {
  return { path: '.', max_size_mb: 1024, unrestricted: false };
}

function browserConfigDefaults() {
  return { enabled: false, headless: true, user_data_dir: null };
}

function discordConfigDefaults() {
  return { enabled: false, token: '', token_env: 'DISCORD_BOT_TOKEN', guild_id: '', channel_ids: [], owner_ids: [], prefix: '!raven', use_gateway: true };
}

function telegramConfigDefaults() {
  return { enabled: false, token: '', token_env: 'TELEGRAM_BOT_TOKEN', chat_ids: [], owner_ids: [], prefix: '/raven', polling: true };
}

function apiKeysConfigDefaults() {
  return { virustotal: '', abuseipdb: '', shodan: '', openrouter: '', nvidia: '' };
}

function providerConfigDefaults() {
  return {};
}

function modelRouteDefaults() {
  return [];
}

function taskConfigDefaults() {
  return { max_concurrent: 10, queue_size: 100, timeout: 300 };
}

class CoreConfig {
  constructor(data = {}) {
    this.backend = { ...backendConfigDefaults(), ...(data.backend || {}) };
    this.databases = {};
    for (const [name, db] of Object.entries(data.databases || {})) {
      this.databases[name] = { ...databaseConfigDefaults(name, db.url), ...db };
    }
    this.workspace = { ...workspaceConfigDefaults(), ...(data.workspace || {}) };
    this.browser = { ...browserConfigDefaults(), ...(data.browser || {}) };
    this.discord = { ...discordConfigDefaults(), ...(data.discord || {}) };
    this.telegram = { ...telegramConfigDefaults(), ...(data.telegram || {}) };
    this.api_keys = { ...apiKeysConfigDefaults(), ...(data.api_keys || {}) };
    this.providers = { ...providerConfigDefaults(), ...(data.providers || {}) };
    this.model_routes = Array.isArray(data.model_routes) ? data.model_routes : modelRouteDefaults();
    this.tasks = { ...taskConfigDefaults(), ...(data.tasks || {}) };
    this.show_thinking = data.show_thinking !== undefined ? data.show_thinking : true;
    this.max_iterations = data.max_iterations !== undefined ? data.max_iterations : 32;
    this.auto_save = data.auto_save !== undefined ? data.auto_save : true;
    this.theme = data.theme || 'raven';
    this.animations = data.animations !== undefined ? data.animations : true;
    this.prompt_mode = data.prompt_mode === 'full' ? 'full' : 'lite';
    this.interaction_mode = ['normal', 'auto', 'plan'].includes(data.interaction_mode) ? data.interaction_mode : 'normal';
    this.notifications = { sound: true, desktop: false, min_seconds: 8, ...(data.notifications || {}) };
    this.max_context_chars = data.max_context_chars !== undefined ? data.max_context_chars : 240000;
    this.enabled_skills = data.enabled_skills || [];
    this.integrations = data.integrations || {};
  }

  toDict() {
    return JSON.parse(JSON.stringify(this));
  }

  static fromDict(data) {
    return new CoreConfig(data || {});
  }
}

class ConfigManager {
  constructor(configPath = null) {
    this.configPath = configPath || path.join(os.homedir(), '.raven', 'config.json');
    this.config = new CoreConfig();
    this._load();
  }

  _load() {
    if (fs.existsSync(this.configPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.config = CoreConfig.fromDict(data);
      } catch (e) {
        console.warn(`Warning: Failed to load config, using defaults: ${e.message}`);
      }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(this.config.toDict(), null, 2));
  }

  get() {
    return this.config;
  }

  update(kwargs = {}) {
    for (const [key, value] of Object.entries(kwargs)) {
      if (Object.prototype.hasOwnProperty.call(this.config, key)) {
        this.config[key] = value;
      }
    }
    this.save();
  }

  setBackend(backendType, baseUrl = '', apiKey = '', model = '') {
    this.config.backend.type = backendType;
    if (baseUrl) this.config.backend.base_url = baseUrl;
    if (apiKey) this.config.backend.api_key = apiKey;
    if (model) this.config.backend.model = model;
    this.save();
  }

  addDatabase(name, url, readOnly = true) {
    this.config.databases[name] = databaseConfigDefaults(name, url, readOnly);
    this.save();
  }

  removeDatabase(name) {
    if (this.config.databases[name]) {
      delete this.config.databases[name];
      this.save();
    }
  }

  setApiKey(service, key) {
    if (Object.prototype.hasOwnProperty.call(this.config.api_keys, service)) {
      this.config.api_keys[service] = key;
      this.save();
    }
  }

  reset() {
    this.config = new CoreConfig();
    this.save();
  }
}

module.exports = { ConfigManager, CoreConfig };
