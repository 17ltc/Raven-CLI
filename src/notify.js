'use strict';
/**
 * Sound / desktop notifications.
 *
 *   done       a long task finished        (only if it took >= min_seconds)
 *   error      a long task failed          (same threshold)
 *   attention  Raven needs your approval   (always)
 *
 * Sounds use the OS player when one exists (afplay / paplay / PowerShell) and
 * fall back to the terminal bell. Desktop notifications: macOS (osascript)
 * and Linux (notify-send). Everything is best-effort and never throws.
 */

const fs = require('fs');
const { spawn } = require('child_process');

const DEFAULTS = { sound: true, desktop: false, min_seconds: 8 };

const MAC_SOUNDS = { done: 'Glass', attention: 'Ping', error: 'Basso' };
const LINUX_SOUNDS = {
  done: ['complete', 'message'],
  attention: ['message-new-instant', 'dialog-information', 'message'],
  error: ['dialog-warning', 'dialog-error', 'bell'],
};
const WIN_SOUNDS = { done: 'Asterisk', attention: 'Exclamation', error: 'Hand' };

/** Fire-and-forget process; resolves true if it started and exited 0. */
function defaultRunner(cmd, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      child.unref();
    } catch (e) {
      resolve(false);
    }
  });
}

function isWSL() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function applescriptString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

class Notifier {
  /**
   * @param {() => object} getSettings returns {sound, desktop, min_seconds}
   * @param {{platform?: string, runner?: Function, bell?: Function, exists?: Function}} [deps]
   */
  constructor(getSettings, deps = {}) {
    this.getSettings = getSettings;
    this.platform = deps.platform || process.platform;
    this.runner = deps.runner || defaultRunner;
    this.bell = deps.bell || (() => process.stdout.write('\x07'));
    this.exists = deps.exists || ((p) => fs.existsSync(p));
  }

  get settings() {
    return { ...DEFAULTS, ...(this.getSettings() || {}) };
  }

  /** Should a finished task of `seconds` notify? */
  shouldNotify(kind, seconds = 0) {
    if (kind === 'attention') return true;
    return seconds >= this.settings.min_seconds;
  }

  async notify(kind, { title = 'Raven', body = '', seconds = 0 } = {}) {
    const s = this.settings;
    if (!this.shouldNotify(kind, seconds)) return { played: false, reason: 'below threshold' };
    const result = { played: false, desktop: false };
    if (s.sound) result.played = await this._sound(kind);
    if (s.desktop) result.desktop = await this._desktop(title, body);
    return result;
  }

  async _sound(kind) {
    try {
      if (this.platform === 'darwin') {
        const file = `/System/Library/Sounds/${MAC_SOUNDS[kind] || 'Glass'}.aiff`;
        if (this.exists(file) && (await this.runner('afplay', [file]))) return true;
      } else if (this.platform === 'win32' || isWSL()) {
        const exe = this.platform === 'win32' ? 'powershell' : 'powershell.exe';
        const cmd = `[System.Media.SystemSounds]::${WIN_SOUNDS[kind] || 'Asterisk'}.Play(); Start-Sleep -Milliseconds 700`;
        if (await this.runner(exe, ['-NoProfile', '-NonInteractive', '-Command', cmd])) return true;
      } else {
        for (const name of LINUX_SOUNDS[kind] || LINUX_SOUNDS.done) {
          const file = `/usr/share/sounds/freedesktop/stereo/${name}.oga`;
          if (this.exists(file) && (await this.runner('paplay', [file]))) return true;
        }
        if (await this.runner('canberra-gtk-play', ['-i', (LINUX_SOUNDS[kind] || LINUX_SOUNDS.done)[0]])) return true;
      }
    } catch (e) {
      /* fall through to the bell */
    }
    try {
      this.bell();
      return true;
    } catch (e) {
      return false;
    }
  }

  async _desktop(title, body) {
    try {
      if (this.platform === 'darwin') {
        return await this.runner('osascript', ['-e', `display notification ${applescriptString(body)} with title ${applescriptString(title)}`]);
      }
      if (this.platform === 'linux') return await this.runner('notify-send', ['--app-name=Raven', title, body]);
    } catch (e) {
      /* best effort */
    }
    return false;
  }
}

module.exports = { Notifier, DEFAULTS };
