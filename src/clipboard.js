'use strict';

const { spawnSync } = require('child_process');
const INLINE_PASTE_LIMIT = 240;

function textPaste(text) {
  return {
    kind: 'text',
    label: 'text pasted',
    text,
    inline: text.length <= INLINE_PASTE_LIMIT,
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 1500, windowsHide: true });
  if (result.error || result.status !== 0) return '';
  return String(result.stdout || '').replace(/\r\n/g, '\n');
}

function readWindowsClipboard() {
  const image = run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-STA', '-Command',
    "Add-Type -AssemblyName PresentationCore; if ([System.Windows.Clipboard]::ContainsImage()) { 'image' }",
  ]).trim();
  if (image === 'image') return { kind: 'image', label: 'image pasted' };

  const text = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw -ErrorAction SilentlyContinue']);
  return text ? textPaste(text) : null;
}

function readClipboard() {
  if (process.platform === 'win32') return readWindowsClipboard();
  if (process.platform === 'darwin') {
    const text = run('pbpaste', []);
    return text ? textPaste(text) : null;
  }

  const text = run('wl-paste', ['--no-newline']) || run('xclip', ['-selection', 'clipboard', '-o']);
  return text ? textPaste(text) : null;
}

module.exports = { readClipboard, INLINE_PASTE_LIMIT };
