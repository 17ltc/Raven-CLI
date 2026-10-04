'use strict';
/**
 * Core Commands Module
 * Port of Raven/core/commands.py
 */

class CommandSystem {
  constructor() {
    this.commands = new Map();
    this.aliases = new Map();
  }

  register(name, description, handler, argsHelp = '', examples = [], aliases = []) {
    this.commands.set(name, {
      name,
      description,
      handler,
      argsHelp,
      examples: examples || [],
    });
    for (const alias of aliases || []) {
      this.aliases.set(alias, name);
    }
  }

  unregister(name) {
    this.commands.delete(name);
    for (const [alias, target] of Array.from(this.aliases.entries())) {
      if (target === name) this.aliases.delete(alias);
    }
  }

  get(name) {
    if (this.commands.has(name)) return this.commands.get(name);
    if (this.aliases.has(name)) return this.commands.get(this.aliases.get(name));
    return null;
  }

  async execute(name, args = '', context = {}) {
    const command = this.get(name);
    if (!command) return `Unknown command: ${name}`;
    try {
      return await command.handler(args, context || {});
    } catch (e) {
      return `Error executing command: ${e && e.message ? e.message : e}`;
    }
  }

  list() {
    return Array.from(this.commands.values());
  }

  getHelp(name = null) {
    if (name) {
      const command = this.get(name);
      if (!command) return `Unknown command: ${name}`;
      let helpText = `Command: /${command.name}\n`;
      helpText += `Description: ${command.description}\n`;
      if (command.argsHelp) helpText += `Usage: /${command.name} ${command.argsHelp}\n`;
      if (command.examples && command.examples.length) {
        helpText += 'Examples:\n';
        for (const example of command.examples) helpText += `  ${example}\n`;
      }
      return helpText;
    }
    let helpText = 'Available commands:\n';
    for (const command of this.list()) {
      helpText += `  /${command.name} - ${command.description}\n`;
    }
    helpText += '\nUse /help <command> for detailed help.';
    return helpText;
  }
}

module.exports = { CommandSystem };
