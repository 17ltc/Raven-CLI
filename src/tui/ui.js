'use strict';
/**
 * Raven terminal UI.
 *
 * Scrollback (messages, tool calls, answers) is printed normally. A small
 * "live region" is redrawn at the bottom of the screen:
 *
 *     ──────────────────────────────────────────
 *       ✻ Reasoning… (12s · ↓ 1.2k tokens · esc to interrupt)
 *         ⎿ …live preview of the model's reasoning…
 *       ⧗ queued  my next message
 *     ──────────────────────────────────────────
 *     ╭────────────────────────────────────────╮
 *     │ › you can keep typing while Raven works │
 *     ╰────────────────────────────────────────╯
 *       /help  Show help for commands           <- slash menu / footer
 *
 * The input box stays active at all times; messages typed while Raven is
 * busy are queued and run in order.
 */

const readline = require('readline');
const util = require('util');
const chalk = require('chalk');
const { LineEditor } = require('./editor');
const { strWidth, truncate, padEnd, sliceChars, stripAnsi, visibleLength, RESET } = require('./ansi');
const style = require('../style');
const { mentionRanges } = require('../mentions');

const SPINNER = ['\u00b7', '\u2722', '\u2733', '\u2736', '\u273b', '\u273d', '\u273b', '\u2736', '\u2733', '\u2722'];
const MAX_INPUT_ROWS = 8;
const MAX_MENU_ROWS = 7;
const PLACEHOLDER = 'Ask Raven anything\u2026  or type / for commands';

function fmtElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

class TerminalUI {
  constructor(opts = {}) {
    this.out = opts.stdout || process.stdout;
    this.inp = opts.stdin || process.stdin;
    this.editor = new LineEditor();
    this.handlers = {};
    this.footerRight = '';
    this.headerLines = Array.isArray(opts.headerLines) ? opts.headerLines.slice() : [];
    this._headerNeedsDraw = this.headerLines.length > 0;
    // Keep printed output so a terminal resize can rebuild the viewport.
    this.transcript = [];

    this.busy = false;
    this.activity = null;
    this.queue = [];
    this.askState = null;
    this.pickState = null;
    this.typing = null;
    this.typingSkip = false;
    this.menu = null;
    this.pendingPastes = [];
    this._lastCapturedPaste = 0;
    this.menuDismissedFor = null;
    this.inputScroll = 0;
    this.hint = '';
    this._hintTimer = null;

    this.started = false;
    this.cursorRow = 0;
    this._lastCols = null;
    this.frame = 0;
    this.t0 = Date.now();
    this._timer = null;
    this._drawScheduled = false;
    this.pasting = false;
    this._lastEsc = 0;
    this._lastCtrlC = 0;
    this._origConsole = null;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  start(handlers) {
    this.handlers = handlers || {};
    this.editor.history = (this.handlers.history || []).slice();

    readline.emitKeypressEvents(this.inp, { escapeCodeTimeout: 30 });
    if (this.inp.setRawMode) this.inp.setRawMode(true);
    this.inp.resume();

    this._onKey = (s, k) => {
      try {
        this._handleKey(s, k);
      } catch (e) {
        this.print(chalk.hex(style.getTheme().err)(`UI error: ${e.message}`));
      }
    };
    this.inp.on('keypress', this._onKey);
    this._onResize = () => {
      // Defer clearing until _draw() can replay the transcript and live state.
      this._lastCols = null;
      this._headerNeedsDraw = true;
      this._scheduleDraw();
    };
    this.out.on('resize', this._onResize);
    this._onExit = () => this._restoreTerminal();
    process.on('exit', this._onExit);

    this.out.write('\x1b[?2004h'); // bracketed paste
    this._patchConsole();
    this.started = true;
    this._draw();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    clearInterval(this._timer);
    this._timer = null;
    this.out.write(`\x1b[?25l${this._eraseSeq()}`);
    this.cursorRow = 0;
    this._restoreConsole();
    this.inp.removeListener('keypress', this._onKey);
    this.out.removeListener('resize', this._onResize);
    process.removeListener('exit', this._onExit);
    this._restoreTerminal();
    try {
      this.inp.pause();
    } catch (e) {
      /* ignore */
    }
  }

  _restoreTerminal() {
    try {
      this.out.write('\x1b[?2004l\x1b[?25h');
      if (this.inp.setRawMode) this.inp.setRawMode(false);
    } catch (e) {
      /* ignore */
    }
  }

  _patchConsole() {
    this._origConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    const fn = (...args) => this.print(util.format(...args));
    console.log = console.info = console.warn = console.error = console.debug = fn;
  }

  _restoreConsole() {
    if (!this._origConsole) return;
    Object.assign(console, this._origConsole);
    this._origConsole = null;
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  print(text = '') {
    const body = String(text).replace(/\r?\n/g, '\r\n');
    if (!this.started) {
      this.out.write(`${body}\n`);
      return;
    }
    this._draw(`${body}\r\n`);
  }

  clearScreen() {
    this.transcript = [];
    this.cursorRow = 0;
    this._headerNeedsDraw = true;
    this._draw();
  }

  setFooterRight(text) {
    this.footerRight = text || '';
    this._scheduleDraw();
  }

  setQueue(list) {
    this.queue = list.slice();
    this._scheduleDraw();
  }

  setBusy(flag, patch = {}) {
    this.busy = Boolean(flag);
    this.activity = flag ? { startedAt: Date.now(), verb: 'Thinking', tokens: 0, preview: [], ...patch } : null;
    this._syncTimer();
    this._draw();
  }

  setActivity(patch) {
    if (this.activity) Object.assign(this.activity, patch);
  }

  setHint(text, ms = 2200) {
    this.hint = text;
    clearTimeout(this._hintTimer);
    if (text) {
      this._hintTimer = setTimeout(() => {
        this.hint = '';
        this._scheduleDraw();
      }, ms);
    }
    this._scheduleDraw();
  }

  /** Ask a question through the input box (used for confirmations). */
  ask(question, opts = {}) {
    return new Promise((resolve) => {
      const saved = { text: this.editor.text, cursor: this.editor.cursor };
      this.editor.set('');
      this.menu = null;
      this.askState = {
        question: String(question),
        secret: Boolean(opts.secret),
        resolve: (value) => {
          this.askState = null;
          this.editor.set(saved.text);
          this.editor.cursor = Math.min(saved.cursor, this.editor.chars.length);
          this._syncTimer();
          this._draw();
          resolve(value);
        },
      };
      this._syncTimer();
      this._draw();
    });
  }

  /**
   * List picker (type to filter, arrows, Enter, Esc).
   * items: [{label, desc?, value}] -> resolves the chosen value, or null.
   */
  select(title, items, opts = {}) {
    return new Promise((resolve) => {
      if (!items.length) return resolve(null);
      const saved = { text: this.editor.text, cursor: this.editor.cursor };
      this.editor.set('');
      this.menu = null;
      this.pickState = {
        title,
        items,
        filtered: items,
        index: Math.min(opts.initial || 0, items.length - 1),
        done: (value) => {
          this.pickState = null;
          this.editor.set(saved.text);
          this.editor.cursor = Math.min(saved.cursor, this.editor.chars.length);
          this._syncTimer();
          this._draw();
          resolve(value);
        },
      };
      this._syncTimer();
      this._draw();
    });
  }

  _filterPick() {
    const p = this.pickState;
    const q = this.editor.text.trim().toLowerCase();
    p.filtered = q ? p.items.filter((i) => `${i.label} ${i.desc || ''}`.toLowerCase().includes(q)) : p.items;
    p.index = Math.max(0, Math.min(p.index, p.filtered.length - 1));
  }

  /** Navigation keys while a picker is open. Returns true when consumed. */
  _handlePickKey(key) {
    const p = this.pickState;
    const n = p.filtered.length;
    if (key.name === 'up') p.index = n ? (p.index - 1 + n) % n : 0;
    else if (key.name === 'down') p.index = n ? (p.index + 1) % n : 0;
    else if (key.name === 'pageup') p.index = Math.max(0, p.index - 5);
    else if (key.name === 'pagedown') p.index = Math.min(Math.max(n - 1, 0), p.index + 5);
    else if (key.name === 'return' || key.name === 'enter') p.done(n ? p.filtered[p.index].value : null);
    else if (key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) p.done(null);
    else return false;
    return true;
  }

  /** Print already-rendered lines with a fast "typing" reveal animation. */
  typeOut(lines) {
    return new Promise((resolve) => {
      if (!lines.length) return resolve();
      const total = lines.reduce((a, l) => a + Math.max(visibleLength(l), 1), 0);
      if (!this.started || total > 4500) {
        this.print(lines.join('\n'));
        return resolve();
      }
      const tickMs = 16;
      const duration = Math.min(1.5, Math.max(0.3, total / 1600));
      const perTick = Math.max(2, Math.ceil(total / ((duration * 1000) / tickMs)));
      let idx = 0;
      let pos = 0;
      this.typingSkip = false;

      const step = () => {
        const commit = [];
        if (this.typingSkip) {
          commit.push(...lines.slice(idx));
          idx = lines.length;
        }
        let budget = perTick;
        while (budget > 0 && idx < lines.length) {
          const line = lines[idx];
          const len = visibleLength(line);
          if (len === 0) {
            commit.push('');
            idx += 1;
            pos = 0;
            budget -= 1;
          } else if (len - pos <= budget) {
            commit.push(line);
            budget -= len - pos;
            idx += 1;
            pos = 0;
          } else {
            pos += budget;
            budget = 0;
          }
        }
        const prefix = commit.length ? `${commit.join('\r\n')}\r\n` : '';
        if (idx >= lines.length) {
          this.typing = null;
          clearInterval(iv);
          this._draw(prefix);
          return resolve();
        }
        this.typing = { partial: this._partialLine(lines[idx], pos) };
        this._draw(prefix);
      };
      const iv = setInterval(step, tickMs);
      step();
    });
  }

  _partialLine(line, pos) {
    const t = style.getTheme();
    const lead = Math.min(6, pos);
    const body = sliceChars(line, pos - lead);
    const edge = Array.from(stripAnsi(line))
      .slice(pos - lead, pos)
      .map((ch, i) => chalk.hex(style.lerpColor(t.text, t.primary, (i + 1) / Math.max(lead, 1)))(ch))
      .join('');
    return `${body}${RESET}${edge}${chalk.hex(t.primary)('\u258c')}`;
  }

  // -------------------------------------------------------------------
  // Timer (only runs while something is animating)
  // -------------------------------------------------------------------

  _syncTimer() {
    const need = this.busy || this.askState || this.pickState;
    if (need && !this._timer) {
      this._timer = setInterval(() => {
        this.frame += 1;
        this._draw();
      }, 80);
    } else if (!need && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _scheduleDraw() {
    if (this._drawScheduled) return;
    this._drawScheduled = true;
    setImmediate(() => {
      this._drawScheduled = false;
      this._draw();
    });
  }

  // -------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------

  _eraseSeq() {
    return `${this.cursorRow > 0 ? `\x1b[${this.cursorRow}A` : ''}\r\x1b[J`;
  }

  _draw(prefix = '') {
    if (!this.started) {
      if (prefix) this.out.write(prefix.replace(/\r\n/g, '\n'));
      return;
    }
    const cols = Math.max(this.out.columns || 80, 30);
    let redrawHeader = this._headerNeedsDraw;
    if (this._lastCols !== null && this._lastCols !== cols) {
      redrawHeader = true;
    }
    this._lastCols = cols;
    const { lines, cursor } = this._compose();
    let buf = '\x1b[?25l';
    if (redrawHeader) {
      buf += '\x1b[2J\x1b[3J\x1b[H';
      if (this.headerLines.length) buf += `${this.headerLines.join('\r\n')}\r\n`;
      if (this.transcript.length) buf += this.transcript.join('');
      this.cursorRow = 0;
      this._headerNeedsDraw = false;
    } else {
      buf += this._eraseSeq();
    }
    if (prefix) this.transcript.push(prefix);
    buf += `${prefix}${lines.join('\r\n')}`;
    const up = lines.length - 1 - cursor.row;
    if (up > 0) buf += `\x1b[${up}A`;
    buf += '\r';
    if (cursor.col > 0) buf += `\x1b[${cursor.col}C`;
    buf += '\x1b[?25h';
    this.cursorRow = cursor.row;
    this.out.write(buf);
  }

  _compose() {
    const cols = Math.max(this.out.columns || 80, 30);
    const t = style.getTheme();
    const now = (Date.now() - this.t0) / 1000;
    const lines = [];

    if (this.typing) lines.push(truncate(this.typing.partial, cols - 1, ''));

    if (this.busy || this.askState || this.pickState) {
      lines.push(style.separator('', cols));
      lines.push(...this._activityLines(cols, now, t));
      lines.push(style.separator('', cols));
    }

    // ---- input box ----
    if (this.pendingPastes.length) {
      const pasted = this.pendingPastes.map((item) => `${item.label}${item.kind === 'text' ? ` · ${item.text.length} chars` : ''}`).join('  ·  ');
      lines.push(truncate(`  ${chalk.hex(t.secondary)('⎇')} ${chalk.hex(t.textSoft)(pasted)}`, cols - 1));
    }
    const busyPhase = this.busy ? now / 4 : 0;
    const askColor = t.warn;
    const edgeL = this.askState ? askColor : style.sampleGradient(t.gradient, busyPhase);
    const edgeR = this.askState ? askColor : style.sampleGradient(t.gradient, busyPhase + 0.5);
    const bar = (l, r, fill) => {
      const inner = fill.repeat(cols - 2);
      if (this.askState) return chalk.hex(askColor)(l + inner + r);
      return chalk.hex(edgeL)(l) + style.gradientLine(inner, t.gradient, busyPhase) + chalk.hex(edgeR)(r);
    };
    lines.push(bar('\u256d', '\u256e', '\u2500'));
    const boxTop = lines.length;

    const textWidth = cols - 6;
    const rows = this.editor.layout(textWidth);
    const pos = this.editor.cursorPosition(textWidth, rows);
    if (pos.row < this.inputScroll) this.inputScroll = pos.row;
    if (pos.row >= this.inputScroll + MAX_INPUT_ROWS) this.inputScroll = pos.row - MAX_INPUT_ROWS + 1;
    this.inputScroll = Math.max(0, Math.min(this.inputScroll, Math.max(rows.length - MAX_INPUT_ROWS, 0)));
    const promptColor = this.askState ? askColor : this.busy ? style.pulse(t.primary, t.accent, now, 1.6) : t.primary;
    const promptChar = this.askState ? '?' : this.pickState ? '\u2315' : '\u203a';
    const text = this.editor.text;
    const mentions = this.askState || this.pickState ? [] : mentionRanges(this.editor.chars);
    const inMention = (i) => mentions.some(([a, b]) => i >= a && i < b);
    const slashEnd = text.startsWith('/') && !this.askState && !this.pickState ? (text.search(/\s/) === -1 ? text.length : text.search(/\s/)) : 0;

    const visible = rows.slice(this.inputScroll, this.inputScroll + MAX_INPUT_ROWS);
    visible.forEach((row, k) => {
      const rowIdx = this.inputScroll + k;
      let body = '';
      for (let i = row.start; i < row.end; i++) {
        const ch = this.askState && this.askState.secret ? '\u2022' : this.editor.chars[i];
        body += i < slashEnd ? chalk.hex(t.accent).bold(ch) : inMention(i) ? chalk.hex(t.secondary).underline(ch) : chalk.hex(t.text)(ch);
      }
      if (!text && rowIdx === 0 && !this.askState) body = chalk.hex(t.dim).italic(this.pickState ? 'type to filter\u2026' : PLACEHOLDER);
      const lead = rowIdx === 0 ? chalk.hex(promptColor).bold(`${promptChar} `) : '  ';
      const content = padEnd(`${lead}${truncate(body, textWidth + 1, '')}`, cols - 4);
      lines.push(`${chalk.hex(edgeL)('\u2502')} ${content} ${chalk.hex(edgeR)('\u2502')}`);
    });
    lines.push(bar('\u2570', '\u256f', '\u2500'));

    // ---- below the box: slash menu or footer ----
    if (this.menu && !this.askState) lines.push(...this._menuLines(cols, t));
    else lines.push(this._footerLine(cols, t));

    return { lines, cursor: { row: boxTop + (pos.row - this.inputScroll), col: 4 + pos.col } };
  }

  _pickLines(cols, t) {
    const p = this.pickState;
    const out = [truncate(`  ${chalk.hex(t.primary).bold(p.title)}  ${chalk.hex(t.dim)('\u2191\u2193 choose \u00b7 enter open \u00b7 esc cancel \u00b7 type to filter')}`, cols - 1)];
    if (!p.filtered.length) return [...out, chalk.hex(t.dim)('    no match')];
    const rows = 8;
    const start = Math.max(0, Math.min(p.index - Math.floor(rows / 2), p.filtered.length - rows));
    const slice = p.filtered.slice(start, start + rows);
    const descW = Math.min(Math.max(...slice.map((i) => strWidth(i.desc || ''))), Math.floor(cols / 3));
    const labelW = cols - 8 - (descW ? descW + 2 : 0);
    slice.forEach((item, k) => {
      const sel = start + k === p.index;
      const label = padEnd(truncate(item.label, labelW), labelW);
      const line = `  ${sel ? chalk.hex(t.primary).bold('\u276f') : ' '} ${sel ? chalk.hex(t.text).bold(label) : chalk.hex(t.textSoft)(label)}${descW ? `  ${chalk.hex(t.dim)(truncate(item.desc || '', descW))}` : ''}`;
      out.push(truncate(line, cols - 1));
    });
    if (p.filtered.length > rows) out.push(chalk.hex(t.dim)(`    ${p.index + 1}/${p.filtered.length}`));
    return out;
  }

  _activityLines(cols, now, t) {
    if (this.pickState) return this._pickLines(cols, t);
    const out = [];
    if (this.askState) {
      const q = this.askState.question.replace(/\s+$/, '').split('\n');
      q.forEach((line, i) => out.push(truncate(`  ${i === 0 ? chalk.hex(t.warn).bold('\u26a0') : ' '} ${line}`, cols - 1)));
      out.push(chalk.hex(t.dim)('    type your answer and press Enter \u00b7 esc to cancel'));
      return out;
    }
    const a = this.activity || {};
    const spin = chalk.hex(style.sampleGradient(t.gradient, now / 3)).bold(SPINNER[this.frame % SPINNER.length]);
    const verbText = typeof a.verb === 'function' ? a.verb() : a.verb;
    const verb = style.shimmer(`${verbText || 'Thinking'}\u2026`, now);
    const meta = [fmtElapsed((Date.now() - (a.startedAt || Date.now())) / 1000)];
    if (a.tokens > 0) meta.push(`\u2193 ${fmtTokens(a.tokens)} tokens`);
    meta.push('esc to interrupt');
    out.push(truncate(`  ${spin} ${verb} ${chalk.hex(t.dim)(`(${meta.join(' \u00b7 ')})`)}`, cols - 1));

    (a.preview || []).slice(-2).forEach((line, i, arr) => {
      const lead = i === 0 ? '\u23bf ' : '  ';
      const faded = i === arr.length - 1 ? t.textSoft : t.dim;
      out.push(truncate(`    ${chalk.hex(t.faint)(lead)}${chalk.hex(faded).italic(line)}`, cols - 1));
    });

    this.queue.slice(0, 3).forEach((q) => {
      const queuedText = typeof q === 'string' ? q : q.text || '';
      out.push(truncate(`  ${chalk.hex(t.accent)('\u29d7')} ${chalk.hex(t.dim)('queued')}  ${chalk.hex(t.textSoft)(queuedText.replace(/\s+/g, ' '))}`, cols - 1));
    });
    if (this.queue.length > 3) out.push(chalk.hex(t.dim)(`    +${this.queue.length - 3} more queued`));
    return out;
  }

  _menuLines(cols, t) {
    const { items, index } = this.menu;
    const start = Math.max(0, Math.min(index - Math.floor(MAX_MENU_ROWS / 2), items.length - MAX_MENU_ROWS));
    const slice = items.slice(start, start + MAX_MENU_ROWS);
    const labelW = Math.min(Math.max(...slice.map((i) => strWidth(i.label))) + 2, Math.floor(cols / 2));
    const out = slice.map((item, k) => {
      const selected = start + k === index;
      const marker = selected ? chalk.hex(t.primary).bold('\u276f') : ' ';
      const label = selected ? chalk.hex(t.primary).bold(padEnd(item.label, labelW)) : chalk.hex(t.textSoft)(padEnd(item.label, labelW));
      const desc = selected ? chalk.hex(t.text)(item.desc || '') : chalk.hex(t.dim)(item.desc || '');
      return truncate(`  ${marker} ${label}${desc}`, cols - 1);
    });
    if (items.length > MAX_MENU_ROWS) {
      out.push(chalk.hex(t.dim)(`    \u2191\u2193 ${index + 1}/${items.length} \u00b7 tab/enter select \u00b7 esc close`));
    }
    return out;
  }

  _footerLine(cols, t) {
    const left = this.hint
      ? chalk.hex(t.warn)(this.hint)
      : chalk.hex(t.dim)(this.pickState ? 'enter to select \u00b7 esc to cancel' : this.askState ? 'enter to answer \u00b7 esc to cancel' : this.busy ? 'enter queues your message \u00b7 esc interrupts' : '/ commands \u00b7 alt+enter newline \u00b7 ctrl+c exit');
    const right = chalk.hex(t.dim)(this.footerRight);
    const gap = cols - 4 - strWidth(left) - strWidth(right);
    if (gap < 2) return truncate(`  ${left}`, cols - 1);
    return `  ${left}${' '.repeat(gap)}${right}  `;
  }

  // -------------------------------------------------------------------
  // Input handling
  // -------------------------------------------------------------------

  _refreshMenu() {
    if (this.pickState) {
      this.menu = null;
      this._filterPick();
      return;
    }
    if (this.askState || !this.handlers.suggest) {
      this.menu = null;
      return;
    }
    const text = this.editor.text;
    if (this.menuDismissedFor === text) {
      this.menu = null;
      return;
    }
    const items = this.handlers.suggest(text, this.editor.cursor) || [];
    if (!items.length) {
      this.menu = null;
      return;
    }
    const prev = this.menu && this.menu.items[this.menu.index];
    let index = 0;
    if (prev) {
      const k = items.findIndex((i) => i.label === prev.label);
      if (k >= 0) index = k;
    }
    this.menu = { items, index };
  }

  _acceptMenu() {
    const sel = this.menu.items[this.menu.index];
    if (sel.range) this.editor.replaceRange(sel.range.start, sel.range.end, sel.insert);
    else this.editor.set(sel.insert);
    this.menuDismissedFor = null;
    return sel;
  }

  _submit() {
    const text = this.editor.text;
    if (this.askState) {
      const st = this.askState;
      this.editor.set('', { record: false });
      st.resolve(text.trim());
      return;
    }
    if (!text.trim() && !this.pendingPastes.length) return;
    const pastes = this.pendingPastes.splice(0);
    this.editor.pushHistory(text);
    this.editor.clear({ record: false });
    this.menu = null;
    this.inputScroll = 0;
    if (this.handlers.onHistory && text) this.handlers.onHistory(text);
    if (this.handlers.onSubmit) this.handlers.onSubmit(text, pastes);
  }

  _capturePaste() {
    if (!this.handlers.onPaste) return false;
    const pasted = this.handlers.onPaste();
    if (!pasted) return false;
    if (pasted.inline && pasted.kind === 'text') {
      this.editor.insert(pasted.text);
      this._lastCapturedPaste = Date.now();
      this._refreshMenu();
      this._scheduleDraw();
      return 'inline';
    }
    this.pendingPastes.push(pasted);
    this._lastCapturedPaste = Date.now();
    this.setHint(pasted.label);
    this._scheduleDraw();
    return true;
  }

  _ctrlC() {
    const now = Date.now();
    if (this.askState) return this.askState.resolve('');
    const empty = !this.editor.text;
    if (empty && now - this._lastCtrlC < 1500) {
      this._lastCtrlC = 0;
      return this.handlers.onExit && this.handlers.onExit();
    }
    this._lastCtrlC = now;
    if (this.busy) {
      if (this.handlers.onInterrupt) this.handlers.onInterrupt();
      return this.setHint('Interrupted \u00b7 press ctrl+c again to exit');
    }
    if (!empty) {
      this.editor.clear({ record: false });
      this.menu = null;
      this._lastCtrlC = 0;
      return undefined;
    }
    return this.setHint('Press ctrl+c again to exit');
  }

  _handleKey(str, key) {
    key = key || {};
    const name = key.name;
    const ed = this.editor;
    if (this.typing) this.typingSkip = true;

    if (name === 'paste-start') {
      if (Date.now() - this._lastCapturedPaste < 250) {
        this.pasting = 'captured';
        return;
      }
      const result = this._capturePaste();
      this.pasting = result ? 'captured' : true;
      return;
    }
    if (name === 'paste-end') {
      this.pasting = false;
      if (this._pasteUndoBatch) {
        ed.endUndoBatch();
        this._pasteUndoBatch = false;
      }
      this._refreshMenu();
      this._scheduleDraw();
      return;
    }
    if (this.pasting) {
      if (this.pasting === 'captured') {
        this._scheduleDraw();
        return;
      }
      if (!this._pasteUndoBatch) {
        ed.beginUndoBatch();
        this._pasteUndoBatch = true;
      }
      if (name === 'return' || name === 'enter') this.editor.insert('\n');
      else if (str && (str >= ' ' || str === '\t')) this.editor.insert(str);
      this._scheduleDraw();
      return;
    }

    const width = Math.max((this.out.columns || 80) - 6, 10);
    let changed = true;

    if (this.pickState && this._handlePickKey(key)) {
      this._scheduleDraw();
      return;
    }

    if (key.ctrl && name === 'v') {
      const result = this._capturePaste();
      changed = result === 'inline';
    } else if (key.ctrl && name === 'c') {
      this._ctrlC();
    } else if (key.ctrl && name === 'z') {
      changed = ed.undo();
      if (!changed) this.setHint('Nothing to undo');
    } else if (key.ctrl && name === 'd') {
      if (!ed.text && !this.askState) {
        if (this.handlers.onExit) this.handlers.onExit();
        return;
      }
      ed.del();
    } else if (name === 'escape') {
      if (this.menu) {
        this.menuDismissedFor = ed.text;
        this.menu = null;
      } else if (this.askState) {
        this.askState.resolve('');
      } else if (this.busy) {
        if (this.handlers.onInterrupt) this.handlers.onInterrupt();
      } else if (ed.text && Date.now() - this._lastEsc < 600) {
        ed.clear({ record: false });
      } else if (ed.text) {
        this.setHint('Press esc again to clear');
      }
      this._lastEsc = Date.now();
    } else if (name === 'return' && !key.meta && !key.shift) {
      // trailing backslash = line continuation
      if (!this.askState && ed.cursor === ed.chars.length && ed.chars[ed.chars.length - 1] === '\\') {
        ed.backspace();
        ed.insert('\n');
      } else if (this.menu && !this.askState) {
        const sel = this.menu.items[this.menu.index];
        if (sel.range || sel.insert.trim() !== ed.text.trim()) {
          this._acceptMenu();
          if (sel.final) this._submit();
        } else {
          this._submit();
        }
      } else {
        this._submit();
      }
    } else if ((name === 'return' && (key.meta || key.shift)) || name === 'enter') {
      ed.insert('\n');
    } else if (name === 'tab') {
      if (key.shift && this.handlers.onModeCycle && !this.menu) this.handlers.onModeCycle();
      else if (this.menu) this._acceptMenu();
    } else if (name === 'up') {
      if (this.menu) this.menu.index = (this.menu.index - 1 + this.menu.items.length) % this.menu.items.length;
      else if (!ed.moveVertical(-1, width)) ed.historyPrev();
      changed = !this.menu;
    } else if (name === 'down') {
      if (this.menu) this.menu.index = (this.menu.index + 1) % this.menu.items.length;
      else if (!ed.moveVertical(1, width)) ed.historyNext();
      changed = !this.menu;
    } else if (name === 'left') {
      if (key.ctrl || key.meta) ed.wordLeft();
      else ed.left();
    } else if (name === 'right') {
      if (key.ctrl || key.meta) ed.wordRight();
      else ed.right();
    } else if (name === 'home' || (key.ctrl && name === 'a')) {
      ed.home();
    } else if (name === 'end' || (key.ctrl && name === 'e')) {
      ed.end();
    } else if (name === 'backspace') {
      if (key.meta || key.ctrl) ed.deleteWordBack();
      else ed.backspace();
    } else if (name === 'delete') {
      ed.del();
    } else if (key.ctrl && name === 'w') {
      ed.deleteWordBack();
    } else if (key.ctrl && name === 'u') {
      ed.killToStart();
    } else if (key.ctrl && name === 'k') {
      ed.killToEnd();
    } else if (key.ctrl && name === 'y') {
      if (ed.killBuffer) ed.yank();
      else {
        changed = ed.redo();
        if (!changed) this.setHint('Nothing to redo');
      }
    } else if (key.ctrl && name === 't') {
      ed.transpose();
    } else if (key.ctrl && name === 'b') {
      ed.left();
    } else if (key.ctrl && name === 'f') {
      ed.right();
    } else if (key.meta && name === 'b') {
      ed.wordLeft();
    } else if (key.meta && name === 'f') {
      ed.wordRight();
    } else if (key.ctrl && name === 'l') {
      this.clearScreen();
    } else if (str && !key.ctrl && !key.meta && str >= ' ' && str !== '\x7f') {
      ed.insert(str);
    } else {
      changed = false;
    }

    if (changed) this._refreshMenu();
    this._scheduleDraw();
  }
}

// ---------------------------------------------------------------------------
// Non-interactive fallback (piped stdin / CI): sequential line reading.
// ---------------------------------------------------------------------------

class PlainUI {
  constructor() {
    this.pull = true;
    this.lines = [];
    this.waiters = [];
    this.closed = false;
    this.started = false;
  }

  start(handlers) {
    this.handlers = handlers || {};
    this.started = true;
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      if (this.waiters.length) this.waiters.shift()(line);
      else this.lines.push(line);
    });
    rl.on('close', () => {
      this.closed = true;
      while (this.waiters.length) this.waiters.shift()(null);
    });
  }

  stop() {
    this.started = false;
  }

  nextLine() {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  print(text = '') {
    process.stdout.write(`${text}\n`);
  }

  async ask(question) {
    process.stdout.write(`${stripAnsi(String(question))} `);
    const line = await this.nextLine();
    process.stdout.write('\n');
    return (line || '').trim();
  }

  typeOut(lines) {
    if (lines.length) this.print(lines.join('\n'));
    return Promise.resolve();
  }

  async select(title, items) {
    if (!items.length) return null;
    this.print(title);
    items.slice(0, 20).forEach((it, i) => this.print(`  ${i + 1}) ${it.label}${it.desc ? `  (${it.desc})` : ''}`));
    const answer = await this.ask('Number (empty to cancel):');
    const n = parseInt(answer, 10);
    return n >= 1 && n <= items.length ? items[n - 1].value : null;
  }

  setBusy() {}

  setActivity() {}

  setQueue() {}

  setHint() {}

  setFooterRight() {}
}

module.exports = { TerminalUI, PlainUI, fmtElapsed, fmtTokens };
