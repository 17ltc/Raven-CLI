'use strict';
/**
 * Provider and protocol compatibility layer for Raven.
 * Port of Raven/integrations.py
 *
 * Integrations are opt-in. Credentials are referenced by environment variable
 * names; this module never writes secret values to Raven configuration.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  subscribe(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(callback);
  }

  publish(event, payload = {}) {
    const listeners = [...(this._listeners.get(event) || []), ...(this._listeners.get('*') || [])];
    for (const callback of listeners) {
      try {
        callback(payload || {});
      } catch (e) {
        /* listeners must not break publish */
      }
    }
    return listeners.length;
  }
}

class Integration {
  constructor({ name, enabled = false, token_env = '', capabilities_list = [] }) {
    this.name = name;
    this.enabled = enabled;
    this.token_env = token_env;
    this.capabilities_list = capabilities_list;
  }

  healthCheck() {
    const token = this.token_env ? Boolean(process.env[this.token_env]) : true;
    return { name: this.name, enabled: this.enabled, credentials_present: token, capabilities: this.capabilities_list };
  }
}

const KNOWN_INTEGRATIONS = {
  github: ['issues', 'pull_requests', 'reviews'],
  gitlab: ['issues', 'merge_requests', 'pipelines'],
  bitbucket: ['repositories', 'pull_requests'],
  google_calendar: ['events', 'reminders'],
  outlook_calendar: ['events', 'reminders'],
  slack: ['search', 'messages', 'notifications'],
  telegram: ['messages', 'notifications'],
  twilio: ['sms'],
  sentry: ['issues', 'events', 'releases'],
  linear: ['issues', 'projects', 'comments'],
  notion: ['pages', 'databases', 'search'],
  docker: ['containers', 'images', 'logs'],
  kubernetes: ['pods', 'services', 'deployments'],
  jenkins: ['jobs', 'builds'],
};

class IntegrationManager {
  constructor(config = {}) {
    this.config = config || {};
    this.bus = new EventBus();
  }

  list() {
    const configured = this.config.integrations || {};
    const result = [];
    for (const [name, capabilities] of Object.entries(KNOWN_INTEGRATIONS)) {
      const item = (typeof configured === 'object' && configured[name]) || {};
      result.push({
        name,
        enabled: Boolean(item.enabled),
        capabilities,
        token_env: item.token_env || '',
      });
    }
    return result;
  }

  health(name = '') {
    let items = this.list();
    if (name) items = items.filter((item) => item.name === name);
    for (const item of items) {
      const tokenEnv = item.token_env;
      item.credentials_present = tokenEnv ? Boolean(process.env[tokenEnv]) : !item.enabled;
    }
    return { integrations: items };
  }
}

/** Minimal MCP JSON-RPC client descriptor for a configured stdio server. */
class MCPClient {
  constructor(command, env = {}) {
    this.command = command;
    this.env = { ...process.env, ...env };
  }

  describe() {
    return { transport: 'stdio', command: this.command, status: 'configured' };
  }
}

class WebhookInbox {
  constructor(secret = '') {
    this.secret = secret;
    this.events = [];
    this.maxSize = 1000;
  }

  receive(payload, providedSecret = '') {
    if (this.secret) {
      const a = Buffer.from(this.secret);
      const b = Buffer.from(providedSecret || '');
      const equal = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!equal) return { accepted: false, error: 'invalid webhook secret' };
    }
    if (this.events.length >= this.maxSize) return { accepted: false, error: 'webhook queue is full' };
    this.events.push({ payload });
    return { accepted: true };
  }

  next() {
    return this.events.length ? this.events.shift() : null;
  }
}

function exportConversation(messages, output, fmt = 'json') {
  const target = path.resolve(output.replace(/^~/, os.homedir()));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let content;
  if (fmt === 'jsonl') {
    content = messages.map((item) => JSON.stringify(item)).join('\n') + (messages.length ? '\n' : '');
  } else if (fmt === 'md') {
    content = messages
      .map((item) => {
        const role = (item.role || 'message');
        const title = role.charAt(0).toUpperCase() + role.slice(1);
        return `## ${title}\n\n${item.content || ''}`;
      })
      .join('\n\n');
  } else {
    content = JSON.stringify(messages, null, 2);
  }
  fs.writeFileSync(target, content, 'utf8');
  return { success: true, path: target, format: fmt, messages: messages.length };
}

function registerIntegrationTools(registry, config) {
  const manager = new IntegrationManager(config);
  const inbox = new WebhookInbox();
  registry.integration_list = { fn: () => manager.list(), description: 'List supported Raven integrations and capabilities.' };
  registry.integration_health = {
    fn: ({ name } = {}) => manager.health(name || ''),
    description: 'Check configured integration health. Args: {name?: str}',
  };
  registry.event_publish = {
    fn: ({ event, payload }) => manager.bus.publish(event, payload),
    description: 'Publish an internal Raven event. Args: {event: str, payload?: dict}',
  };
  registry.webhook_next = { fn: () => inbox.next() || { status: 'empty' }, description: 'Read the next local webhook event.' };
  registry.conversation_export = {
    fn: ({ messages, output, fmt }) => exportConversation(messages, output, fmt || 'json'),
    description: 'Export messages as JSON, JSONL or Markdown. Args: {messages, output, fmt?: str}',
  };
}

module.exports = {
  EventBus,
  Integration,
  IntegrationManager,
  MCPClient,
  WebhookInbox,
  exportConversation,
  registerIntegrationTools,
  KNOWN_INTEGRATIONS,
};
