'use strict';
/** ANSI-aware string helpers (visible width, truncation, slicing). */

const ANSI_SRC = '\\u001b\\[[0-9;?]*[ -/]*[@-~]|\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)';
const ANSI_RE = new RegExp(ANSI_SRC, 'g');
const ANSI_SPLIT_RE = new RegExp(`(${ANSI_SRC})`);
const RESET = '\u001b[0m';

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

/** Terminal cell width of one code point (0, 1 or 2). */
function charWidth(cp) {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x200d
  ) {
    return 0;
  }
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f680 && cp <= 0x1f6ff) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

function strWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

/** Cut a (possibly styled) string to at most `max` visible cells. */
function truncate(s, max, ellipsis = '\u2026') {
  s = String(s);
  if (max <= 0) return '';
  if (strWidth(s) <= max) return s;
  const limit = Math.max(0, max - strWidth(ellipsis));
  let out = '';
  let w = 0;
  let styled = false;
  for (const part of s.split(ANSI_SPLIT_RE)) {
    if (!part) continue;
    if (part.charCodeAt(0) === 27) {
      out += part;
      styled = true;
      continue;
    }
    for (const ch of part) {
      const cw = charWidth(ch.codePointAt(0));
      if (w + cw > limit) return out + (styled ? RESET : '') + ellipsis;
      out += ch;
      w += cw;
    }
  }
  return out;
}

/** Keep the first `n` visible code points (ANSI codes are preserved). */
function sliceChars(s, n) {
  let out = '';
  let count = 0;
  let styled = false;
  for (const part of String(s).split(ANSI_SPLIT_RE)) {
    if (!part) continue;
    if (part.charCodeAt(0) === 27) {
      out += part;
      styled = true;
      continue;
    }
    for (const ch of part) {
      if (count >= n) return out + (styled ? RESET : '');
      out += ch;
      count += 1;
    }
  }
  return out;
}

function visibleLength(s) {
  return Array.from(stripAnsi(s)).length;
}

function padEnd(s, width) {
  const w = strWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/** Hard-wrap a plain string on visible width (no word logic). */
function hardWrap(text, width) {
  const rows = [];
  let cur = '';
  let w = 0;
  for (const ch of String(text)) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > width && cur) {
      rows.push(cur);
      cur = '';
      w = 0;
    }
    cur += ch;
    w += cw;
  }
  rows.push(cur);
  return rows;
}

module.exports = { ANSI_RE, RESET, stripAnsi, charWidth, strWidth, truncate, sliceChars, visibleLength, padEnd, hardWrap };
