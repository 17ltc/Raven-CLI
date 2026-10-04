'use strict';
/** Shell command execution with mandatory user confirmation. Port of Raven/command_executor.py */

const { spawn } = require('child_process');
const { askLine } = require('./prompt');
const chalk = require('chalk');

async function askConfirm(question) {
  const answer = await askLine(`${question} [y/N]:`);
  return ['y', 'yes', 'o', 'oui'].includes(answer.toLowerCase());
}

const HIGH_RISK = [
  'rm -rf', 'del /f', 'format', 'diskpart',
  'dd if=', 'mkfs', 'shutdown', 'reboot',
  '> /dev/', 'chmod 777', 'chown root',
  'iptables -f', 'iptables --flush',
];

const MEDIUM_RISK = [
  'rm ', 'del ', 'rmdir ', 'mv ', 'move ',
  'chmod ', 'chown ', 'useradd ', 'userdel ',
  'apt install', 'yum install', 'pip install',
  'npm install', 'reg delete', 'schtasks',
];

const LOW_RISK = [
  'ls ', 'dir ', 'cat ', 'type ', 'echo ',
  'pwd', 'cd ', 'grep ', 'find ', 'head ',
  'tail ', 'wc ', 'sort ', 'uniq ', 'ping ',
  'curl ', 'wget ', 'git status', 'git log',
  'git diff', 'ps ', 'top', 'df ', 'free ',
  'netstat', 'ifconfig', 'ipconfig', 'nslookup',
];

const EXPLANATIONS = {
  ls: 'List directory contents',
  dir: 'List directory contents (Windows)',
  cd: 'Change directory',
  pwd: 'Print working directory',
  cat: 'Display file contents',
  type: 'Display file contents (Windows)',
  grep: 'Search text patterns',
  find: 'Search for files',
  rm: 'Remove files or directories',
  del: 'Delete files (Windows)',
  cp: 'Copy files',
  copy: 'Copy files (Windows)',
  mv: 'Move/rename files',
  move: 'Move/rename files (Windows)',
  mkdir: 'Create directory',
  chmod: 'Change file permissions',
  chown: 'Change file owner',
  ps: 'List running processes',
  top: 'Display system processes',
  kill: 'Terminate processes',
  ping: 'Test network connectivity',
  curl: 'Transfer data from URLs',
  wget: 'Download files',
  git: 'Version control system',
  pip: 'Python package manager',
  npm: 'Node.js package manager',
  docker: 'Container management',
  ssh: 'Secure shell connection',
  tar: 'Archive files',
  zip: 'Compress files',
};

class CommandExecutor {
  /**
   * Execute a shell command with user confirmation.
   * @returns {Promise<{success:boolean, stdout:string, stderr:string, return_code:number}>}
   */
  async executeCommand(command, timeout = 30) {
    timeout = timeout || 30;
    if (!(await this._confirmCommand(command))) {
      return { success: false, stdout: '', stderr: 'Command cancelled by user', return_code: -1 };
    }

    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      // stdin is closed so interactive programs get EOF instead of hanging;
      // detached => own process group so a timeout kills the whole tree.
      const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin });
      const MAX_OUT = 1024 * 1024;
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;

      const kill = () => {
        try {
          if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
          else process.kill(-child.pid, 'SIGKILL');
        } catch (e) {
          try {
            child.kill('SIGKILL');
          } catch (e2) {
            /* already gone */
          }
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeout * 1000);

      const collect = (which) => (d) => {
        const chunk = d.toString();
        if (which === 'out') {
          if (stdout.length < MAX_OUT) stdout += chunk;
          else truncated = true;
        } else if (stderr.length < MAX_OUT) stderr += chunk;
      };
      child.stdout.on('data', collect('out'));
      child.stderr.on('data', collect('err'));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ success: false, stdout: '', stderr: e.message, return_code: -1 });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ success: false, stdout, stderr: `Command timed out after ${timeout} seconds\n${stderr}`.trim(), return_code: -1 });
        } else {
          if (truncated) stdout += '\n...[output truncated at 1 MB]';
          resolve({ success: code === 0, stdout, stderr, return_code: code === null ? -1 : code });
        }
      });
    });
  }

  async _confirmCommand(command) {
    console.log(`\n${chalk.bold.yellow('\u26a0 COMMAND EXECUTION REQUEST')}\n`);
    console.log(`${chalk.cyan('Command:')} ${command}`);

    const riskLevel = this._assessRisk(command);
    console.log(`${chalk.cyan('Risk Level:')} ${riskLevel}`);

    if (riskLevel === 'medium' || riskLevel === 'high') {
      console.log(chalk.red('\u26a0 WARNING: This command has potential risks!'));
    }
    console.log();

    return askConfirm(chalk.bold('Execute this command?'));
  }

  _assessRisk(command) {
    const lower = command.toLowerCase();
    if (HIGH_RISK.some((p) => lower.includes(p))) return 'high';
    if (MEDIUM_RISK.some((p) => lower.includes(p))) return 'medium';
    if (LOW_RISK.some((p) => lower.includes(p))) return 'low';
    return 'medium';
  }

  explainCommand(command) {
    const parts = command.trim().split(/\s+/);
    const first = parts[0] || '';
    return EXPLANATIONS[first] || 'Custom shell command';
  }
}

module.exports = { CommandExecutor };
