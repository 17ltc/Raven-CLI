'use strict';
/** Port of Raven/banner.py */

const chalk = require('chalk');
const style = require('./style');
const { strWidth, truncate } = require('./tui/ansi');

// Custom Raven mark - hand-provided, not generated. Kept verbatim.
const LOGO = `
\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2584  \u2584\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2584 \u2588\u2588\u2588   \u2588\u2588\u2588 \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588 \u2588\u2588\u2588\u2584\u2584  \u2588\u2588\u2588
\u2588\u2588\u2588   \u2588\u2588\u2588 \u2588\u2588\u2588   \u2588\u2588\u2588 \u2588\u2588\u2588   \u2588\u2588\u2588 \u2588\u2588\u2588      \u2588\u2588\u2588\u2580\u2588\u2588\u2584\u2588\u2588\u2588
\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588 \u2588\u2588\u2588\u2584 \u2584\u2588\u2588\u2588 \u2588\u2588\u2588\u2580\u2580\u2580   \u2588\u2588\u2588  \u2580\u2580\u2588\u2588\u2588
\u2588\u2588\u2588   \u2588\u2588\u2588 \u2588\u2588\u2588   \u2588\u2588\u2588  \u2580\u2588\u2588\u2588\u2588\u2588\u2580  \u2588\u2588\u2588\u2584\u2584\u2584\u2584\u2584 \u2588\u2588\u2588    \u2588\u2588\u2588
\u2580\u2580\u2580   \u2580\u2580\u2580 \u2580\u2580\u2580   \u2580\u2580\u2580    \u2580\u2580\u2580    \u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580 \u2580\u2580\u2580    \u2580\u2580\u2580
`;

function renderLogo() {
  return LOGO.replace(/^\n+|\n+$/g, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function paintLogo(lines, phase) {
  const t = style.getTheme();
  const width = Math.max(...lines.map((l) => l.length));
  return lines
    .map((line) =>
      Array.from(line)
        .map((ch, x) => (ch === ' ' ? ch : chalk.hex(style.sampleGradient(t.gradient, x / width + phase))(ch)))
        .join('')
    )
    .join('\n');
}

/** Compact static banner used by the live terminal surface. */
function renderBannerLines(version, info = {}, cols = process.stdout.columns || 80) {
  const t = style.getTheme();
  const dim = chalk.hex(t.dim);
  const text = chalk.hex(t.text);
  const logo = paintLogo(renderLogo().split('\n'), 0).split('\n');
  const rows = logo;
  rows.push(`${chalk.hex(t.primary).bold('Raven CLI')} ${dim(`v${version}`)}${info.model ? dim(` · ${info.model}`) : ''}${info.backend ? dim(` · ${info.backend}`) : ''}`);
  rows.push(dim('─'.repeat(Math.max(20, Math.min(cols - 2, 72)))));
  return rows;
}

/**
 * Animated welcome banner: the gradient flows across the logo once, then a
 * compact info panel is printed. `info` = { model, backend, workspace, skills }.
 */
async function printBanner(version, info = {}, opts = {}) {
  const t = style.getTheme();
  const lines = renderLogo().split('\n');
  const animate = opts.animate !== false && process.stdout.isTTY && !process.env.RAVEN_NO_ANIM;
  const cols = process.stdout.columns || 80;

  console.log('');
  if (animate) {
    process.stdout.write('\x1b[?25l');
    const frames = 22;
    console.log(paintLogo(lines, 0));
    for (let f = 1; f <= frames; f++) {
      process.stdout.write(`\x1b[${lines.length}A`);
      // ease-out: fast at first, settles on the base gradient
      const k = 1 - (1 - f / frames) ** 3;
      console.log(paintLogo(lines, (1 - k) * 0.9));
      await sleep(28);
    }
    process.stdout.write('\x1b[?25h');
  } else {
    console.log(paintLogo(lines, 0));
  }

  const dim = chalk.hex(t.dim);
  const text = chalk.hex(t.text);
  console.log('');
  console.log(`  ${chalk.hex(t.primary).bold('Raven CLI')} ${dim(`v${version}`)}`);
  const rows = [];
  if (info.model) rows.push(['model', `${info.model}${info.backend ? dim(` \u00b7 ${info.backend}`) : ''}`]);
  if (info.workspace) rows.push(['workspace', info.workspace]);
  if (info.skills !== undefined) rows.push(['skills', String(info.skills)]);
  for (const [k, v] of rows) console.log(`  ${dim(k.padEnd(10))}${text(truncate(String(v), cols - 14))}`);
  console.log('');
  console.log(
    `  ${dim('tips')}      ${chalk.hex(t.accent)('/')} ${dim('commands')}  ${chalk.hex(t.accent)('esc')} ${dim('interrupt')}  ${chalk.hex(t.accent)('alt+enter')} ${dim('new line')}  ${dim('\u00b7 keep typing while Raven works')}`
  );
  console.log('');
  void strWidth;
}

module.exports = { LOGO, renderLogo, renderBannerLines, printBanner };
