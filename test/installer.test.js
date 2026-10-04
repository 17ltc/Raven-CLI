'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const I = require('../src/installer');

function sandbox(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-inst-'));
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-app-'));
  return { platform: 'linux', home, installDir, env: { PATH: '/usr/bin:/bin', SHELL: '/bin/bash' }, nodePath: '/usr/bin/node', ...extra };
}

test('install: launcher + one marked PATH block, idempotent', () => {
  const c = sandbox();
  fs.writeFileSync(path.join(c.home, '.bashrc'), '# my bashrc\nalias x=y');
  const r = I.install(c);
  assert.ok(r.changes.length >= 2 && r.needsNewTerminal);
  const launcher = path.join(c.home, '.local', 'bin', 'raven');
  // Windows does not expose POSIX executable mode bits on NTFS.
  if (process.platform !== 'win32') assert.ok(fs.statSync(launcher).mode & 0o111, 'launcher must be executable');
  assert.ok(fs.readFileSync(launcher, 'utf8').includes(path.join(c.installDir, 'bin', 'raven.js')));
  const rc = fs.readFileSync(path.join(c.home, '.bashrc'), 'utf8');
  assert.ok(rc.startsWith('# my bashrc\nalias x=y'));
  assert.strictEqual(rc.split(I.MARK_START).length - 1, 1);

  const again = I.install(c);
  assert.deepStrictEqual(again.changes, []);
  assert.strictEqual(fs.readFileSync(path.join(c.home, '.bashrc'), 'utf8'), rc);
});

test('install: nothing to edit when the folder is already on PATH', () => {
  const c = sandbox();
  c.env.PATH = `${path.join(c.home, '.local', 'bin')}:/usr/bin`;
  const r = I.install(c);
  assert.strictEqual(r.needsNewTerminal, false);
  assert.ok(!fs.existsSync(path.join(c.home, '.bashrc')));
});

test('install: zsh and fish profiles', () => {
  const z = sandbox({ env: { PATH: '/usr/bin', SHELL: '/bin/zsh' } });
  I.install(z);
  assert.ok(fs.readFileSync(path.join(z.home, '.zshrc'), 'utf8').includes('.local/bin'));
  const f = sandbox({ env: { PATH: '/usr/bin', SHELL: '/usr/bin/fish' } });
  I.install(f);
  assert.match(fs.readFileSync(path.join(f.home, '.config', 'fish', 'config.fish'), 'utf8'), /fish_add_path/);
});

test('autoHeal repairs a stale launcher and a missing PATH line, then stays quiet', () => {
  const c = sandbox();
  I.install(c);
  assert.strictEqual(I.autoHeal(c).skipped, 'healthy');

  // the project folder moved -> launcher is stale
  const moved = { ...c, installDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rv-moved-')) };
  assert.strictEqual(I.check(moved).launcher, 'stale');
  const healed = I.autoHeal(moved);
  assert.strictEqual(healed.repaired, true);
  assert.strictEqual(I.check(moved).launcher, 'ok');
  assert.strictEqual(I.autoHeal(moved).skipped, 'healthy');

  // profile got wiped
  for (const f of fs.readdirSync(c.home).filter((n) => n.startsWith('.') && n.endsWith('rc'))) fs.writeFileSync(path.join(c.home, f), '');
  fs.unlinkSync(path.join(c.home, '.raven', 'setup.json'));
  assert.strictEqual(I.check(moved).persisted, 'no');
  assert.strictEqual(I.autoHeal(moved).repaired, true);
  assert.notStrictEqual(I.check(moved).persisted, 'no');
});

test('autoHeal respects opt-outs: CI, env flag, npm-managed, uninstalled', () => {
  const c = sandbox();
  assert.ok(I.autoHeal({ ...c, env: { ...c.env, CI: '1' } }).skipped);
  assert.ok(I.autoHeal({ ...c, env: { ...c.env, RAVEN_NO_AUTOINSTALL: '1' } }).skipped);
  assert.match(I.autoHeal({ ...c, installDir: path.join(c.installDir, 'node_modules', 'raven') }).skipped, /npm/);
  I.install(c);
  const u = I.uninstall(c);
  assert.ok(u.removed.length >= 2);
  assert.ok(!fs.existsSync(path.join(c.home, '.local', 'bin', 'raven')));
  assert.ok(!fs.readFileSync(path.join(c.home, '.bashrc'), 'utf8').includes(I.MARK_START));
  assert.strictEqual(I.autoHeal(c).skipped, 'uninstalled by user'); // does not come back on its own
  I.install(c); // explicit setup re-enables
  assert.strictEqual(I.autoHeal(c).skipped, 'healthy');
});

test('windows: .cmd launcher and PowerShell PATH script', () => {
  const c = sandbox({ platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe', skipWindowsRegistry: true });
  const r = I.install(c);
  const file = path.join(c.home, '.raven', 'bin', 'raven.cmd');
  assert.ok(fs.existsSync(file) && r.launcherFile === file);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /\r\n/);
  assert.ok(text.includes('C:\\Program Files\\nodejs\\node.exe') && text.includes('%*'));
  assert.match(I.windowsPathScript(true), /SetEnvironmentVariable\('Path', .*'User'\)/);
  assert.match(I.windowsPathScript(false), /removed/);
});
