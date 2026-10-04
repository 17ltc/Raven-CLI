'use strict';
/**
 * @file mentions: list / filter project files for the "@" menu, and turn
 * "@path" tokens in a message into attached file contents.
 */

const fs = require('fs');
const path = require('path');

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.cache', '.turbo',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode', '.raven_undo', 'target', '.gradle', '.pytest_cache',
]);
const MAX_FILES = 8000;
const MAX_DEPTH = 8;
const CACHE_MS = 10000;
const MAX_FILE_BYTES = 60000;
const MAX_TOTAL_BYTES = 150000;
const MAX_DIR_ENTRIES = 60;

const cache = new Map();

function invalidate() {
  cache.clear();
}

/** Relative (posix) paths of project files below `root`. Directories end with "/". */
function listProjectFiles(root, { force = false } = {}) {
  const key = path.resolve(root);
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.files;

  const files = [];
  const walk = (dir, depth) => {
    if (files.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      if (e.name.startsWith('.') && e.name !== '.github' && !e.isFile()) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(key, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        files.push(`${rel}/`);
        walk(full, depth + 1);
      } else if (e.isFile()) files.push(rel);
    }
  };
  walk(key, 0);
  cache.set(key, { at: Date.now(), files });
  return files;
}

function subsequence(query, text) {
  let i = 0;
  for (const ch of text) if (ch === query[i]) i += 1;
  return i === query.length;
}

/** Rank paths for a query: basename prefix > basename match > path match > fuzzy. */
function filterFiles(files, query, limit = 50) {
  const q = query.toLowerCase();
  if (!q) return files.filter((f) => !f.includes('/') || f.split('/').length <= 2).slice(0, limit);
  const scored = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const base = lower.replace(/\/$/, '').split('/').pop();
    let score = 0;
    if (base === q) score = 100;
    else if (base.startsWith(q)) score = 80;
    else if (base.includes(q)) score = 60;
    else if (lower.startsWith(q)) score = 55;
    else if (lower.includes(q)) score = 40;
    else if (subsequence(q, lower)) score = 15;
    if (score) scored.push([score - lower.length / 1000, f]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map((x) => x[1]);
}

/**
 * The "@token" being typed at `cursor` (index into `chars`, an array of
 * code points). Returns {start, end, query} or null.
 */
function findMentionAt(chars, cursor) {
  let start = cursor;
  while (start > 0 && !/\s/.test(chars[start - 1])) start -= 1;
  if (chars[start] !== '@') return null;
  return { start, end: cursor, query: chars.slice(start + 1, cursor).join('') };
}

/** [start,end) ranges (code-point indices) of @mentions, for highlighting. */
function mentionRanges(chars) {
  const ranges = [];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '@' && (i === 0 || /\s/.test(chars[i - 1]))) {
      let j = i + 1;
      while (j < chars.length && !/\s/.test(chars[j])) j += 1;
      if (j > i + 1) ranges.push([i, j]);
      i = j;
    } else i += 1;
  }
  return ranges;
}

function extractMentions(text) {
  const out = [];
  const rx = /(^|\s)@([^\s@]+)/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const p = m[2].replace(/[,;:!?)\]}]+$/, '').replace(/\.$/, '');
    if (p) out.push(p);
  }
  return [...new Set(out)];
}

function insideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 4000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Read the files behind the @mentions of `text`.
 * `roots` = directories a mention may point into (workspace first, then cwd).
 * @returns {{attachments: object[], problems: string[]}}
 */
function resolveMentions(text, roots, opts = {}) {
  const maxFile = opts.maxFileBytes || MAX_FILE_BYTES;
  let budget = opts.maxTotalBytes || MAX_TOTAL_BYTES;
  const attachments = [];
  const problems = [];
  const resolvedRoots = roots.map((r) => path.resolve(r));

  for (const mention of extractMentions(text)) {
    let abs = null;
    let outside = false;
    for (const root of resolvedRoots) {
      const candidate = path.resolve(root, mention);
      if (!insideRoot(root, candidate)) {
        outside = true;
        continue;
      }
      if (fs.existsSync(candidate)) {
        abs = candidate;
        break;
      }
    }
    if (!abs) {
      problems.push(outside ? `@${mention}: outside the project, not attached` : `@${mention}: not found`);
      continue;
    }
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        const entries = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => !IGNORED_DIRS.has(e.name));
        const names = entries.slice(0, MAX_DIR_ENTRIES).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        attachments.push({ mention, kind: 'dir', abs, content: names.join('\n'), lines: names.length, truncated: entries.length > MAX_DIR_ENTRIES });
        continue;
      }
      if (budget <= 0) {
        problems.push(`@${mention}: skipped (attachment size limit reached)`);
        continue;
      }
      const buf = fs.readFileSync(abs);
      if (looksBinary(buf)) {
        problems.push(`@${mention}: binary file, not attached`);
        continue;
      }
      const cap = Math.min(maxFile, budget);
      const truncated = buf.length > cap;
      const content = buf.subarray(0, cap).toString('utf8');
      budget -= Math.min(buf.length, cap);
      attachments.push({ mention, kind: 'file', abs, content, lines: content.split('\n').length, truncated, size: buf.length });
    } catch (e) {
      problems.push(`@${mention}: ${e.message}`);
    }
  }
  return { attachments, problems };
}

function buildAttachmentBlock(attachments) {
  if (!attachments.length) return '';
  const parts = attachments.map((a) => {
    const note = a.truncated ? `\n[... truncated${a.size ? ` (${a.size} bytes total)` : ''}]` : '';
    return a.kind === 'dir'
      ? `<directory path="${a.mention}">\n${a.content}${note}\n</directory>`
      : `<file path="${a.mention}">\n${a.content}${note}\n</file>`;
  });
  return `Attached by the user with @mentions:\n\n${parts.join('\n\n')}`;
}

module.exports = {
  listProjectFiles, filterFiles, findMentionAt, mentionRanges, extractMentions, resolveMentions, buildAttachmentBlock, invalidate, IGNORED_DIRS,
};
