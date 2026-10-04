'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MEMORY = `# Raven project memory\n\n## Project instructions\n\nDescribe the project's purpose, conventions, and constraints here. Raven loads this file automatically for every conversation.\n\n## Useful commands\n\n- Test: \`...\`\n- Build: \`...\`\n`;

function findProjectRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, 'RAVEN.md')) || fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function safeName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

class ProjectContext {
  constructor(root = findProjectRoot()) {
    this.root = path.resolve(root);
    this.memoryFile = path.join(this.root, 'RAVEN.md');
    this.commandsDir = path.join(this.root, '.raven', 'commands');
  }

  memory() {
    try {
      const text = fs.readFileSync(this.memoryFile, 'utf8').trim();
      return text ? text.slice(0, 24000) : '';
    } catch (e) {
      return '';
    }
  }

  init() {
    if (fs.existsSync(this.memoryFile)) return { created: false, path: this.memoryFile };
    fs.writeFileSync(this.memoryFile, DEFAULT_MEMORY, 'utf8');
    fs.mkdirSync(this.commandsDir, { recursive: true });
    return { created: true, path: this.memoryFile };
  }

  customCommands() {
    if (!fs.existsSync(this.commandsDir)) return [];
    return fs.readdirSync(this.commandsDir)
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .map((file) => {
        const full = path.join(this.commandsDir, file);
        const raw = fs.readFileSync(full, 'utf8');
        const fm = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(raw);
        const fields = {};
        if (fm) for (const line of fm[1].split('\n')) {
          const i = line.indexOf(':');
          if (i !== -1) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
        const body = (fm ? raw.slice(fm[0].length) : raw).trim();
        const name = safeName(fields.name || path.basename(file, '.md'));
        return { name, description: fields.description || `Run project command ${name}`, body, path: full };
      })
      .filter((command) => command.name && command.body);
  }

  renderCommand(command, args = '') {
    return command.body
      .replace(/\{args\}/g, args)
      .replace(/\$ARGUMENTS/g, args)
      .replace(/\{project_root\}/g, this.root);
  }
}

module.exports = { ProjectContext, findProjectRoot, DEFAULT_MEMORY };
