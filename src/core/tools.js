'use strict';
/**
 * Core Tools Module
 *
 * Tool registry and execution system - reusable across all interfaces.
 * Port of Raven/core/tools.py
 */

class ToolRegistry {
  constructor() {
    /** @type {Map<string, {name:string, description:string, fn:Function, schema:?object}>} */
    this.tools = new Map();
    this.mode = 'normal';
  }

  register(name, description, fn, schema = null) {
    this.tools.set(name, { name, description, fn, schema });
  }

  unregister(name) {
    this.tools.delete(name);
  }

  get(name) {
    return this.tools.get(name) || null;
  }

  list() {
    return Array.from(this.tools.values());
  }

  async execute(name, args = {}) {
    const tool = this.get(name);
    if (!tool) {
      return { error: `Tool '${name}' not found` };
    }
    if (this.mode === 'plan' && /^(write_file|create_file|edit_file|delete_file|create_directory|rename_file|copy_file|safe_edit|multi_file_edit|execute_command|install_dependencies|build_project|run_tests|run_linter|server_start|server_stop|server_stop_all|conversation_export|project_git|undo_file|reminder_create|reminder_cancel|target_create|target_add_identifier|target_add_note|target_save_research)$/.test(name)) {
      return { error: `Plan mode is read-only: '${name}' was blocked.` };
    }
    try {
      const result = await tool.fn(args || {});
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        return result;
      }
      return { result };
    } catch (e) {
      return { error: e && e.message ? e.message : String(e) };
    }
  }

  getSchema() {
    const schema = {};
    for (const [name, tool] of this.tools.entries()) {
      schema[name] = { description: tool.description, parameters: tool.schema || {} };
    }
    return schema;
  }
}

/**
 * Register built-in tools onto a registry from the full tool builder.
 * @param {ToolRegistry} registry
 * @param {object} config CoreConfig instance or plain object
 */
function registerBuiltInTools(registry, config) {
  // Lazy require to avoid circular deps, mirrors Python's local import.
  const { buildRegistry } = require('../tools');
  const configDict = typeof config.toDict === 'function' ? config.toDict() : config;
  const toolDict = buildRegistry(configDict);

  for (const [name, toolInfo] of Object.entries(toolDict)) {
    registry.register(name, toolInfo.description, toolInfo.fn, toolInfo.schema || null);
  }
  return registry;
}

module.exports = { ToolRegistry, registerBuiltInTools };
