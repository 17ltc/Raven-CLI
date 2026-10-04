'use strict';
/**
 * Tracks file changes made by Raven's file tools so they can be shown as a
 * diff and reverted with /undo (and re-applied with /redo).
 *
 * Tools call `capture(path)` right BEFORE modifying a file. The UI brackets
 * every tool call with begin()/end(); end() returns the changes it caused.
 * Changes are merged per AI turn (commitTurn) so /undo reverts a whole turn.
 * Shell commands are not tracked (their side effects are unknown).
 */

const fs = require('fs');
const path = require('path');

const MAX_TRACK_BYTES = 5 * 1024 * 1024;
const MAX_STACK = 50;
const MAX_TREE_FILES = 500;

function readState(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    if (st.size > MAX_TRACK_BYTES) return { large: true, size: st.size };
    return fs.readFileSync(p);
  } catch (e) {
    return null;
  }
}

function sameState(a, b) {
  if (a === null || b === null) return a === b;
  if (a.large || b.large) return Boolean(a.large && b.large && a.size === b.size);
  return a.equals(b);
}

function restore(p, state) {
  if (state === null) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return;
  }
  if (state.large) throw new Error('file too large to restore');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, state);
}

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of entries) {
    if (out.length >= MAX_TREE_FILES) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

class FileHistory {
  constructor() {
    this.capturing = null;
    this.turn = new Map();
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Call before modifying `p`. No-op unless a batch is open. */
  capture(p) {
    if (!this.capturing || !p) return;
    const abs = path.resolve(p);
    if (!this.capturing.has(abs)) this.capturing.set(abs, readState(abs));
  }

  /** Capture every file below a directory; returns their relative paths. */
  captureTree(dir) {
    const files = walkFiles(path.resolve(dir));
    for (const f of files) this.capture(f);
    return files.map((f) => path.relative(path.resolve(dir), f));
  }

  begin() {
    this.capturing = new Map();
  }

  /** Close the batch; returns [{path, before, after}] for files that changed. */
  end() {
    const map = this.capturing;
    this.capturing = null;
    const changes = [];
    if (!map) return changes;
    for (const [p, before] of map) {
      const after = readState(p);
      if (sameState(before, after)) continue;
      changes.push({ path: p, before, after });
      const prev = this.turn.get(p);
      this.turn.set(p, { path: p, before: prev ? prev.before : before, after });
    }
    return changes;
  }

  beginTurn() {
    this.turn = new Map();
  }

  /** Push this turn's merged changes onto the undo stack. */
  commitTurn(label) {
    const changes = [...this.turn.values()].filter((c) => !sameState(c.before, c.after));
    this.turn = new Map();
    if (!changes.length) return null;
    const entry = { label: label || 'AI changes', time: Date.now(), changes };
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_STACK) this.undoStack.shift();
    this.redoStack = [];
    return entry;
  }

  _apply(stack, other, direction, force) {
    const entry = stack[stack.length - 1];
    if (!entry) return { status: 'empty' };
    const from = direction === 'undo' ? 'after' : 'before';
    const to = direction === 'undo' ? 'before' : 'after';

    if (!force) {
      const conflicts = entry.changes.filter((c) => !sameState(readState(c.path), c[from])).map((c) => c.path);
      if (conflicts.length) return { status: 'conflict', entry, conflicts };
    }
    const results = [];
    for (const c of entry.changes) {
      try {
        restore(c.path, c[to]);
        results.push({ path: c.path, before: c[from], after: c[to], status: 'ok' });
      } catch (e) {
        results.push({ path: c.path, before: c[from], after: c[to], status: 'failed', error: e.message });
      }
    }
    stack.pop();
    other.push(entry);
    return { status: 'ok', entry, results };
  }

  undo(force = false) {
    return this._apply(this.undoStack, this.redoStack, 'undo', force);
  }

  redo(force = false) {
    return this._apply(this.redoStack, this.undoStack, 'redo', force);
  }
}

const fileHistory = new FileHistory();

module.exports = {
  FileHistory,
  fileHistory,
  capture: (p) => fileHistory.capture(p),
  captureTree: (d) => fileHistory.captureTree(d),
};
