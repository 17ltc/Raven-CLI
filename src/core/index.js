'use strict';
/**
 * Raven Core - Central Kernel Module
 * Port of Raven/core/__init__.py
 */

const { Agent } = require('./agent');
const { ConfigManager, CoreConfig } = require('./config');
const { ToolRegistry, registerBuiltInTools } = require('./tools');
const { SessionManager } = require('./sessions');
const { TargetManager } = require('./targets');
const { TaskQueue } = require('./tasks');
const { CommandSystem } = require('./commands');

module.exports = {
  Agent,
  ConfigManager,
  CoreConfig,
  ToolRegistry,
  registerBuiltInTools,
  SessionManager,
  TargetManager,
  TaskQueue,
  CommandSystem,
};
