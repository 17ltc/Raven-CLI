'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LineEditor } = require('../src/tui/editor');
const { renderMarkdown } = require('../src/tui/markdown');
const { truncate, strWidth, stripAnsi } = require('../src/tui/ansi');
const { TerminalUI } = require('../src/tui/ui');

test('editor: word delete, history, vertical moves', () => {
  const e = new LineEditor();
  e.insert('hello world');
  e.deleteWordBack();
  assert.strictEqual(e.text, 'hello ');
  e.pushHistory('one');
  e.pushHistory('two');
  e.clear();
  e.historyPrev();
  assert.strictEqual(e.text, 'two');
  e.set('abcdefghij');
  e.cursor = 2;
  assert.ok(e.moveVertical(1, 4));
  assert.strictEqual(e.cursor, 6);
});

test('editor: wide chars and large paste', () => {
  const e = new LineEditor();
  e.insert('日本語');
  assert.strictEqual(e.cursorPosition(10).col, 6);
  e.insert('x'.repeat(200000));
  assert.strictEqual(e.chars.length, 200003);
});

test('editor: undo and redo prompt edits', () => {
  const e = new LineEditor();
  e.insert('hello');
  e.insert(' world');
  assert.strictEqual(e.text, 'hello world');
  assert.ok(e.undo());
  assert.strictEqual(e.text, 'hello');
  assert.ok(e.redo());
  assert.strictEqual(e.text, 'hello world');
});

test('editor: paste batch is undone as one edit', () => {
  const e = new LineEditor();
  e.insert('a');
  e.beginUndoBatch();
  for (const ch of 'bcdef') e.insert(ch);
  e.endUndoBatch();
  assert.strictEqual(e.text, 'abcdef');
  assert.ok(e.undo());
  assert.strictEqual(e.text, 'a');
});

test('ansi: truncate keeps width', () => {
  assert.strictEqual(strWidth(truncate('abcdefghij', 5)), 5);
  assert.strictEqual(stripAnsi(truncate('日本語日本語', 7)), '日本語…');
});

test('markdown: renders blocks within width', () => {
  const lines = renderMarkdown('# T\n\n- a **b**\n\n```js\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |', { width: 40 });
  assert.ok(lines.length > 8);
  for (const l of lines) assert.ok(strWidth(l) <= 40, `line too wide: ${stripAnsi(l)}`);
});

test('banner logo: every row has the same width (no letter shifts)', () => {
  const { renderLogo } = require('../src/banner');
  const widths = renderLogo().split('\n').map((l) => strWidth(l));
  assert.strictEqual(new Set(widths).size, 1, `row widths differ: ${widths.join(', ')}`);
});

test('terminal resize replays transcript without resetting thinking', () => {
  const frames = [];
  const out = { columns: 80, write: (value) => frames.push(String(value)) };
  const ui = new TerminalUI({ stdout: out, headerLines: ['RAVEN'] });
  ui.started = true;
  ui._draw();
  ui.print('previous answer');
  ui.setBusy(true, { verb: 'Thinking', tokens: 12 });

  out.columns = 120;
  ui._draw();

  const rebuilt = stripAnsi(frames[frames.length - 1]);
  assert.match(rebuilt, /RAVEN/);
  assert.match(rebuilt, /previous answer/);
  assert.strictEqual(ui.busy, true);
  assert.strictEqual(ui.activity.tokens, 12);
  assert.strictEqual(ui._headerNeedsDraw, false);
  ui.setBusy(false);
});
