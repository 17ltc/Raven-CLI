'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { HumanConfirmation } = require('./confirmation');

function safeName(name) {
  return String(name || '').trim().replace(/[^\w.-]+/g, '-').slice(0, 48) || `server-${Date.now()}`;
}

class ServerManager {
  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = workspaceRoot;
    this.servers = new Map();
    this.confirmation = new HumanConfirmation();
  }

  async start({ name, command, cwd, env, port } = {}) {
    if (!command || !String(command).trim()) return { success: false, error: 'command is required' };
    const id = safeName(name);
    if (this.servers.has(id) && this.servers.get(id).running) return { success: false, error: `Server already running: ${id}` };
    if (!(await this.confirmation.require(`start background server '${id}': ${command}`))) return { status: 'denied' };

    const root = path.resolve(this.workspaceRoot || process.cwd());
    const resolvedCwd = cwd ? path.resolve(root, cwd) : root;
    const child = spawn(command, [], {
      cwd: resolvedCwd,
      shell: true,
      env: { ...process.env, ...(env && typeof env === 'object' ? env : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const rec = {
      id,
      command,
      cwd: resolvedCwd,
      port: port || null,
      pid: child.pid,
      started_at: new Date().toISOString(),
      running: true,
      exit_code: null,
      logs: [],
      child,
    };
    const push = (stream, chunk) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        rec.logs.push({ stream, line, at: new Date().toISOString() });
        if (rec.logs.length > 400) rec.logs.shift();
      }
    };
    child.stdout.on('data', (d) => push('stdout', d));
    child.stderr.on('data', (d) => push('stderr', d));
    child.on('exit', (code) => {
      rec.running = false;
      rec.exit_code = code;
      rec.exited_at = new Date().toISOString();
    });
    child.on('error', (e) => {
      rec.running = false;
      rec.error = e.message;
    });
    this.servers.set(id, rec);
    return { success: true, id, pid: child.pid, command, cwd: resolvedCwd, port: rec.port, message: `Started ${id} in the background` };
  }

  list() {
    return {
      servers: [...this.servers.values()].map((s) => ({
        id: s.id,
        command: s.command,
        cwd: s.cwd,
        port: s.port,
        pid: s.pid,
        running: s.running,
        exit_code: s.exit_code,
        started_at: s.started_at,
      })),
    };
  }

  logs(id, lines = 80) {
    const rec = this.servers.get(String(id || ''));
    if (!rec) return { success: false, error: `Unknown server: ${id}` };
    const n = Math.max(1, Math.min(Number(lines) || 80, 300));
    return { success: true, id: rec.id, logs: rec.logs.slice(-n) };
  }

  async stop(id) {
    const rec = this.servers.get(String(id || ''));
    if (!rec) return { success: false, error: `Unknown server: ${id}` };
    if (!rec.running) return { success: true, id: rec.id, status: 'already stopped', exit_code: rec.exit_code };
    if (!(await this.confirmation.require(`stop background server '${rec.id}'`))) return { status: 'denied' };
    try {
      rec.child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
      return { success: true, id: rec.id, status: 'stopping' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async stopAll() {
    const results = [];
    for (const rec of this.servers.values()) {
      if (rec.running) results.push(await this.stop(rec.id));
    }
    return { success: true, results };
  }
}

let singleton = null;

function getServerManager(workspaceRoot) {
  if (!singleton) singleton = new ServerManager(workspaceRoot);
  if (workspaceRoot) singleton.workspaceRoot = workspaceRoot;
  return singleton;
}

module.exports = { ServerManager, getServerManager };
