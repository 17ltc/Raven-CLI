'use strict';
/**
 * Core Sessions Module
 * Port of Raven/core/sessions.py
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function timestampId(d = new Date()) {
  const p = (n, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Session ids become file names: refuse anything that could escape the folder. */
function safeId(id) {
  const s = String(id || '').trim();
  return /^[\w.-]+$/.test(s) && !s.includes('..') ? s : null;
}

class SessionManager {
  constructor(basePath = null) {
    this.basePath = basePath || path.join(os.homedir(), '.raven', 'sessions');
    fs.mkdirSync(this.basePath, { recursive: true });
    this._currentSession = null;
  }

  create(name) {
    // Two sessions created within the same second used to overwrite each other.
    const base = timestampId();
    let id = base;
    for (let n = 2; fs.existsSync(path.join(this.basePath, `${id}.json`)); n++) id = `${base}-${n}`;
    const session = {
      id,
      name,
      created_at: new Date().toISOString(),
      entries: [],
      metadata: {},
    };
    this._saveSession(session);
    this._currentSession = session;
    return session;
  }

  load(sessionId) {
    const id = safeId(sessionId);
    if (!id) return null;
    const file = path.join(this.basePath, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return null; // corrupted file
    }
    const session = {
      id: data.id,
      name: data.name,
      created_at: data.created_at,
      updated_at: data.updated_at || data.created_at,
      entries: data.entries || [],
      metadata: data.metadata || {},
    };
    this._currentSession = session;
    return session;
  }

  save() {
    if (this._currentSession) this._saveSession(this._currentSession);
  }

  _saveSession(session) {
    const file = path.join(this.basePath, `${session.id}.json`);
    fs.writeFileSync(file, JSON.stringify(session, null, 2));
  }

  addEntry(role, content, toolCalls = null) {
    if (!this._currentSession) this.create('default');
    const now = new Date().toISOString();
    this._currentSession.entries.push({ role, content, timestamp: now, tool_calls: toolCalls });
    this._currentSession.updated_at = now;
    this.save();
  }

  /**
   * Summaries (newest activity first). `count` = user/assistant messages,
   * `title` = first user message. Empty sessions are hidden unless asked for.
   */
  list({ includeEmpty = true } = {}) {
    const sessions = [];
    for (const file of fs.readdirSync(this.basePath)) {
      if (!file.endsWith('.json')) continue;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(this.basePath, file), 'utf8'));
      } catch (e) {
        continue; // skip corrupted files instead of breaking the whole list
      }
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const chat = entries.filter((e) => e && ['user', 'assistant'].includes(e.role));
      if (!includeEmpty && !chat.length) continue;
      const firstUser = chat.find((e) => e.role === 'user');
      sessions.push({
        id: data.id,
        name: data.name,
        created_at: data.created_at,
        updated_at: data.updated_at || (entries.length ? entries[entries.length - 1].timestamp : data.created_at),
        count: chat.length,
        title: firstUser ? String(firstUser.content).replace(/\s+/g, ' ').trim().slice(0, 80) : '',
        entries: [],
        metadata: data.metadata || {},
      });
    }
    sessions.sort((a, b) => (String(a.updated_at) < String(b.updated_at) ? 1 : -1));
    return sessions;
  }

  delete(sessionId) {
    const id = safeId(sessionId);
    if (!id) return false;
    const file = path.join(this.basePath, `${id}.json`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      if (this._currentSession && this._currentSession.id === sessionId) {
        this._currentSession = null;
      }
      return true;
    }
    return false;
  }

  getCurrent() {
    return this._currentSession;
  }

  export(sessionId, format = 'json') {
    const session = this.load(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (format === 'json') return JSON.stringify(session, null, 2);
    if (format === 'md') return this._toMarkdown(session);
    throw new Error(`Unsupported format: ${format}`);
  }

  _toMarkdown(session) {
    let md = `# Session: ${session.name}\n\n`;
    md += `Created: ${session.created_at}\n\n`;
    for (const entry of session.entries) {
      md += `## ${entry.role.toUpperCase()} - ${entry.timestamp}\n\n`;
      md += `${entry.content}\n\n`;
    }
    return md;
  }
}

module.exports = { SessionManager };
