'use strict';
/**
 * File tools available to the agent, sandboxed to a configured workspace
 * directory.
 * Port of Raven/file_tools.py
 *
 * SECURITY: write_file is unrestricted (within the workspace). delete_file is
 * NOT - it always stops and asks the human operator for interactive
 * confirmation in the terminal before doing anything, regardless of what the
 * model says, how it phrases the request, or which model/backend is running.
 * This is enforced here in JS, not in the prompt, specifically because a
 * weak or free-tier model cannot be trusted to reliably honor a
 * prompt-only instruction. There is no argument or config flag that skips
 * this - that's intentional.
 */

const fs = require('fs');
const path = require('path');
const { askLine } = require('./prompt');
const { capture } = require('./file_history');
const chalk = require('chalk');

function timestampMicros() {
  const d = new Date();
  const p = (n, len = 2) => String(n).padStart(len, '0');
  // JS Date has millisecond precision only; pad to mimic the Python %f width.
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(
    d.getSeconds()
  )}${String(d.getMilliseconds()).padStart(3, '0')}000`;
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

class FileTools {
  constructor(workspaceRoot, unrestricted = false) {
    // Generous for reports/notes/exports, small enough that a model stuck in
    // a bad loop can't quietly fill the disk.
    this.MAX_WRITE_BYTES = 10 * 1024 * 1024;
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.unrestricted = unrestricted;
    this.undoRoot = path.join(this.workspaceRoot, '.raven_undo');
    // Do not create the workspace just by starting Raven. Directories are
    // created lazily by the operation that actually writes into them.
  }

  _resolve(pathStr) {
    let candidate;
    if (this.unrestricted) {
      candidate = path.resolve(pathStr);
    } else {
      candidate = path.resolve(this.workspaceRoot, pathStr);
      if (candidate !== this.workspaceRoot && !candidate.startsWith(this.workspaceRoot + path.sep)) {
        const err = new Error(`Refused: '${pathStr}' resolves outside the workspace (${this.workspaceRoot}).`);
        err.name = 'PermissionError';
        throw err;
      }
    }
    return candidate;
  }

  writeFile(filePath, content, mode = 'overwrite') {
    try {
      const size = Buffer.byteLength(content, 'utf8');
      if (size > this.MAX_WRITE_BYTES) {
        return {
          error:
            `Refused: content is ${size} bytes, over the ${this.MAX_WRITE_BYTES} byte limit ` +
            "for a single write_file call. Split it into smaller writes (e.g. mode='append').",
        };
      }
      const p = this._resolve(filePath);
      capture(p); // /undo + diff support
      fs.mkdirSync(path.dirname(p), { recursive: true });

      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const backup = path.join(this.undoRoot, `${path.basename(p)}.${timestampMicros()}.bak`);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(p, backup);
        fs.writeFileSync(`${backup}.path`, path.relative(this.workspaceRoot, p), 'utf8');
      }

      if (mode === 'append' && fs.existsSync(p)) {
        const existingSize = fs.statSync(p).size;
        if (existingSize + size > this.MAX_WRITE_BYTES) {
          return {
            error:
              `Refused: appending would bring '${filePath}' to ${existingSize + size} bytes, ` +
              `over the ${this.MAX_WRITE_BYTES} byte limit.`,
          };
        }
        fs.appendFileSync(p, content, 'utf8');
      } else {
        fs.writeFileSync(p, content, 'utf8');
      }
      return { status: 'written', path: p, bytes: Buffer.byteLength(content, 'utf8') };
    } catch (e) {
      return { error: e.message };
    }
  }

  undoFile(filePath) {
    try {
      const target = this._resolve(filePath);
      const backups = [];
      if (fs.existsSync(this.undoRoot)) {
        for (const name of fs.readdirSync(this.undoRoot)) {
          if (!name.startsWith(`${path.basename(target)}.`) || !name.endsWith('.bak')) continue;
          const backup = path.join(this.undoRoot, name);
          const marker = `${backup}.path`;
          if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === path.relative(this.workspaceRoot, target)) {
            backups.push(backup);
          }
        }
      }
      if (!backups.length) return { error: `No undo version found for ${filePath}` };
      backups.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      const backup = backups[0];
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(backup, target);
      return { status: 'restored', path: target, from: backup };
    } catch (e) {
      return { error: e.message };
    }
  }

  listWorkspace() {
    const files = walkFiles(this.workspaceRoot).map((p) => path.relative(this.workspaceRoot, p));
    return { workspace: this.workspaceRoot, files };
  }

  async deleteFile(filePath) {
    let p;
    try {
      p = this._resolve(filePath);
    } catch (e) {
      return { error: e.message };
    }

    if (!fs.existsSync(p)) return { error: `File does not exist: ${p}` };

    console.log(`\n${chalk.bold.red('SECURITY GATE')} \u2014 the agent is asking to DELETE this file:`);
    console.log(`  ${chalk.bold(p)}`);
    const answer = (await promptLine(chalk.bold.yellow('Autoriser la suppression ? [y/N]:'))).trim().toLowerCase();
    if (!['y', 'yes', 'o', 'oui'].includes(answer)) {
      return { status: 'denied', message: "L'utilisateur n'a pas autorisé cette suppression." };
    }

    try {
      capture(p);
      fs.unlinkSync(p);
    } catch (e) {
      return { error: `Deletion failed: ${e.message}` };
    }
    return { status: 'deleted', path: p };
  }
}

function promptLine(question) {
  return askLine(question);
}

module.exports = { FileTools };
