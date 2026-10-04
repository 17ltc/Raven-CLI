'use strict';
/**
 * Small Markdown -> ANSI renderer for terminal output.
 * Handles headings, bold/italic/strike, inline code, links, lists,
 * blockquotes, rules, fenced code (with light syntax colors) and tables.
 * Returns an array of lines (already word-wrapped to `width`).
 */

const chalk = require('chalk');
const { strWidth, stripAnsi, truncate, padEnd, hardWrap } = require('./ansi');
const { getTheme, gradientLine } = require('../style');

const KEYWORDS = new Set(
  (
    'const let var function return if else for while do switch case break continue new class extends import from export default ' +
    'async await try catch finally throw typeof instanceof in of this super null undefined true false void yield static ' +
    'def lambda pass raise with as is not and or elif None True False self print from import global nonlocal ' +
    'fn pub mut impl struct enum match use mod trait where loop go func package interface type var range defer ' +
    'echo fi then done esac select public private protected final int string bool float double char long'
  ).split(/\s+/)
);

function highlightCode(line, lang, t) {
  const c = {
    kw: chalk.hex(t.accent),
    str: chalk.hex(t.ok),
    num: chalk.hex(t.warn),
    com: chalk.hex(t.dim).italic,
    fn: chalk.hex(t.secondary),
    base: chalk.hex(t.text),
  };
  const isHashComment = /^(py|python|sh|bash|zsh|shell|yaml|yml|toml|rb|ruby|dockerfile|make)$/i.test(lang || '');
  const rx = /(\/\/.*$|\/\*.*?\*\/|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\()|([A-Za-z_$][\w$]*)/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = rx.exec(line)) !== null) {
    out += c.base(line.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      const hash = m[1].startsWith('#');
      if (hash && !isHashComment) out += c.base(m[1]);
      else out += c.com(m[1]);
    } else if (m[2] !== undefined) out += c.str(m[2]);
    else if (m[3] !== undefined) out += c.num(m[3]);
    else if (m[4] !== undefined) out += KEYWORDS.has(m[4]) ? c.kw(m[4]) : c.fn(m[4]);
    else out += KEYWORDS.has(m[5]) ? c.kw(m[5]) : c.base(m[5]);
  }
  return out + c.base(line.slice(last));
}

/** Parse inline markdown into [{text, style}] segments. */
function inlineSegments(text, t) {
  const segs = [];
  const rx = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\)|(?<![\w*])\*[^*\s][^*\n]*?\*(?![\w*]))/g;
  let last = 0;
  let m;
  const plain = chalk.hex(t.text);
  while ((m = rx.exec(text)) !== null) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index), style: plain });
    const tok = m[0];
    if (tok.startsWith('**') || tok.startsWith('__')) segs.push({ text: tok.slice(2, -2), style: chalk.hex('#FFFFFF').bold });
    else if (tok.startsWith('`')) segs.push({ text: tok.slice(1, -1), style: chalk.hex(t.secondary).bgHex(t.codeBg), code: true });
    else if (tok.startsWith('~~')) segs.push({ text: tok.slice(2, -2), style: chalk.hex(t.dim).strikethrough });
    else if (tok.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      segs.push({ text: mm[1], style: chalk.hex(t.secondary).underline });
      segs.push({ text: ` (${mm[2]})`, style: chalk.hex(t.dim) });
    } else segs.push({ text: tok.slice(1, -1), style: chalk.hex(t.textSoft).italic });
    last = m.index + tok.length;
  }
  if (last < text.length) segs.push({ text: text.slice(last), style: plain });
  return segs;
}

/** Word-wrap styled segments. Returns array of styled lines (no indent). */
function wrapSegments(segs, width) {
  const lines = [];
  let cur = '';
  let curW = 0;
  const flush = () => {
    lines.push(cur);
    cur = '';
    curW = 0;
  };
  for (const seg of segs) {
    const parts = seg.code ? [seg.text] : seg.text.split(/(\s+)/);
    for (const part of parts) {
      if (part === '') continue;
      const isSpace = /^\s+$/.test(part);
      const piece = isSpace ? ' ' : part;
      const w = strWidth(piece);
      if (isSpace) {
        if (curW > 0 && curW + 1 <= width) {
          cur += seg.style(' ');
          curW += 1;
        }
        continue;
      }
      if (curW + w > width && curW > 0) {
        cur = cur.replace(/\s+$/, '');
        flush();
      }
      if (w > width) {
        for (const chunk of hardWrap(piece, width)) {
          if (curW > 0) flush();
          cur += seg.style(chunk);
          curW = strWidth(chunk);
        }
      } else {
        cur += seg.style(piece);
        curW += w;
      }
    }
  }
  if (cur || !lines.length) flush();
  return lines;
}

function renderTable(rows, width, t) {
  const cells = rows.map((r) => r.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim()));
  const head = cells[0];
  const body = cells.slice(2);
  const cols = head.length;
  const styled = (r) => Array.from({ length: cols }, (_, i) => wrapSegments(inlineSegments(r[i] || '', t), 1000)[0] || '');
  const all = [styled(head), ...body.map(styled)];
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...all.map((r) => strWidth(r[i]))));
  const budget = width - (cols * 3 + 1);
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > budget && Math.max(...widths) > 6) {
    const idx = widths.indexOf(Math.max(...widths));
    widths[idx] -= 1;
    total -= 1;
  }
  const faint = chalk.hex(t.faint);
  const line = (l, m, r) => faint(l + widths.map((w) => '\u2500'.repeat(w + 2)).join(m) + r);
  const fmtRow = (r, bold) =>
    faint('\u2502') +
    r.map((c, i) => ' ' + padEnd(truncate(bold ? chalk.bold(stripAnsi(c)) : c, widths[i]), widths[i]) + ' ').join(faint('\u2502')) +
    faint('\u2502');
  const out = [line('\u256d', '\u252c', '\u256e'), fmtRow(all[0], true), line('\u251c', '\u253c', '\u2524')];
  for (const r of all.slice(1)) out.push(fmtRow(r, false));
  out.push(line('\u2570', '\u2534', '\u256f'));
  return out;
}

function renderMarkdown(src, opts = {}) {
  const t = opts.theme || getTheme();
  const width = Math.max(24, opts.width || process.stdout.columns || 80);
  const rows = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const faint = chalk.hex(t.faint);
  let i = 0;

  while (i < rows.length) {
    const row = rows[i];

    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)/.exec(row);
    if (fence) {
      const lang = fence[2] || '';
      const code = [];
      i += 1;
      while (i < rows.length && !/^\s*(```|~~~)\s*$/.test(rows[i])) {
        code.push(rows[i]);
        i += 1;
      }
      i += 1;
      const inner = width - 4;
      const label = lang ? ` ${lang} ` : '';
      out.push(faint('\u256d\u2500') + chalk.hex(t.dim)(label) + faint('\u2500'.repeat(Math.max(inner - strWidth(label) + 2, 2))));
      for (const cl of code) {
        const tabbed = cl.replace(/\t/g, '  ');
        const parts = strWidth(tabbed) > inner ? hardWrap(tabbed, inner) : [tabbed];
        for (const p of parts) out.push(`${faint('\u2502')} ${highlightCode(p, lang, t)}`);
      }
      out.push(faint('\u2570' + '\u2500'.repeat(Math.max(inner + 1, 2))));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(row);
    if (heading) {
      const level = heading[1].length;
      const txt = heading[2].replace(/\*\*/g, '');
      if (out.length && out[out.length - 1] !== '') out.push('');
      if (level === 1) {
        out.push(gradientLine(txt.toUpperCase(), t.gradient, 0));
        out.push(faint('\u2501'.repeat(Math.min(strWidth(txt) + 2, width))));
      } else if (level === 2) out.push(chalk.hex(t.primary).bold(txt));
      else out.push(chalk.hex(t.secondary).bold(txt));
      i += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(row)) {
      out.push(faint('\u2500'.repeat(Math.min(width, 60))));
      i += 1;
      continue;
    }

    if (row.includes('|') && i + 1 < rows.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(rows[i + 1])) {
      const block = [row, rows[i + 1]];
      i += 2;
      while (i < rows.length && rows[i].includes('|') && rows[i].trim()) {
        block.push(rows[i]);
        i += 1;
      }
      out.push(...renderTable(block, width, t));
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(row);
    if (quote) {
      for (const l of wrapSegments(inlineSegments(quote[1], t), width - 2)) out.push(`${chalk.hex(t.primary)('\u258e')} ${chalk.italic(l)}`);
      i += 1;
      continue;
    }

    const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(row);
    if (list) {
      const depth = Math.floor(list[1].replace(/\t/g, '  ').length / 2);
      const numbered = /\d/.test(list[2]);
      const bullet = numbered ? chalk.hex(t.primary)(list[2]) : chalk.hex(t.primary)(depth % 2 ? '\u25e6' : '\u2022');
      const indent = ' '.repeat(depth * 2 + 1);
      const bw = strWidth(numbered ? list[2] : '\u2022');
      const wrapped = wrapSegments(inlineSegments(list[3], t), Math.max(width - indent.length - bw - 1, 10));
      wrapped.forEach((l, k) => out.push(`${indent}${k === 0 ? bullet : ' '.repeat(bw)} ${l}`));
      i += 1;
      continue;
    }

    if (!row.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      i += 1;
      continue;
    }

    for (const l of wrapSegments(inlineSegments(row, t), width)) out.push(l);
    i += 1;
  }

  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

module.exports = { renderMarkdown, highlightCode, inlineSegments, wrapSegments };
