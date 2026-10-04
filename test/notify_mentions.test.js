'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Notifier } = require('../src/notify');
const M = require('../src/mentions');

function notifier(platform, settings, calls, { ok = true, exists = true } = {}) {
  return new Notifier(() => settings, {
    platform,
    runner: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return ok;
    },
    bell: () => calls.push(['BELL']),
    exists: () => exists,
  });
}

test('notify: threshold applies to done/error but never to attention', async () => {
  const calls = [];
  const n = notifier('darwin', { sound: true, desktop: false, min_seconds: 8 }, calls);
  assert.strictEqual((await n.notify('done', { seconds: 3 })).played, false);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual((await n.notify('done', { seconds: 12 })).played, true);
  assert.strictEqual(calls[0][0], 'afplay');
  await n.notify('attention', { seconds: 0 });
  assert.match(calls[calls.length - 1][1], /Ping/);
});

test('notify: picks the right player per platform and falls back to the bell', async () => {
  let calls = [];
  await notifier('linux', { sound: true, desktop: true }, calls).notify('attention', { title: 'T', body: 'B' });
  assert.ok(calls.some((c) => c[0] === 'paplay') && calls.some((c) => c[0] === 'notify-send'));

  calls = [];
  await notifier('win32', { sound: true }, calls).notify('error', { seconds: 99 });
  assert.strictEqual(calls[0][0], 'powershell');
  assert.match(calls[0][calls[0].length - 1], /Hand/);

  calls = [];
  await notifier('linux', { sound: true }, calls, { ok: false }).notify('done', { seconds: 99 });
  assert.deepStrictEqual(calls[calls.length - 1], ['BELL']);

  calls = [];
  await notifier('linux', { sound: false, desktop: false }, calls).notify('attention');
  assert.strictEqual(calls.length, 0);
});

test('notify: osascript strings are escaped', async () => {
  const calls = [];
  await notifier('darwin', { sound: false, desktop: true }, calls).notify('attention', { title: 'a"b', body: 'x\\y' });
  assert.ok(calls[0][2].includes('a\\"b') && calls[0][2].includes('x\\\\y'));
});

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-men-'));
  fs.mkdirSync(path.join(dir, 'src', 'utils'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'line1\nline2\n');
  fs.writeFileSync(path.join(dir, 'src', 'utils', 'helper.js'), 'h');
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'skip.js'), 'no');
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(dir, 'README.md'), '# hi');
  return dir;
}

test('mentions: listing ignores node_modules, filter ranks basename first', () => {
  const dir = project();
  M.invalidate();
  const files = M.listProjectFiles(dir);
  assert.ok(files.includes('src/app.js') && files.includes('src/'));
  assert.ok(!files.some((f) => f.includes('node_modules')));
  assert.strictEqual(M.filterFiles(files, 'helper')[0], 'src/utils/helper.js');
  assert.strictEqual(M.filterFiles(files, 'app')[0], 'src/app.js');
  assert.ok(M.filterFiles(files, 'sjs').includes('src/app.js')); // fuzzy
});

test('mentions: detect token at cursor and highlight ranges', () => {
  const chars = Array.from('look at @src/ap and @x');
  assert.deepStrictEqual(M.findMentionAt(chars, 15), { start: 8, end: 15, query: 'src/ap' });
  assert.strictEqual(M.findMentionAt(chars, 4), null);
  assert.strictEqual(M.findMentionAt(Array.from('mail@a.com'), 10), null); // not a mention
  assert.deepStrictEqual(M.mentionRanges(chars), [[8, 15], [20, 22]]);
});

test('mentions: resolves files, dirs; blocks escapes and binaries', () => {
  const dir = project();
  const { attachments, problems } = M.resolveMentions('see @src/app.js, @src @../../etc/passwd @bin.dat @nope.txt', [dir]);
  assert.deepStrictEqual(attachments.map((a) => [a.mention, a.kind]), [['src/app.js', 'file'], ['src', 'dir']]);
  assert.strictEqual(attachments[0].content, 'line1\nline2\n');
  assert.ok(problems.some((p) => /outside the project/.test(p)));
  assert.ok(problems.some((p) => /binary/.test(p)));
  assert.ok(problems.some((p) => /not found/.test(p)));
  assert.match(M.buildAttachmentBlock(attachments), /<file path="src\/app.js">/);
});

test('mentions: truncates big files', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(100000));
  const { attachments } = M.resolveMentions('@big.txt', [dir], { maxFileBytes: 1000 });
  assert.strictEqual(attachments[0].content.length, 1000);
  assert.ok(attachments[0].truncated);
});
