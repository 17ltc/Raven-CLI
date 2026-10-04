'use strict';
/** Persistent reminders and lightweight calendar interoperability. Port of Raven/automation.py */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { HumanConfirmation } = require('./confirmation');

function parseWhen(value) {
  const now = new Date();
  const text = value.trim().toLowerCase();

  let match = /^in\s+(\d+)\s*(m|h|d)$/.exec(text);
  if (match) {
    const amount = parseInt(match[1], 10);
    const unit = match[2];
    const ms = unit === 'm' ? amount * 60000 : unit === 'h' ? amount * 3600000 : amount * 86400000;
    return new Date(now.getTime() + ms);
  }

  if (text.startsWith('tomorrow')) {
    const clock = text.replace('tomorrow', '').trim() || '09:00';
    const parts = clock.split(':', 2).map((n) => parseInt(n, 10));
    if (parts.length !== 2 || parts.some(Number.isNaN)) return null;
    const [hour, minute] = parts;
    const local = new Date();
    local.setDate(local.getDate() + 1);
    local.setHours(hour, minute, 0, 0);
    return local;
  }

  const parsed = new Date(value.replace('Z', '+00:00'));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function nextOccurrence(previous, recurrence) {
  const value = recurrence.toLowerCase().trim();
  const d = new Date(previous.getTime());
  if (value === 'hourly' || value === 'hour') return new Date(d.getTime() + 3600000);
  if (value === 'daily' || value === 'day') return new Date(d.getTime() + 86400000);
  if (value === 'weekly' || value === 'week') return new Date(d.getTime() + 7 * 86400000);
  const match = /^every\s+(\d+)\s*(m|h|d)$/.exec(value);
  if (match) {
    const amount = parseInt(match[1], 10);
    const ms = match[2] === 'm' ? amount * 60000 : match[2] === 'h' ? amount * 3600000 : amount * 86400000;
    return new Date(d.getTime() + ms);
  }
  return new Date(d.getTime() + 86400000);
}

function icsEscape(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

class AutomationStore {
  constructor(storePath = null) {
    this.path = storePath || path.join(os.homedir(), '.raven', 'automations.json');
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
  }

  _read() {
    if (!fs.existsSync(this.path)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch (e) {
      return [];
    }
  }

  _write(data) {
    const temp = `${this.path}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temp, this.path);
  }

  list(includeDone = false) {
    const data = this._read();
    return includeDone ? data : data.filter((item) => item.status === 'active');
  }

  create(title, when, prompt = '', recurrence = '') {
    const runAt = parseWhen(when);
    if (runAt === null) {
      return { success: false, error: "Invalid time. Use ISO datetime, 'in 20m', or 'tomorrow 09:00'." };
    }
    const item = {
      id: crypto.randomBytes(5).toString('hex').slice(0, 10),
      title,
      prompt: prompt || title,
      run_at: runAt.toISOString(),
      recurrence,
      status: 'active',
      created_at: new Date().toISOString(),
      last_run: null,
    };
    const data = this._read();
    data.push(item);
    this._write(data);
    return { success: true, reminder: item };
  }

  cancel(reminderId) {
    const data = this._read();
    for (const item of data) {
      if (item.id === reminderId) {
        item.status = 'cancelled';
        this._write(data);
        return { success: true, reminder: item };
      }
    }
    return { success: false, error: 'Reminder not found' };
  }

  due() {
    const now = new Date();
    const dueItems = [];
    const data = this._read();
    let changed = false;
    for (const item of data) {
      if (item.status !== 'active') continue;
      const runAt = new Date(item.run_at);
      if (Number.isNaN(runAt.getTime())) continue;
      if (runAt <= now) {
        dueItems.push({ ...item });
        item.last_run = now.toISOString();
        if (item.recurrence) {
          item.run_at = nextOccurrence(runAt, item.recurrence).toISOString();
        } else {
          item.status = 'done';
        }
        changed = true;
      }
    }
    if (changed) this._write(data);
    return dueItems;
  }

  async exportIcs(output) {
    const target = path.resolve(output.replace(/^~/, os.homedir()));
    if (!(await new HumanConfirmation().require(`export reminders to ${target}`))) {
      return { success: false, status: 'denied' };
    }
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Raven CLI//EN'];
    for (const item of this.list()) {
      const dt = new Date(item.run_at)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z');
      lines.push(
        'BEGIN:VEVENT',
        `UID:${item.id}@raven`,
        `DTSTART:${dt}`,
        `SUMMARY:${icsEscape(item.title)}`,
        `DESCRIPTION:${icsEscape(item.prompt || '')}`,
        'END:VEVENT'
      );
    }
    lines.push('END:VCALENDAR');
    fs.writeFileSync(target, `${lines.join('\r\n')}\r\n`, 'utf8');
    return { success: true, path: target, count: this.list().length };
  }
}

function registerAutomationTools(registry) {
  const store = new AutomationStore();
  registry.reminder_create = {
    fn: ({ title, when, prompt, recurrence }) => store.create(title, when, prompt, recurrence),
    description: 'Create a persistent reminder. Args: {title, when, prompt?, recurrence?}',
  };
  registry.reminder_list = {
    fn: ({ include_done } = {}) => store.list(Boolean(include_done)),
    description: 'List active reminders. Args: {include_done?: bool}',
  };
  registry.reminder_cancel = {
    fn: ({ reminder_id }) => store.cancel(reminder_id),
    description: 'Cancel a reminder. Args: {reminder_id}',
  };
  registry.reminder_due = {
    fn: () => ({ due: store.due() }),
    description: 'Collect reminders due now and advance recurring reminders. Args: {}',
  };
  registry.calendar_export_ics = {
    fn: ({ output }) => store.exportIcs(output),
    description: 'Export Raven reminders to an ICS calendar file. Args: {output}',
  };
}

module.exports = { AutomationStore, parseWhen, nextOccurrence, icsEscape, registerAutomationTools };
