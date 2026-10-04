'use strict';
/**
 * Project inspection tools.
 * Port of Raven/project_tools.py
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const IGNORED_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.raven_sessions', '.raven_undo']);

/** Very small glob-to-regex helper supporting `*` and `?` (enough for "*.py" style patterns). */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function walk(root, dir = root, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push({ full, isDir: true });
      walk(root, full, out);
    } else if (entry.isFile()) {
      out.push({ full, isDir: false });
    }
  }
  return out;
}

class ProjectTools {
  constructor(root) {
    this.root = path.resolve(root);
  }

  files(pattern = '*') {
    const rx = globToRegExp(pattern);
    return walk(this.root)
      .filter((e) => !e.isDir && rx.test(path.basename(e.full)))
      .map((e) => path.relative(this.root, e.full))
      .sort();
  }

  tree(maxDepth = 3) {
    const result = [];
    const entries = walk(this.root).sort((a, b) => a.full.localeCompare(b.full));
    for (const entry of entries) {
      const relative = path.relative(this.root, entry.full);
      const parts = relative.split(path.sep);
      if (parts.some((p) => IGNORED_DIRS.has(p))) continue;
      if (parts.length <= maxDepth) {
        result.push(relative + (entry.isDir ? '/' : ''));
      }
    }
    return result;
  }

  read(relPath, startLine = 1, maxLines = 240) {
    startLine = Math.max(1, Math.floor(Number(startLine) || 1));
    maxLines = Math.max(1, Math.min(10000, Math.floor(Number(maxLines) || 240)));
    const target = path.resolve(this.root, relPath);
    if (!target.startsWith(this.root + path.sep) && target !== this.root) {
      return { error: 'File is outside the project' };
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return { error: `File not found: ${relPath}` };
    }
    try {
      const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
      const start = Math.max(startLine - 1, 0);
      const selected = lines.slice(start, start + maxLines);
      return { path: path.relative(this.root, target), start_line: start + 1, lines: selected };
    } catch (e) {
      return { error: `Not a UTF-8 text file: ${relPath}` };
    }
  }

  inspect() {
    const files = this.files();
    const extensions = {};
    for (const name of files) {
      const suffix = path.extname(name).toLowerCase() || '[none]';
      extensions[suffix] = (extensions[suffix] || 0) + 1;
    }
    return { root: this.root, file_count: files.length, extensions, tree: this.tree(2) };
  }

  search(query) {
    const results = [];
    const needle = query.toLowerCase();
    for (const relative of this.files()) {
      const full = path.join(this.root, relative);
      let content;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch (e) {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          results.push({ file: relative, line: i + 1, text: lines[i].trim() });
          if (results.length >= 200) return results;
        }
      }
    }
    return results.slice(0, 200);
  }

  async git(...args) {
    const allowed = new Set(['status', 'diff', 'log', 'show', 'branch', 'ls-files', 'blame']);
    if (!Array.isArray(args) || !args.length || !allowed.has(String(args[0]))) {
      return { success: false, error: 'Only read-only git commands are allowed', returncode: 1 };
    }
    if (args.some((arg) => /^-(c|C|\-exec-path|\-output)(=|$)/.test(String(arg)))) {
      return { success: false, error: 'Git option is not allowed', returncode: 1 };
    }
    try {
      const { stdout, stderr } = await execFileAsync('git', args, { cwd: this.root, timeout: 30000 });
      return { success: true, output: stdout.trim(), error: stderr.trim(), returncode: 0 };
    } catch (e) {
      return {
        success: false,
        output: (e.stdout || '').trim(),
        error: (e.stderr || e.message || '').trim(),
        returncode: typeof e.code === 'number' ? e.code : 1,
      };
    }
  }

  async diffFile(relPath) {
    const target = path.resolve(this.root, relPath);
    if (!target.startsWith(this.root + path.sep) && target !== this.root) {
      return { success: false, error: 'File is outside the project' };
    }
    try {
      const { stdout, stderr } = await execFileAsync(
        'git',
        ['diff', '--', path.relative(this.root, target)],
        { cwd: this.root, timeout: 30000 }
      );
      return { success: true, output: stdout, error: stderr };
    } catch (e) {
      return { success: false, output: e.stdout || '', error: e.stderr || e.message };
    }
  }

  summary() {
    const files = this.files();
    const importantNames = new Set(['readme.md', 'pyproject.toml', 'package.json', 'dockerfile']);
    const important = files.filter((f) => importantNames.has(path.basename(f).toLowerCase()));
    return `root=${this.root}; files=${files.length}; entrypoints=${important.slice(0, 8).join(', ') || 'none'}`;
  }

  contextForQuery(query, limit = 6000) {
    const terms = new Set(
      query
        .replace(/\//g, ' ')
        .split(/\s+/)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length > 2)
    );
    const candidates = [];
    for (const relative of this.files()) {
      let score = 0;
      const lower = relative.toLowerCase();
      for (const term of terms) if (lower.includes(term)) score += 1;
      if (score) candidates.push([score, relative]);
    }
    candidates.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));

    const chunks = [];
    let used = 0;
    for (const [, relative] of candidates.slice(0, 8)) {
      let content;
      try {
        content = fs.readFileSync(path.join(this.root, relative), 'utf8').slice(0, 1800);
      } catch (e) {
        continue;
      }
      const chunk = `\n--- ${relative} ---\n${content}`;
      if (used + chunk.length > limit) break;
      chunks.push(chunk);
      used += chunk.length;
    }
    return this.summary() + (chunks.length ? '\nRelevant files:' + chunks.join('') : '');
  }
}

module.exports = { ProjectTools, IGNORED_DIRS };
