'use strict';
/**
 * Pure text-editing state for the input box: multi-line buffer, cursor,
 * history, kill-ring and soft-wrap layout. No terminal I/O in here.
 */

const { charWidth } = require('./ansi');

const isWordChar = (ch) => /[\p{L}\p{N}_]/u.test(ch || '');

class LineEditor {
  constructor() {
    this.chars = [];
    this.cursor = 0;
    this.history = [];
    this.histIndex = -1;
    this.draft = '';
    this.killBuffer = '';
    this.preferredCol = null;
    this.undoStack = [];
    this.redoStack = [];
    this._undoBatch = 0;
    this._batchSnapshot = null;
  }

  get text() {
    return this.chars.join('');
  }

  _state() {
    return { chars: this.chars.slice(), cursor: this.cursor };
  }

  _restore(state) {
    this.chars = state.chars.slice();
    this.cursor = Math.max(0, Math.min(state.cursor, this.chars.length));
    this.preferredCol = null;
    this.histIndex = -1;
  }

  _record() {
    const snapshot = this._state();
    if (this._undoBatch > 0) {
      if (!this._batchSnapshot) this._batchSnapshot = snapshot;
      return;
    }
    this.undoStack.push(snapshot);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  beginUndoBatch() {
    if (this._undoBatch === 0) this._batchSnapshot = this._state();
    this._undoBatch += 1;
  }

  endUndoBatch() {
    if (this._undoBatch === 0) return;
    this._undoBatch -= 1;
    if (this._undoBatch > 0) return;
    const before = this._batchSnapshot;
    this._batchSnapshot = null;
    if (!before || before.chars.join('') === this.text && before.cursor === this.cursor) return;
    this.undoStack.push(before);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this._state());
    this._restore(this.undoStack.pop());
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this._state());
    this._restore(this.redoStack.pop());
    return true;
  }

  set(text, opts = {}) {
    if (opts.record !== false) this._record();
    this.chars = Array.from(text || '');
    this.cursor = this.chars.length;
    this.preferredCol = null;
  }

  clear(opts = {}) {
    this.set('', opts);
    this.histIndex = -1;
  }

  insert(str) {
    const arr = Array.from(String(str).replace(/\r\n?/g, '\n'));
    if (!arr.length) return;
    this._record();
    this.chars = this.chars.slice(0, this.cursor).concat(arr, this.chars.slice(this.cursor));
    this.cursor += arr.length;
    this.preferredCol = null;
    this.histIndex = -1;
  }

  /** Replace chars[start, end) with `str` and put the cursor after it. */
  replaceRange(start, end, str) {
    const arr = Array.from(String(str));
    this._record();
    this.chars = this.chars.slice(0, start).concat(arr, this.chars.slice(end));
    this.cursor = start + arr.length;
    this.preferredCol = null;
  }

  backspace() {
    if (this.cursor === 0) return;
    this._record();
    this.chars.splice(this.cursor - 1, 1);
    this.cursor -= 1;
    this.preferredCol = null;
  }

  del() {
    if (this.cursor >= this.chars.length) return;
    this._record();
    this.chars.splice(this.cursor, 1);
    this.preferredCol = null;
  }

  left() {
    if (this.cursor > 0) this.cursor -= 1;
    this.preferredCol = null;
  }

  right() {
    if (this.cursor < this.chars.length) this.cursor += 1;
    this.preferredCol = null;
  }

  lineStart(idx = this.cursor) {
    let i = idx;
    while (i > 0 && this.chars[i - 1] !== '\n') i -= 1;
    return i;
  }

  lineEnd(idx = this.cursor) {
    let i = idx;
    while (i < this.chars.length && this.chars[i] !== '\n') i += 1;
    return i;
  }

  home() {
    this.cursor = this.lineStart();
    this.preferredCol = null;
  }

  end() {
    this.cursor = this.lineEnd();
    this.preferredCol = null;
  }

  wordLeft() {
    let i = this.cursor;
    while (i > 0 && !isWordChar(this.chars[i - 1])) i -= 1;
    while (i > 0 && isWordChar(this.chars[i - 1])) i -= 1;
    this.cursor = i;
    this.preferredCol = null;
  }

  wordRight() {
    let i = this.cursor;
    while (i < this.chars.length && !isWordChar(this.chars[i])) i += 1;
    while (i < this.chars.length && isWordChar(this.chars[i])) i += 1;
    this.cursor = i;
    this.preferredCol = null;
  }

  deleteWordBack() {
    const end = this.cursor;
    const before = this._state();
    this.wordLeft();
    if (this.cursor === end) return;
    if (this._undoBatch > 0) {
      if (!this._batchSnapshot) this._batchSnapshot = before;
    } else {
      this.undoStack.push(before);
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    this.killBuffer = this.chars.splice(this.cursor, end - this.cursor).join('');
  }

  killToEnd() {
    let end = this.lineEnd();
    if (end === this.cursor && end < this.chars.length) end += 1; // join lines
    if (end === this.cursor) return;
    this._record();
    this.killBuffer = this.chars.splice(this.cursor, end - this.cursor).join('');
    this.preferredCol = null;
  }

  killToStart() {
    const start = this.lineStart();
    if (start === this.cursor) return;
    this._record();
    this.killBuffer = this.chars.splice(start, this.cursor - start).join('');
    this.cursor = start;
    this.preferredCol = null;
  }

  yank() {
    if (this.killBuffer) this.insert(this.killBuffer);
  }

  transpose() {
    if (this.cursor === 0 || this.chars.length < 2) return;
    this._record();
    if (this.cursor === this.chars.length) this.cursor -= 1;
    const a = this.cursor - 1;
    [this.chars[a], this.chars[a + 1]] = [this.chars[a + 1], this.chars[a]];
    this.cursor += 1;
  }

  // -- history ---------------------------------------------------------

  pushHistory(text) {
    const t = text.trim();
    if (!t) return;
    if (this.history[this.history.length - 1] !== t) this.history.push(t);
    if (this.history.length > 500) this.history.shift();
    this.histIndex = -1;
  }

  historyPrev() {
    if (!this.history.length) return false;
    if (this.histIndex === -1) {
      this.draft = this.text;
      this.histIndex = this.history.length - 1;
    } else if (this.histIndex > 0) {
      this.histIndex -= 1;
    } else {
      return false;
    }
    const idx = this.histIndex;
    this.set(this.history[idx]);
    this.histIndex = idx;
    return true;
  }

  historyNext() {
    if (this.histIndex === -1) return false;
    if (this.histIndex < this.history.length - 1) {
      const idx = this.histIndex + 1;
      this.set(this.history[idx]);
      this.histIndex = idx;
    } else {
      this.set(this.draft);
      this.histIndex = -1;
    }
    return true;
  }

  // -- layout ------------------------------------------------------------

  /** Soft-wrap into visual rows: [{start, end, hard}] (indices into chars). */
  layout(width) {
    const rows = [];
    let start = 0;
    let w = 0;
    for (let i = 0; i < this.chars.length; i++) {
      const ch = this.chars[i];
      if (ch === '\n') {
        rows.push({ start, end: i, hard: true });
        start = i + 1;
        w = 0;
        continue;
      }
      const cw = charWidth(ch.codePointAt(0));
      if (w + cw > width && i > start) {
        rows.push({ start, end: i, hard: false });
        start = i;
        w = 0;
      }
      w += cw;
    }
    rows.push({ start, end: this.chars.length, hard: false, last: true });
    return rows;
  }

  rowWidth(row, upto = row.end) {
    let w = 0;
    for (let i = row.start; i < upto; i++) w += charWidth(this.chars[i].codePointAt(0));
    return w;
  }

  cursorPosition(width, rows = this.layout(width)) {
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const within = this.cursor >= row.start && (this.cursor < row.end || (this.cursor === row.end && (row.hard || row.last)));
      if (within) return { row: r, col: this.rowWidth(row, this.cursor) };
    }
    const last = rows[rows.length - 1];
    return { row: rows.length - 1, col: this.rowWidth(last) };
  }

  /** Move the cursor one visual row up/down. Returns false at the edges. */
  moveVertical(dir, width) {
    const rows = this.layout(width);
    const pos = this.cursorPosition(width, rows);
    const target = pos.row + dir;
    if (target < 0 || target >= rows.length) return false;
    if (this.preferredCol === null) this.preferredCol = pos.col;
    const row = rows[target];
    let w = 0;
    let i = row.start;
    while (i < row.end) {
      const cw = charWidth(this.chars[i].codePointAt(0));
      if (w + cw > this.preferredCol) break;
      w += cw;
      i += 1;
    }
    this.cursor = i;
    return true;
  }
}

module.exports = { LineEditor };
