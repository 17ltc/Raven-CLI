'use strict';
/**
 * Terminal styling: theme palette, gradients, shimmer animation and the
 * legacy print helpers. Port of Raven/style.py, upgraded.
 *
 * NOTE: the original palette used a deep navy (#063B5C) for "dim" text and
 * borders, which is almost invisible on dark terminals. All colors below are
 * readable on both dark and light-ish backgrounds.
 */

const chalk = require('chalk');
const { strWidth, hardWrap } = require('./tui/ansi');

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

const THEMES = {
  // Default: colors sampled from the Raven logo (lavender -> violet -> deep purple).
  raven: {
    label: 'Logo violet (default)',
    gradient: ['#D2B2FF', '#AB7AFF', '#8B5AFD', '#6E40D1'],
    colors: {
      primary: '#AB7AFF',
      secondary: '#D2B2FF',
      accent: '#8B5AFD',
      text: '#EEE9F8',
      textSoft: '#CBC2E3',
      dim: '#9A8FB8',
      faint: '#4B3E6E',
      userBg: '#1F1836',
      codeBg: '#251C40',
    },
  },
  ocean: { gradient: ['#22D3C5', '#38BDF8', '#818CF8'], label: 'Aqua -> sky -> indigo' },
  aurora: { gradient: ['#5EEAD4', '#A78BFA', '#F472B6'], label: 'Mint -> violet -> pink' },
  sunset: { gradient: ['#FDBA74', '#FB7185', '#C084FC'], label: 'Amber -> rose -> purple' },
  matrix: { gradient: ['#4ADE80', '#22C55E', '#86EFAC'], label: 'Green terminal' },
  mono: { gradient: ['#E5E7EB', '#9CA3AF', '#F3F4F6'], label: 'Monochrome' },
};

function buildTheme(name) {
  const base = THEMES[name] ? name : 'raven';
  const g = THEMES[base].gradient;
  return {
    name: base,
    gradient: g,
    primary: g[0],
    secondary: g[1],
    accent: g[2],
    text: '#E6EDF3',
    textSoft: '#B4C2D0',
    dim: '#8091A5',
    faint: '#3D4B5C',
    ok: '#4ADE80',
    warn: '#FBBF24',
    err: '#F87171',
    userBg: '#18232F',
    codeBg: '#1B2632',
    ...(THEMES[base].colors || {}),
  };
}

let theme = buildTheme('raven');

function getTheme() {
  return theme;
}

function setTheme(name) {
  theme = buildTheme(name);
  syncLegacyColors();
  return theme;
}

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

function hexToRgb(h) {
  h = h.replace(/^#/, '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function lerpColor(startHex, endHex, t) {
  t = Math.min(1, Math.max(0, t));
  const s = hexToRgb(startHex);
  const e = hexToRgb(endHex);
  const r = s.map((v, i) => Math.round(v + (e[i] - v) * t));
  return `#${r.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Sample a multi-stop gradient at position t in [0,1) (wraps around). */
function sampleGradient(stops, t) {
  t = ((t % 1) + 1) % 1;
  const seg = stops.length;
  const pos = t * seg;
  const i = Math.floor(pos) % seg;
  return lerpColor(stops[i], stops[(i + 1) % seg], pos - Math.floor(pos));
}

/** Color each line of `content` along a gradient from startHex to endHex, top to bottom. */
function gradientText(content, startHex, endHex) {
  const lines = content.split('\n');
  const n = Math.max(lines.length - 1, 1);
  return lines.map((line, i) => chalk.hex(lerpColor(startHex, endHex, i / n))(line)).join('\n');
}

function printGradient(content, startHex, endHex) {
  console.log(gradientText(content, startHex, endHex));
}

/** Horizontal gradient over a plain string; `phase` (0..1) slides the colors. */
function gradientLine(text, stops = theme.gradient, phase = 0) {
  const chars = Array.from(text);
  const n = Math.max(chars.length, 1);
  return chars.map((ch, i) => chalk.hex(sampleGradient(stops, i / n + phase))(ch)).join('');
}

/**
 * Shimmer: a bright band sweeps across the text. `t` is time in seconds.
 * Base color is the theme primary, the band whitens it.
 */
function shimmer(text, t, base = theme.primary, hi = '#FFFFFF') {
  const chars = Array.from(text);
  const n = chars.length;
  const span = n + 10;
  const center = ((t * 14) % span) - 5;
  return chars
    .map((ch, i) => {
      const d = Math.abs(i - center);
      const k = d < 4 ? Math.cos((d / 4) * (Math.PI / 2)) ** 2 : 0;
      return chalk.hex(lerpColor(base, hi, k * 0.9))(ch);
    })
    .join('');
}

/** Slowly "breathing" color between two hex values (period in seconds). */
function pulse(a, b, t, period = 2) {
  const k = (Math.sin((t / period) * Math.PI * 2) + 1) / 2;
  return lerpColor(a, b, k);
}

// ---------------------------------------------------------------------------
// Legacy constants (kept for the modules that still import them)
// ---------------------------------------------------------------------------

let PRIMARY_COLOR;
let SECONDARY_COLOR;
let ACCENT_COLOR;
let TEXT_PRIMARY;
let TEXT_SECONDARY;
let TEXT_DIM;
let BORDER_COLOR;
let HIGHLIGHT_COLOR;

function syncLegacyColors() {
  PRIMARY_COLOR = theme.primary;
  SECONDARY_COLOR = theme.secondary;
  ACCENT_COLOR = theme.accent;
  TEXT_PRIMARY = theme.text;
  TEXT_SECONDARY = theme.textSoft;
  TEXT_DIM = theme.dim;
  BORDER_COLOR = theme.faint;
  HIGHLIGHT_COLOR = theme.primary;
  module.exports.PRIMARY_COLOR = PRIMARY_COLOR;
  module.exports.SECONDARY_COLOR = SECONDARY_COLOR;
  module.exports.ACCENT_COLOR = ACCENT_COLOR;
  module.exports.TEXT_PRIMARY = TEXT_PRIMARY;
  module.exports.TEXT_SECONDARY = TEXT_SECONDARY;
  module.exports.TEXT_DIM = TEXT_DIM;
  module.exports.BORDER_COLOR = BORDER_COLOR;
  module.exports.HIGHLIGHT_COLOR = HIGHLIGHT_COLOR;
}

// ---------------------------------------------------------------------------
// Simple print helpers
// ---------------------------------------------------------------------------

function wrapLine(line, width) {
  if (!line) return [''];
  const words = line.split(' ');
  const out = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (strWidth(candidate) > width && current) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  const flat = [];
  for (const l of out.length ? out : ['']) flat.push(...(strWidth(l) > width ? hardWrap(l, width) : [l]));
  return flat;
}

/** Render the model's reasoning as a dimmed, gutter-prefixed block. */
function printThinking(content, thinkingTime = 0.0) {
  if (thinkingTime > 0) {
    console.log(chalk.hex(theme.dim)(`\u273b thought for ${thinkingTime.toFixed(1)}s`));
  }
  const width = Math.max((process.stdout.columns || 100) - 4, 20);
  const sourceLines = content.replace(/^\n+|\n+$/g, '').split('\n');
  for (const line of sourceLines) {
    for (const sub of wrapLine(line, width)) {
      console.log(`${chalk.hex(theme.faint)('\u2502')} ${chalk.hex(theme.dim).italic(sub)}`);
    }
  }
}

/** Animated spinner for non-TUI contexts. Returns a stop() function. */
function printThinkingAnimation(message = 'Thinking') {
  const frames = ['\u2802', '\u2810', '\u2820', '\u2880', '\u2840', '\u2804', '\u2802'];
  const start = Date.now();
  let i = 0;
  process.stdout.write('\x1b[?25l');
  const timer = setInterval(() => {
    const t = (Date.now() - start) / 1000;
    process.stdout.write(`\r${chalk.hex(sampleGradient(theme.gradient, t / 2))(frames[i % frames.length])} ${shimmer(message, t)}`);
    i += 1;
  }, 90);
  return () => {
    clearInterval(timer);
    process.stdout.write(`\r\x1b[2K`);
    process.stdout.write('\x1b[?25h');
  };
}

function printToolCall(toolName, args) {
  console.log(`${chalk.hex(theme.primary)('\u23fa')} ${chalk.hex(theme.text).bold(toolName)}`);
  if (args && Object.keys(args).length) {
    const argsStr = JSON.stringify(args, null, 2);
    const argsLines = argsStr.split('\n');
    for (const line of argsLines.slice(0, 3)) console.log(`  ${chalk.hex(theme.dim)(line)}`);
    if (argsLines.length > 3) console.log(`  ${chalk.hex(theme.dim)('...')}`);
  }
}

function printToolResult(result) {
  if (result && result.error) {
    console.log(`  ${chalk.hex(theme.err)('\u23bf error')} ${result.error}`);
  } else if (result && result.success) {
    console.log(`  ${chalk.hex(theme.ok)('\u23bf done')}`);
  } else {
    console.log(`  ${chalk.hex(theme.dim)('\u23bf result')}`);
  }
}

function printUserMessage(message) {
  console.log(`${chalk.hex(theme.primary).bold('\u203a')} ${chalk.hex(theme.text)(message)}`);
}

function printAiMessage(message) {
  console.log(chalk.hex(theme.primary).bold('Raven'));
  console.log(chalk.hex(theme.text)(message));
}

/** Thin separator line, optionally with a right-aligned label. */
function separator(label = '', width = process.stdout.columns || 80) {
  if (!label) return chalk.hex(theme.faint)('\u2500'.repeat(width));
  const tail = ` ${label} `;
  const bar = '\u2500'.repeat(Math.max(width - strWidth(tail) - 2, 2));
  return chalk.hex(theme.faint)(`${bar}${tail}\u2500\u2500`);
}

function printSeparator() {
  console.log(separator());
}

function printTypingIndicator() {
  process.stdout.write(chalk.hex(theme.primary)('\u258c'));
}

/** Measures and (optionally) prints thinking time. */
class ThinkingTimer {
  constructor() {
    this.startTime = null;
    this.endTime = null;
  }

  enter() {
    this.startTime = Date.now();
    return this;
  }

  exit() {
    this.endTime = Date.now();
    const elapsed = (this.endTime - this.startTime) / 1000;
    if (elapsed > 0.1) {
      console.log(chalk.hex(theme.dim)(`thinking ${elapsed.toFixed(1)}s`));
    }
  }

  static async run(fn) {
    const timer = new ThinkingTimer().enter();
    try {
      return await fn();
    } finally {
      timer.exit();
    }
  }
}

async function animateTextFade(text, colorHex = theme.primary) {
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const fade = lerpColor(theme.primary, colorHex, i / Math.max(chars.length - 1, 1));
    process.stdout.write(chalk.hex(fade)(chars[i]));
    if (i % 3 === 0) await new Promise((r) => setTimeout(r, 10));
  }
  process.stdout.write('\n');
}

function displayUserMessage(message) {
  printUserMessage(message);
}

function displayAiMessage(message) {
  printAiMessage(message);
}

/**
 * Minimal renderer for the small subset of `rich` bracket markup
 * ("[green]...[/green]") used by the ported commands.
 */
function renderRichMarkup(text) {
  if (typeof text !== 'string') return text;
  const tagColors = {
    cyan: (s) => chalk.hex(theme.primary)(s),
    green: (s) => chalk.hex(theme.ok)(s),
    red: (s) => chalk.hex(theme.err)(s),
    yellow: (s) => chalk.hex(theme.warn)(s),
    magenta: (s) => chalk.hex(theme.accent)(s),
    dim: (s) => chalk.hex(theme.dim)(s),
    bold: (s) => chalk.bold(s),
  };
  let out = text;
  for (const [tag, fn] of Object.entries(tagColors)) {
    const rx = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[/${tag}\\]`, 'g');
    out = out.replace(rx, (m, inner) => fn(inner));
  }
  return out;
}

syncLegacyColors();

Object.assign(module.exports, {
  THEMES,
  getTheme,
  setTheme,
  hexToRgb,
  lerpColor,
  sampleGradient,
  gradientText,
  gradientLine,
  shimmer,
  pulse,
  wrapLine,
  printGradient,
  printThinking,
  printThinkingAnimation,
  printToolCall,
  printToolResult,
  printUserMessage,
  printAiMessage,
  separator,
  printSeparator,
  printTypingIndicator,
  ThinkingTimer,
  animateTextFade,
  displayUserMessage,
  displayAiMessage,
  renderRichMarkup,
});
