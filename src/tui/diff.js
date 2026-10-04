'use strict';
/** Line diff (Myers) + colored terminal rendering with line numbers. */

const chalk = require('chalk');
const { truncate, padEnd, strWidth } = require('./ansi');
const { getTheme } = require('../style');

const MAX_EDIT_DISTANCE = 1500;

function backtrack(trace, A, B, D, off) {
  let x = A.length;
  let y = B.length;
  const ops = [];
  for (let d = D; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: '=', a: x - 1, b: y - 1 });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) ops.push({ t: '+', b: y - 1 });
    else ops.push({ t: '-', a: x - 1 });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ t: '=', a: x - 1, b: y - 1 });
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

/** Myers O(ND). Returns ops or null when the edit distance is too large. */
function myers(A, B) {
  const N = A.length;
  const M = B.length;
  const max = N + M;
  if (max === 0) return [];
  const limit = Math.min(max, MAX_EDIT_DISTANCE);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x += 1;
        y += 1;
      }
      v[off + k] = x;
      if (x >= N && y >= M) return backtrack(trace, A, B, d, off);
    }
  }
  return null;
}

/** @returns {{t:'='|'+'|'-', a?:number, b?:number}[]} indexes are 0-based into a / b */
function diffOps(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s += 1;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea -= 1;
    eb -= 1;
  }
  const ops = [];
  for (let i = 0; i < s; i++) ops.push({ t: '=', a: i, b: i });
  const A = a.slice(s, ea);
  const B = b.slice(s, eb);
  let mid = myers(A, B);
  if (mid === null) {
    mid = [...A.map((_, i) => ({ t: '-', a: i })), ...B.map((_, i) => ({ t: '+', b: i }))];
  }
  for (const op of mid) {
    ops.push({ t: op.t, a: op.a !== undefined ? op.a + s : undefined, b: op.b !== undefined ? op.b + s : undefined });
  }
  for (let i = 0; i < a.length - ea; i++) ops.push({ t: '=', a: ea + i, b: eb + i });
  return ops;
}

function splitLines(text) {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Group ops into hunks with `ctx` lines of context. */
function makeHunks(ops, aLines, bLines, ctx = 3) {
  const changed = [];
  ops.forEach((op, i) => {
    if (op.t !== '=') changed.push(i);
  });
  if (!changed.length) return [];
  const ranges = [];
  let start = Math.max(changed[0] - ctx, 0);
  let end = Math.min(changed[0] + ctx, ops.length - 1);
  for (const idx of changed.slice(1)) {
    if (idx - ctx <= end + 1) end = Math.min(idx + ctx, ops.length - 1);
    else {
      ranges.push([start, end]);
      start = Math.max(idx - ctx, 0);
      end = Math.min(idx + ctx, ops.length - 1);
    }
  }
  ranges.push([start, end]);
  return ranges.map(([s, e]) =>
    ops.slice(s, e + 1).map((op) => ({
      t: op.t,
      text: op.t === '+' ? bLines[op.b] : aLines[op.a],
      an: op.a !== undefined ? op.a + 1 : null,
      bn: op.b !== undefined ? op.b + 1 : null,
    }))
  );
}

function stats(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = diffOps(a, b);
  return { add: ops.filter((o) => o.t === '+').length, del: ops.filter((o) => o.t === '-').length, ops, a, b };
}

function toText(state) {
  if (state === null || state === undefined) return null;
  if (state.large) return null;
  if (isBinary(state)) return null;
  return state.toString('utf8');
}

/**
 * Render one file change ({path, before, after}: Buffer|null|{large}) as
 * colored lines. `displayPath` is shown in the header.
 */
function renderChange(change, opts = {}) {
  const t = getTheme();
  const width = Math.max(opts.width || process.stdout.columns || 80, 40);
  const budget = opts.maxLines || 40;
  const name = opts.displayPath || change.path;
  const { before, after } = change;
  const out = [];

  const head = (verb, color, extra = '') => `${chalk.hex(color).bold(verb)} ${chalk.hex(t.text)(name)}${extra ? `  ${extra}` : ''}`;
  const counts = (add, del) => `${chalk.hex(t.ok)(`+${add}`)} ${chalk.hex(t.err)(`-${del}`)}`;

  const bt = toText(before);
  const at = toText(after);
  const binary = (before && !before.large && bt === null) || (after && !after.large && at === null) || (before && before.large) || (after && after.large);
  if (binary) {
    const size = after && !after.large ? after.length : after && after.large ? after.size : 0;
    out.push(head(after === null ? 'Deleted' : before === null ? 'Created' : 'Updated', after === null ? t.err : t.warn, chalk.hex(t.dim)(`(binary or large file, ${size} bytes)`)));
    return out;
  }

  const { add, del, ops, a, b } = stats(bt || '', at || '');
  const verb = before === null ? 'Created' : after === null ? 'Deleted' : 'Updated';
  const color = before === null ? t.ok : after === null ? t.err : t.primary;
  out.push(head(verb, color, counts(add, del)));
  if (!add && !del) return out;

  const hunks = makeHunks(ops, a, b, before === null || after === null ? 0 : 3);
  const maxNo = Math.max(a.length, b.length, 1);
  const nw = String(maxNo).length;
  const body = [];
  hunks.forEach((h, i) => {
    if (i > 0) body.push(chalk.hex(t.faint)(`${' '.repeat(nw)} \u22ef`));
    for (const l of h) {
      const no = String(l.t === '-' ? l.an : l.bn ?? l.an).padStart(nw);
      const text = (l.text || '').replace(/\t/g, '  ');
      const room = width - nw - 5;
      const cut = truncate(text, room, '\u2026');
      if (l.t === '+') body.push(chalk.bgHex('#1B3A2B').hex('#C4F5D3')(padEnd(`${no} + ${cut}`, width - 2)));
      else if (l.t === '-') body.push(chalk.bgHex('#3D1E2A').hex('#F7BDBD')(padEnd(`${no} - ${cut}`, width - 2)));
      else body.push(chalk.hex(t.dim)(`${no}   ${cut}`));
    }
  });
  if (body.length > budget) {
    const shown = body.slice(0, budget);
    shown.push(chalk.hex(t.dim)(`\u2026 ${body.length - budget} more diff lines`));
    out.push(...shown);
  } else out.push(...body);
  return out;
}

module.exports = { diffOps, splitLines, makeHunks, renderChange, stats, isBinary, strWidth };
