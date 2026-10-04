'use strict';
/**
 * Safe project and IDE helpers used by Raven. Port of Raven/ide_tools.py
 *
 * The module deliberately keeps inspection separate from mutation. Mutating
 * operations require an explicit human challenge and stay inside the workspace.
 *
 * NOTE: Python's `ast` module has no built-in JS equivalent for parsing
 * Python source, so .py symbols are extracted with regexes (def / async def /
 * class). Results match for normal top-level and nested definitions.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { capture } = require('./file_history');
const Diff = require('diff');
const { HumanConfirmation } = require('./confirmation');

const IGNORED = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.raven_undo', '.raven_sessions']);
const MAX_FILE = 2 * 1024 * 1024;

function timestamp14(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function unifiedDiff(current, updated, name) {
  return Diff.createPatch(name, current, updated, '', '').replace(/^Index:.*\n=+\n/, '');
}

class IDETools {
  constructor(root) {
    this.root = path.resolve(root);
  }

  _path(value) {
    const p = path.resolve(this.root, value);
    if (p !== this.root && !p.startsWith(this.root + path.sep)) {
      const err = new Error('Path is outside the workspace');
      err.name = 'PermissionError';
      throw err;
    }
    return p;
  }

  _allEntries() {
    const out = [];
    const stack = [this.root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.root, full);
        if (rel.split(path.sep).some((part) => IGNORED.has(part))) continue;
        out.push({ full, rel, isDir: entry.isDirectory(), isFile: entry.isFile() });
        if (entry.isDirectory()) stack.push(full);
      }
    }
    return out;
  }

  _files() {
    return this._allEntries().filter((e) => e.isFile).map((e) => e.full);
  }

  async _confirm(action) {
    return new HumanConfirmation().require(action);
  }

  projectSymbols(query = '', kind = 'all') {
    const result = [];
    const q = (query || '').toLowerCase();
    for (const file of this._files()) {
      const ext = path.extname(file);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (e) {
        continue;
      }
      const rel = path.relative(this.root, file);
      if (ext === '.py') {
        const rx = /^[ \t]*(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_]\w*)/gm;
        let m;
        while ((m = rx.exec(text)) !== null) {
          const nodeKind = m[1] === 'class' ? 'class' : 'function';
          if (kind !== 'all' && kind !== nodeKind) continue;
          if (q && !m[2].toLowerCase().includes(q)) continue;
          result.push({ name: m[2], kind: nodeKind, file: rel, line: text.slice(0, m.index).split('\n').length });
        }
      } else if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
        const rx = /(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g;
        let m;
        while ((m = rx.exec(text)) !== null) {
          if (!q || m[1].toLowerCase().includes(q)) {
            result.push({ name: m[1], kind: 'symbol', file: rel, line: text.slice(0, m.index).split('\n').length });
          }
        }
      }
    }
    return { root: this.root, symbols: result.slice(0, 500), count: result.length };
  }

  projectDependencies() {
    const files = {};
    for (const name of ['package.json', 'pyproject.toml', 'requirements.txt', 'poetry.lock', 'package-lock.json']) {
      const p = path.join(this.root, name);
      if (fs.existsSync(p)) {
        try {
          files[name] = fs.readFileSync(p, 'utf8').slice(0, MAX_FILE);
        } catch (e) {
          /* skip unreadable manifest */
        }
      }
    }
    return { files: Object.keys(files), manifests: files };
  }

  projectMap(maxDepth = 4, maxEntries = 2000) {
    const entries = [];
    const all = this._allEntries().sort((a, b) => a.rel.localeCompare(b.rel));
    for (const e of all) {
      if (entries.length >= maxEntries) break;
      if (e.rel.split(path.sep).length > maxDepth) continue;
      entries.push({ path: e.rel, directory: e.isDir });
    }
    return { root: this.root, entries, truncated: entries.length >= maxEntries };
  }

  fileHistory(filePath, limit = 20) {
    return this._git(['log', `-${Math.max(1, Math.min(limit, 100))}`, '--', filePath]);
  }

  /** Async on purpose: a sync spawn freezes the whole UI for up to 30s. */
  _git(args) {
    return new Promise((resolve) => {
      execFile('git', args, { cwd: this.root, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') {
          resolve({ success: false, error: err.code === 'ENOENT' ? 'git is not installed or not on PATH' : err.message });
          return;
        }
        resolve({
          success: !err,
          output: String(stdout || '').slice(-20000),
          error: String(stderr || '').slice(-5000),
          returncode: err ? err.code : 0,
        });
      });
    });
  }

  async safeEdit(filePath, oldContent, newContent) {
    const target = this._path(filePath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { success: false, error: 'File not found' };
    const current = fs.readFileSync(target, 'utf8');
    if (!current.includes(oldContent)) return { success: false, error: 'Old content not found' };
    const updated = current.replace(oldContent, () => newContent);
    const diff = unifiedDiff(current, updated, filePath);
    if (!(await this._confirm(`edit ${filePath}\n${diff.slice(0, 4000)}`))) {
      return { success: false, status: 'denied' };
    }
    capture(target);
    fs.writeFileSync(target, updated, 'utf8');
    return { success: true, path: filePath, diff };
  }

  async multiFileEdit(edits) {
    const preview = [];
    const prepared = [];
    for (const edit of (edits || []).slice(0, 50)) {
      const result = this.safeEditPreview(edit);
      if (result.error) return result;
      prepared.push(result);
      preview.push(result.diff.slice(0, 1500));
    }
    if (!(await this._confirm(`edit multiple files\n${preview.join('\n').slice(0, 8000)}`))) {
      return { success: false, status: 'denied' };
    }
    for (const item of prepared) {
      capture(item.path_obj);
      fs.writeFileSync(item.path_obj, item.updated, 'utf8');
    }
    return { success: true, files: prepared.map((i) => i.path) };
  }

  safeEditPreview(edit) {
    const filePath = String(edit.path || '');
    const target = this._path(filePath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { error: `File not found: ${filePath}` };
    const current = fs.readFileSync(target, 'utf8');
    const old = String(edit.old_content || '');
    if (!current.includes(old)) return { error: `Old content not found: ${filePath}` };
    const updated = current.replace(old, () => String(edit.new_content || ''));
    return { path: filePath, path_obj: target, updated, diff: unifiedDiff(current, updated, filePath) };
  }

  gitReview() {
    return this._git(['diff', '--stat']);
  }

  gitBranchSummary() {
    return this._git(['branch', '-vv']);
  }

  async gitConflictHelper() {
    const result = await this._git(['status', '--short']);
    result.conflicts = (result.output || '')
      .split('\n')
      .filter((line) => ['UU', 'AA', 'DD', 'AU', 'UA'].some((p) => line.startsWith(p)));
    return result;
  }

  secretScanner() {
    const patterns = {
      private_key: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      token: /(api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{12,}/i,
    };
    const findings = [];
    for (const file of this._files()) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8').slice(0, MAX_FILE);
      } catch (e) {
        continue;
      }
      for (const [name, rx] of Object.entries(patterns)) {
        if (rx.test(text)) findings.push({ file: path.relative(this.root, file), type: name });
      }
    }
    return { findings, count: findings.length };
  }

  dependencyVulnerabilityScan() {
    return {
      status: 'available',
      note: "Use the project's configured package manager audit command through execute_command after human confirmation.",
      manifests: this.projectDependencies().files,
    };
  }

  async workspaceSnapshot(label = 'snapshot') {
    const snapshotDir = path.join(this.root, '.raven_snapshots');
    if (!(await this._confirm(`create workspace snapshot: ${label}`))) return { success: false, status: 'denied' };
    fs.mkdirSync(snapshotDir, { recursive: true });
    const files = {};
    for (const f of this._files()) {
      files[path.relative(this.root, f)] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    }
    const data = { label, created_at: new Date().toISOString(), files };
    const target = path.join(snapshotDir, `${timestamp14()}-${label.replace(/[^A-Za-z0-9_-]/g, '-')}.json`);
    fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
    return { success: true, path: target, file_count: Object.keys(files).length };
  }

  memorySearch(query) {
    const memory = path.join(this.root, '.raven_memory.jsonl');
    if (!fs.existsSync(memory)) return { matches: [] };
    const matches = [];
    for (const line of fs.readFileSync(memory, 'utf8').split('\n')) {
      if (line && line.toLowerCase().includes(query.toLowerCase())) {
        try {
          matches.push(JSON.parse(line));
        } catch (e) {
          matches.push({ text: line });
        }
      }
    }
    return { matches: matches.slice(-100) };
  }

  async memorySave(text, category = 'note') {
    if (!(await this._confirm('save project memory'))) return { success: false, status: 'denied' };
    const target = path.join(this.root, '.raven_memory.jsonl');
    fs.appendFileSync(target, `${JSON.stringify({ created_at: new Date().toISOString(), category, text })}\n`, 'utf8');
    return { success: true, path: target };
  }

  contextBudget(text = '') {
    // A conservative multilingual/code estimate; /4 systematically
    // under-counts French text, JSON and source code.
    return { characters: text.length, estimated_tokens: Math.max(1, Math.ceil(text.length / 3.5)), recommended_limit: 12000 };
  }

  async systemStatus() {
    return { cwd: this.root, node: process.execPath, platform: process.platform, git: await this._git(['status', '--short']) };
  }
}

function registerIdeTools(registry, root) {
  const t = new IDETools(root);
  const entries = {
    project_symbols: [({ query, kind } = {}) => t.projectSymbols(query || '', kind || 'all'), 'Find classes and functions in the project.'],
    project_dependencies: [() => t.projectDependencies(), 'Inspect dependency manifests.'],
    project_map: [({ max_depth, max_entries } = {}) => t.projectMap(max_depth || 4, max_entries || 2000), 'Build a bounded project map.'],
    file_history: [({ path: p, limit } = {}) => t.fileHistory(p, limit || 20), 'Show Git history for a file.'],
    safe_edit: [({ path: p, old_content, new_content }) => t.safeEdit(p, old_content, new_content), 'Edit one file with diff preview and human confirmation.'],
    multi_file_edit: [({ edits }) => t.multiFileEdit(edits), 'Edit multiple files with one human confirmation.'],
    git_review: [() => t.gitReview(), 'Review the current Git diff summary.'],
    git_branch_summary: [() => t.gitBranchSummary(), 'List local Git branches and tracking state.'],
    git_conflict_helper: [() => t.gitConflictHelper(), 'Find unresolved Git conflicts.'],
    secret_scanner: [() => t.secretScanner(), 'Scan project text for likely secrets without revealing values.'],
    dependency_vulnerability_scan: [() => t.dependencyVulnerabilityScan(), 'Inspect manifests and explain how to run an audit.'],
    workspace_snapshot: [({ label } = {}) => t.workspaceSnapshot(label || 'snapshot'), 'Create a hash snapshot of workspace files with confirmation.'],
    memory_search: [({ query }) => t.memorySearch(query), 'Search project memory.'],
    memory_save: [({ text, category } = {}) => t.memorySave(text, category || 'note'), 'Save a project decision or note with confirmation.'],
    context_budget: [({ text } = {}) => t.contextBudget(text || ''), 'Estimate context size.'],
    system_status: [() => t.systemStatus(), 'Show Raven workspace and Git status.'],
  };
  for (const [name, [fn, description]] of Object.entries(entries)) {
    registry[name] = { fn, description };
  }
}

module.exports = { IDETools, registerIdeTools };
