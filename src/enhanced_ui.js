'use strict';
/**
 * Enhanced UI Module for Raven CLI.
 * Port of Raven/enhanced_ui.py
 *
 * rich's Live/Spinner/Panel are approximated with plain ANSI writes; visual
 * fidelity is close but not pixel-identical to the Python `rich` renderer.
 */

const chalk = require('chalk');
const { PRIMARY_COLOR, TEXT_PRIMARY, TEXT_SECONDARY, TEXT_DIM, BORDER_COLOR } = require('./style');

const SPINNER_FRAMES = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];

function wrapLine(line, width) {
  if (!line) return [''];
  const words = line.split(' ');
  const out = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > width && current) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out.length ? out : [''];
}

/** Animated thinking indicator with timing. Use `await using` pattern via start()/stop(). */
class AnimatedThinking {
  constructor(message = 'Thinking') {
    this.message = message;
    this.startTime = Date.now();
    this._timer = null;
    this._frame = 0;
  }

  start() {
    process.stdout.write('\x1b[?25l');
    this._timer = setInterval(() => {
      process.stdout.write(
        `\r${chalk.hex(PRIMARY_COLOR)(SPINNER_FRAMES[this._frame % SPINNER_FRAMES.length])} ${chalk.hex(PRIMARY_COLOR)(this.message)}`
      );
      this._frame += 1;
    }, 125);
    return this;
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      process.stdout.write(`\r${' '.repeat(this.message.length + 2)}\r`);
      process.stdout.write('\x1b[?25h');
      const elapsed = (Date.now() - this.startTime) / 1000;
      if (elapsed > 0.1) {
        console.log(chalk.hex(TEXT_DIM)(`thinking ${elapsed.toFixed(1)}s`));
      }
    }
  }
}

class AnimatedToolCall {
  constructor(toolName, args) {
    this.toolName = toolName;
    this.args = args;
  }

  display() {
    console.log(`${chalk.hex(TEXT_SECONDARY)('Calling:')} ${chalk.hex(TEXT_PRIMARY)(this.toolName)}`);
    if (this.args && Object.keys(this.args).length) {
      const argsStr = JSON.stringify(this.args, null, 2);
      const lines = argsStr.split('\n');
      for (const line of lines.slice(0, 3)) console.log(`  ${chalk.hex(TEXT_DIM)(line)}`);
      if (lines.length > 3) console.log(`  ${chalk.hex(TEXT_DIM)('...')}`);
    }
  }
}

class AnimatedResponse {
  constructor(response) {
    this.response = response;
  }

  async display(animate = true) {
    if (animate && this.response.length < 500) {
      await this._typewriterEffect();
    } else {
      console.log(chalk.hex(TEXT_SECONDARY)(this.response));
    }
  }

  async _typewriterEffect() {
    const width = process.stdout.columns || 80;
    const lines = this.response.split('\n').flatMap((l) => wrapLine(l, width));
    for (const line of lines) {
      for (const char of line) {
        process.stdout.write(chalk.hex(TEXT_SECONDARY)(char));
        await new Promise((r) => setTimeout(r, 5));
      }
      console.log();
    }
  }
}

class ProgressIndicator {
  constructor(description = 'Processing') {
    this.description = description;
    this._timer = null;
    this._frame = 0;
  }

  start() {
    process.stdout.write('\x1b[?25l');
    this._timer = setInterval(() => {
      process.stdout.write(`\r${chalk.hex(PRIMARY_COLOR)(SPINNER_FRAMES[this._frame % SPINNER_FRAMES.length])} ${this.description}`);
      this._frame += 1;
    }, 125);
  }

  update(description = null) {
    if (description) this.description = description;
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      process.stdout.write(`\r${' '.repeat(this.description.length + 2)}\r`);
      process.stdout.write('\x1b[?25h');
    }
  }
}

const StatusMessage = {
  success(message) {
    console.log(`${chalk.hex(PRIMARY_COLOR)('\u2713')} ${chalk.hex(TEXT_SECONDARY)(message)}`);
  },
  error(message) {
    console.log(`${chalk.hex(PRIMARY_COLOR)('\u2717')} ${chalk.hex(TEXT_SECONDARY)(message)}`);
  },
  info(message) {
    console.log(`${chalk.hex(PRIMARY_COLOR)('\u2139')} ${chalk.hex(TEXT_SECONDARY)(message)}`);
  },
  warning(message) {
    console.log(`${chalk.hex(PRIMARY_COLOR)('!')} ${chalk.hex(TEXT_SECONDARY)(message)}`);
  },
};

class InputIndicator {
  show(prompt = 'You:') {
    console.log(chalk.hex(TEXT_DIM)('\u2500'.repeat(43)));
    process.stdout.write(chalk.hex(PRIMARY_COLOR)(prompt));
  }

  hide() {
    /* no-op, mirrors Python's pass */
  }
}

class ThinkingBlock {
  constructor(content, thinkingTime = 0.0) {
    this.content = content;
    this.thinkingTime = thinkingTime;
  }

  display() {
    if (this.thinkingTime > 0) {
      console.log(`Thinking time: ${this.thinkingTime.toFixed(1)}s`);
    }
    const width = Math.max((process.stdout.columns || 100) - 4, 20);
    const wrapped = [];
    for (const line of this.content.trim().split('\n')) {
      wrapped.push(...wrapLine(line, width));
    }
    if (wrapped.length) {
      const inner = wrapped.map((l) => ` ${l}`).join('\n');
      const boxWidth = Math.max(...wrapped.map((l) => l.length), 'Thinking'.length) + 2;
      const top = `\u256d\u2500 Thinking ${'\u2500'.repeat(Math.max(boxWidth - 10, 0))}\u256e`;
      const bottom = `\u2570${'\u2500'.repeat(boxWidth)}\u256f`;
      console.log(chalk.hex(BORDER_COLOR)(top));
      for (const line of wrapped) console.log(`${chalk.hex(BORDER_COLOR)('\u2502')} ${line}`);
      console.log(chalk.hex(BORDER_COLOR)(bottom));
      void inner;
    }
  }
}

module.exports = {
  AnimatedThinking,
  AnimatedToolCall,
  AnimatedResponse,
  ProgressIndicator,
  StatusMessage,
  InputIndicator,
  ThinkingBlock,
};
