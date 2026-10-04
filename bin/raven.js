#!/usr/bin/env node
'use strict';
/**
 * Raven CLI - Main Entry Point
 * Port of Raven/cli.py
 *
 * Unified CLI using Raven Core with all features:
 * - Direct command: `raven` (no `raven chat` needed)
 * - Integrated configuration (no env vars needed)
 * - Skills management
 * - /restart command
 * - Unlimited task queue
 *
 * The interactive UI (live input box that stays active while the model works,
 * "/" command menu, animations, message queue) lives in src/tui/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const chalk = require('chalk');
const { Command } = require('commander');

const {
  Agent,
  ConfigManager,
  ToolRegistry,
  registerBuiltInTools,
  SessionManager,
  TargetManager,
  TaskQueue,
  CommandSystem,
} = require('../src/core');
const { ChatBackend, BackendConfig, PRESETS, MultiBackendRouter } = require('../src/backend');
const { DemoBackend } = require('../src/demo_backend');
const { ProjectTools } = require('../src/project_tools');
const { printBanner, renderBannerLines } = require('../src/banner');
const { THEMES, getTheme, setTheme, separator, wrapLine, renderRichMarkup } = require('../src/style');
const { TerminalUI, PlainUI, fmtElapsed } = require('../src/tui/ui');
const { renderMarkdown } = require('../src/tui/markdown');
const { renderChange } = require('../src/tui/diff');
const { fileHistory } = require('../src/file_history');
const { truncate, padEnd, hardWrap } = require('../src/tui/ansi');
const { setActiveUI, setAskHook, askLine } = require('../src/prompt');
const { Notifier } = require('../src/notify');
const mentions = require('../src/mentions');
const installer = require('../src/installer');
const { loadSkills } = require('../src/skill_loader');
const { buildLitePrompt, skillsForMessage, registerToolHelp } = require('../src/prompt_lite');
const { listSkills, findSkill, validateSkill, createSkill, deleteSkill, duplicateSkill } = require('../src/skills_manager');
const { registerBuiltinCommands } = require('../src/commands/builtin_commands');
const { AutomationStore } = require('../src/automation');
const { SetupWizard } = require('../src/setup_wizard');
const { ProjectContext } = require('../src/project_context');
const { readClipboard } = require('../src/clipboard');

const VERSION = '1.2.1';
const PACKAGE_ROOT = path.join(__dirname, '..');
const DEFAULT_SKILLS_ROOT = path.join(PACKAGE_ROOT, 'skills');
const DEFAULT_SKILLS = [
  'cmd',
  'raven-code',
  'osint-suite',
  'context-engineering',
  'discord-suite',
  'telegram-suite',
  'project-questions',
  'skill-finder',
];

function canonicalSkillName(name) {
  return name === 'osint-threat-intel' ? 'osint-suite' : name;
}

class RavenCLI {
  constructor(skillsRoot = DEFAULT_SKILLS_ROOT, skillNames = [], skillDirs = []) {
    this.configManager = new ConfigManager();
    this.config = this.configManager.get();

    this.skillsRoot = skillsRoot;
    this.skillNames = [...new Set(skillNames.map(canonicalSkillName))];
    this.skillDirs = skillDirs;
    this.maxIterations = Math.max(32, this.config.max_iterations);
    this.temperature = this.config.backend.temperature;
    this.showThinking = true; // always collect reasoning; how much is shown is `thinkingMode`
    this.thinkingMode = this.config.show_thinking === false ? 'off' : 'on';
    this.loadedSkillNames = new Set([...DEFAULT_SKILLS, ...skillNames]);
    this.ui = null;
    this.queue = [];
    this.abortController = null;
    this._draining = false;
    this._exitPending = false;
    this._restarting = false;
    this._resolveExit = null;
    this._skillCache = null;
    this.demo = false;
    this.notifier = new Notifier(() => this.config.notifications);
    this._notifyOn = false;
    this.startupCommands = [];

    this.toolRegistry = new ToolRegistry();
    this.sessionManager = new SessionManager();
    const workspaceRoot = path.resolve(this.config.workspace.path || '.');
    this.targetManager = new TargetManager(path.join(workspaceRoot, 'targets'));
    this.taskQueue = new TaskQueue(this.config.tasks.max_concurrent);
    this.commandSystem = new CommandSystem();
    this.projectTools = new ProjectTools(this.config.workspace.path);
    this.projectContext = new ProjectContext(workspaceRoot);
    this.interactionMode = this.config.interaction_mode || 'normal';

    this._registerCommands();
    this._initializeTools();

    this.backend = null;
    this.agent = null;
    this.systemPrompt = '';
    this._running = false;
    this._loadedSkillPaths = [];
  }

  _resolveSkills() {
    const resolved = [];
    const requestedNames = [...new Set([...DEFAULT_SKILLS, ...this.skillNames].map(canonicalSkillName))];
    for (const name of requestedNames) {
      const info = findSkill(this.skillsRoot, name);
      if (!info) {
        const available = listSkills(this.skillsRoot).map((s) => s.name).join(', ') || '(none found)';
        throw new Error(`No skill named '${name}' in ${this.skillsRoot}. Available: ${available}`);
      }
      resolved.push(info.path);
    }
    resolved.push(...this.skillDirs);
    if (!resolved.length) {
      throw new Error('No default skills found in the skills directory.');
    }
    return resolved;
  }

  _registerCommands() {
    registerBuiltinCommands(this.commandSystem, this.sessionManager, this.targetManager, this.taskQueue, this.configManager);
    for (const command of this.projectContext.customCommands()) {
      this.commandSystem.register(command.name, command.description, (args, ctx) => ({
        prompt: ctx.cli.projectContext.renderCommand(command, args),
      }), '[arguments]', [`/${command.name}`]);
    }
  }

  _initializeTools() {
    registerBuiltInTools(this.toolRegistry, this.config);
    registerToolHelp(this.toolRegistry);
    this.toolRegistry.mode = this.interactionMode === 'plan' ? 'plan' : 'normal';

    this.toolRegistry.register(
      'skill_search',
      'Search available Raven skills by name or description. Args: {query: str, limit?: int}',
      ({ query, limit } = {}) => {
        const needle = String(query || '').trim().toLowerCase();
        if (!needle) return { error: 'Provide a query to search skills.' };
        const matches = listSkills(this.skillsRoot)
          .filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(needle))
          .slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)))
          .map(({ name, description }) => ({ name, description, loaded: this.loadedSkillNames.has(name) }));
        return { query: needle, count: matches.length, skills: matches };
      }
    );
    this.toolRegistry.register(
      'skill_load',
      'Load a discovered Raven skill into the current agent context. Args: {name: str}',
      async ({ name } = {}) => {
        if (!name) return { error: 'Provide a skill name from skill_search.' };
        const [success, message] = await this.loadSkill(String(name));
        return success ? { success: true, name: String(name), message } : { success: false, error: message };
      }
    );
  }

  get promptMode() {
    return this.config.prompt_mode === 'full' ? 'full' : 'lite';
  }

  setInteractionMode(mode) {
    const modes = ['normal', 'auto', 'plan'];
    const next = modes.includes(mode) ? mode : 'normal';
    this.interactionMode = next;
    this.config.interaction_mode = next;
    this.configManager.save();
    this.toolRegistry.mode = next === 'plan' ? 'plan' : 'normal';
    this._updateFooter();
    return next;
  }

  cycleInteractionMode() {
    const modes = ['normal', 'auto', 'plan'];
    return this.setInteractionMode(modes[(modes.indexOf(this.interactionMode) + 1) % modes.length]);
  }

  _updateFooter() {
    if (this.ui) this.ui.setFooterRight(`${this._modelLabel || ''} · ${this.interactionMode} · context ${this._contextGauge()}`);
  }

  /** Skills the user explicitly asked for (--skill / enabled_skills / --skill-dir). */
  _explicitSkillPaths() {
    const paths = [];
    for (const name of this.skillNames) {
      if (DEFAULT_SKILLS.includes(name)) continue;
      const info = findSkill(this.skillsRoot, name);
      if (!info) throw new Error(`No skill named '${name}' in ${this.skillsRoot}.`);
      paths.push(info.path);
    }
    return [...paths, ...this.skillDirs];
  }

  /** Build the system prompt for the current mode (lite = on-demand skills). */
  _composePrompt() {
    const memory = this.projectContext.memory();
    const withMemory = (prompt) => memory ? `${prompt}\n\n## Project memory (RAVEN.md)\n${memory}` : prompt;
    if (this.promptMode === 'full') {
      const skillPaths = this._resolveSkills();
      this._loadedSkillPaths = skillPaths;
      this.loadedSkillNames = new Set([...DEFAULT_SKILLS, ...this.skillNames]);
      return withMemory(loadSkills(skillPaths, this.toolRegistry));
    }
    const explicit = this._explicitSkillPaths();
    // keep skills that were auto-loaded earlier in this session
    const extra = (this._loadedSkillPaths || []).filter((p) => !explicit.includes(p));
    this._loadedSkillPaths = [...explicit, ...extra];
    this.loadedSkillNames = new Set(this._loadedSkillPaths.map((p) => path.basename(p)));
    const bodies = this._loadedSkillPaths.map((p) => loadSkills([p], this.toolRegistry, { protocol: false }));
    return withMemory(buildLitePrompt({ registry: this.toolRegistry, skillNames: this._availableSkillNames(), loadedBodies: bodies }));
  }

  setPromptMode(mode) {
    this.config.prompt_mode = mode === 'full' ? 'full' : 'lite';
    this.configManager.save();
    this._loadedSkillPaths = []; // start from a clean slate for the new mode
    this.systemPrompt = this._composePrompt();
    if (this.agent) this.agent.messages[0].content = this.systemPrompt;
    return Math.round(this.systemPrompt.length / 4);
  }

  async _initializeBackend(backendName, model, baseUrl, apiKey) {
    const routes = this._buildBackendRoutes();
    if (!this.demo && routes.length) {
      this.backend = new MultiBackendRouter(routes);
      this.systemPrompt = this._composePrompt();
      this.agent = new Agent(this.config, this.toolRegistry, this.backend, {
        maxIterations: this.maxIterations,
        showThinking: true,
        skillsRoot: this.skillsRoot,
        skillLoaderCallback: (name) => this.loadSkill(name),
      });
      this.agent.messages[0].content = this.systemPrompt;
      this.agent.loadedSkills = new Set(this.loadedSkillNames);
      return;
    }

    let resolvedBaseUrl;
    if (this.demo) {
      resolvedBaseUrl = 'demo://local';
    } else if (PRESETS[backendName]) {
      const preset = PRESETS[backendName];
      resolvedBaseUrl = baseUrl || preset.base_url;
      if (!resolvedBaseUrl) throw new Error(`--backend ${backendName} needs --base-url.`);
      const keyEnv = preset.api_key_env;
      if (keyEnv) apiKey = apiKey || process.env[keyEnv];
    } else {
      resolvedBaseUrl = baseUrl;
      if (!resolvedBaseUrl) throw new Error(`--backend ${backendName} needs --base-url.`);
    }

    const backendConfig = new BackendConfig({
      base_url: resolvedBaseUrl,
      model,
      provider: ['ollama', 'omniroute'].includes(backendName) ? 'ollama' : null,
      api_key: apiKey,
      temperature: this.temperature,
      max_tokens: this.config.backend.max_tokens,
      timeout: this.config.backend.timeout,
    });

    this.backend = this.demo ? new DemoBackend() : new ChatBackend(backendConfig);

    this.systemPrompt = this._composePrompt();

    this.agent = new Agent(this.config, this.toolRegistry, this.backend, {
      maxIterations: this.maxIterations,
      showThinking: true,
      skillsRoot: this.skillsRoot,
      skillLoaderCallback: (name) => this.loadSkill(name),
    });

    this.agent.messages[0].content = this.systemPrompt;
    this.agent.loadedSkills = new Set(this.loadedSkillNames);
  }

  _buildBackendRoutes() {
    const configured = (this.config.model_routes || []).filter((route) => route && route.enabled !== false);
    const providers = this.config.providers || {};
    const routes = [];
    for (const route of configured) {
      const providerName = String(route.provider || route.backend || '').trim();
      const provider = providers[providerName] || {};
      const backendName = route.backend || provider.type || providerName;
      const preset = PRESETS[backendName] || {};
      const baseUrl = route.base_url || provider.base_url || preset.base_url;
      const model = route.model;
      if (!baseUrl || !model) continue;
      const keys = provider.api_keys || {};
      const keyName = route.api_key || provider.default_key || Object.keys(keys)[0] || '';
      const apiKey = route.api_key_value || keys[keyName] || provider.api_key || (preset.api_key_env ? process.env[preset.api_key_env] : '');
      const cfg = new BackendConfig({
        base_url: baseUrl,
        model,
        provider: providerName || (['ollama', 'omniroute'].includes(backendName) ? 'ollama' : backendName),
        api_key: apiKey,
        temperature: route.temperature ?? this.temperature,
        max_tokens: route.max_tokens || this.config.backend.max_tokens,
        timeout: route.timeout || this.config.backend.timeout,
      });
      routes.push({
        name: route.name || `${providerName || backendName}:${model}`,
        provider: providerName || backendName,
        backend: new ChatBackend(cfg),
      });
    }
    return routes;
  }

  async loadSkill(skillName) {
    if (skillName === 'osint-threat-intel') skillName = 'osint-suite';
    if (this.loadedSkillNames.has(skillName)) {
      return [true, `Skill '${skillName}' already loaded`];
    }
    const skillInfo = findSkill(this.skillsRoot, skillName);
    if (!skillInfo) return [false, `Skill '${skillName}' not found`];

    const newSkillPrompt = loadSkills([skillInfo.path], this.toolRegistry, { protocol: false });
    this.systemPrompt += `\n\n${newSkillPrompt}`;
    this.agent.messages[0].content = this.systemPrompt;
    this._loadedSkillPaths.push(skillInfo.path);
    this.loadedSkillNames.add(skillName);
    if (this.agent) this.agent.loadedSkills.add(skillName);
    return [true, `Skill '${skillName}' loaded successfully`];
  }

  async setSkillEnabled(skillName, enabled) {
    if (DEFAULT_SKILLS.includes(skillName) && !enabled) {
      return [false, `Skill '${skillName}' is a required default skill`];
    }
    if (!findSkill(this.skillsRoot, skillName)) {
      return [false, `Skill '${skillName}' not found`];
    }

    let enabledSkills = [...(this.config.enabled_skills && this.config.enabled_skills.length ? this.config.enabled_skills : this.skillNames)];
    if (enabled && !enabledSkills.includes(skillName)) enabledSkills.push(skillName);
    if (!enabled) enabledSkills = enabledSkills.filter((n) => n !== skillName);
    if (!enabledSkills.length) return [false, 'At least one skill must remain enabled'];

    this.config.enabled_skills = enabledSkills;
    this.configManager.save();
    this.skillNames = enabledSkills;
    this.systemPrompt = this._composePrompt();
    if (this.agent) {
      this.agent.messages[0].content = this.systemPrompt;
      this.agent.loadedSkills = new Set(this.loadedSkillNames);
    }
    return [true, `Skill '${skillName}' ${enabled ? 'enabled' : 'disabled'}`];
  }

  _availableSkillNames() {
    return listSkills(this.skillsRoot).map((s) => s.name);
  }

  restoreSessionContext(sessionId) {
    const session = this.sessionManager.load(sessionId);
    if (!session) return null;

    if (this.agent) {
      const restored = [{ role: 'system', content: this.systemPrompt, tool_calls: null, timestamp: null }];
      for (const entry of session.entries) {
        if (['user', 'assistant'].includes(entry.role) && entry.content) {
          restored.push({ role: entry.role, content: entry.content, tool_calls: null, timestamp: entry.timestamp });
        }
      }
      this.agent.messages = restored;
    }
    return session;
  }

  async start(backendName, model, baseUrl, apiKey) {
    this._running = true;

    try {
      await this._initializeBackend(backendName, model, baseUrl, apiKey);
    } catch (e) {
      console.log(chalk.red(`Failed to initialize backend: ${e.message}`));
      console.log(chalk.yellow('Run `raven config` to set up your backend'));
      return;
    }

    if (this.oneShotPrompt) {
      try {
        const response = await this.agent.process(this.oneShotPrompt, null, { persistInput: this.oneShotPrompt });
        process.stdout.write(this.jsonOutput ? `${JSON.stringify({ answer: response, model: this.backend.cfg.model })}\n` : `${response}\n`);
      } catch (e) {
        process.stderr.write(`${e.message || e}\n`);
        process.exitCode = 1;
      }
      return;
    }

    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (interactive) process.stdout.write('\x1b[2J\x1b[H');
    setTheme(this.config.theme);
    this._modelLabel = `${this.backend.cfg.model} \u00b7 ${backendName || this.config.backend.type}`;

    const bannerInfo = {
      model: this.backend.cfg.model,
      backend: backendName || this.config.backend.type,
      workspace: path.resolve(this.config.workspace.path),
      skills: this.promptMode === 'lite' ? `${this.loadedSkillNames.size} loaded \u00b7 auto-load on demand \u00b7 ~${Math.round(this.systemPrompt.length / 4)} prompt tokens` : `${this.loadedSkillNames.size} loaded`,
    };
    if (!interactive) await printBanner(VERSION, bannerInfo, { animate: false });

    // The session file is created lazily on the first message (no empty sessions).
    this.ui = interactive ? new TerminalUI({ headerLines: renderBannerLines(VERSION, bannerInfo) }) : new PlainUI();
    setActiveUI(this.ui);
    this._notifyOn = interactive;
    setAskHook((question) => {
      if (!this._notifyOn) return;
      const first = question.replace(/\x1b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim()) || 'Confirmation required';
      this.notifier.notify('attention', { title: 'Raven needs your approval', body: first.trim().slice(0, 120) });
    });
    this._startReminderWorker();

    if (interactive) {
      const finished = new Promise((resolve) => {
        this._resolveExit = resolve;
      });
      this.ui.start({
        history: this._loadHistory(),
        suggest: (text) => this._suggest(text),
        onSubmit: (text, pastes) => this._enqueue(text, pastes),
        onPaste: () => readClipboard(),
        onHistory: (text) => this._saveHistory(text),
        onInterrupt: () => this._interrupt(),
        onExit: () => this._requestExit(),
        onModeCycle: () => {
          const mode = this.cycleInteractionMode();
          this.ui.setHint(`Mode: ${mode === 'auto' ? 'auto-accept edits' : mode === 'plan' ? 'plan (read-only)' : 'normal'}`);
        },
      });
      this._updateFooter();
      for (const cmd of this.startupCommands) this._enqueue(cmd);
      await finished;
      this.ui.stop();
    } else {
      this.ui.start({});
      for (const cmd of this.startupCommands) await this._processItem(cmd);
      while (this._running) {
        const line = await this.ui.nextLine();
        if (line === null) break;
        if (line.trim()) await this._processItem(line.trim());
      }
      this.ui.stop();
    }
    setActiveUI(null);
    setAskHook(null);
    if (!this._restarting) console.log(chalk.hex(getTheme().dim)('Bye.'));
  }

  // -------------------------------------------------------------------
  // Input queue: you can keep typing while Raven works
  // -------------------------------------------------------------------

  _enqueue(text, attachments = []) {
    const t = text.trim();
    if ((!t && !attachments.length) || !this._running) return;
    this.queue.push({ text: t, attachments });
    this.ui.setQueue(this.queue);
    this._drain();
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this.queue.length && this._running) {
        const item = this.queue.shift();
        this.ui.setQueue(this.queue);
        await this._processItem(item);
      }
    } finally {
      this._draining = false;
      this.ui.setQueue([]);
      if (this._exitPending) this._finish();
    }
  }

  async _processItem(item) {
    const text = typeof item === 'string' ? item : item.text;
    const pastes = typeof item === 'string' ? [] : item.attachments || [];
    this.ui.print(this._userEcho(text, pastes));
    try {
      if (text.startsWith('/')) await this._handleCommand(text);
      else if (text.startsWith('!')) await this._handleShellShortcut(text.slice(1).trim());
      else await this._handleAiInput(text, pastes);
    } catch (e) {
      this.ui.setBusy(false);
      this.ui.print(`${chalk.hex(getTheme().err)('\u2717')} ${chalk.hex(getTheme().err)(`Unexpected error: ${e.message}`)}`);
    }
  }

  _contextGauge() {
    if (!this.agent) return '0%';
    const chars = this.agent.messages.reduce((total, message) => total + String(message.content || '').length, 0);
    return `${Math.min(100, Math.round((chars / (this.config.max_context_chars || 240000)) * 100))}%`;
  }

  async _handleShellShortcut(command) {
    if (!command) return;
    const result = await this.toolRegistry.execute('execute_command', { command });
    const text = result.output || result.error || JSON.stringify(result);
    this.ui.print(formatCommandResult(String(text)).split('\n').map((line) => `  ${line}`).join('\n'));
  }

  _userEcho(item, pastes = []) {
    const t = getTheme();
    const cols = process.stdout.columns || 80;
    const rows = [];
    const suffix = pastes.length ? `  [${pastes.map((p) => p.label).join(', ')}]` : '';
    for (const line of `${item}${suffix}`.split('\n')) rows.push(...hardWrap(line, cols - 5));
    return rows
      .map((l, i) => {
        const lead = i === 0 ? chalk.hex(t.primary).bold('\u203a') : ' ';
        const body = l.startsWith('/') && i === 0 ? chalk.hex(t.accent).bold(l.split(' ')[0]) + chalk.hex(t.text)(l.slice(l.split(' ')[0].length)) : chalk.hex(t.text)(l);
        // Keep user prompts on the terminal background; only the prompt text
        // and marker should carry Raven's accent colors.
        return ` ${lead} ${highlightMentions(body, t)}`;
      })
      .join('\n');
  }

  _interrupt() {
    if (this.abortController) this.abortController.abort();
  }

  _requestExit() {
    this._running = false;
    this._exitPending = true;
    this.queue.length = 0;
    this._interrupt();
    if (!this._draining) this._finish();
  }

  _finish() {
    if (this._resolveExit) {
      const resolve = this._resolveExit;
      this._resolveExit = null;
      resolve();
    }
  }

  _historyFile() {
    return path.join(os.homedir(), '.raven', 'history.jsonl');
  }

  _loadHistory() {
    try {
      return fs
        .readFileSync(this._historyFile(), 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-500)
        .map((l) => JSON.parse(l));
    } catch (e) {
      return [];
    }
  }

  _saveHistory(text) {
    try {
      fs.mkdirSync(path.dirname(this._historyFile()), { recursive: true });
      fs.appendFileSync(this._historyFile(), `${JSON.stringify(text)}\n`);
    } catch (e) {
      /* history is best-effort */
    }
  }

  // -------------------------------------------------------------------
  // "/" suggestions (command menu like Claude Code)
  // -------------------------------------------------------------------

  _commandItems() {
    return this.commandSystem.list().sort((a, b) => a.name.localeCompare(b.name));
  }

  _skillInfos() {
    if (!this._skillCache) {
      try {
        this._skillCache = listSkills(this.skillsRoot);
      } catch (e) {
        this._skillCache = [];
      }
    }
    return this._skillCache;
  }

  _argCandidates(cmd, done) {
    const themes = Object.keys(THEMES).map((n) => ({ value: n, desc: THEMES[n].label }));
    const skills = this._skillInfos().map((s) => ({ value: s.name, desc: s.description }));
    const sub = (arr) => arr.map(([value, desc]) => ({ value, desc }));
    switch (cmd) {
      case 'skill':
        if (done.length === 0) {
          return {
            items: [...sub([['list', 'List available skills'], ['load', 'Load a skill'], ['enable', 'Enable a skill permanently'], ['disable', 'Disable a skill']]), ...skills],
            final: (v) => !['load', 'enable', 'disable'].includes(v),
          };
        }
        if (done.length === 1 && ['load', 'enable', 'disable', 'info'].includes(done[0])) return { items: skills, final: () => true };
        return null;
      case 'help':
        return done.length === 0 ? { items: this._commandItems().map((c) => ({ value: c.name, desc: c.description })), final: () => true } : null;
      case 'config':
        if (done.length === 0) return { items: sub([['show', 'Show configuration'], ['set', 'Change a setting'], ['reset', 'Reset to defaults']]), final: (v) => v !== 'set' };
        if (done[0] === 'set' && done.length === 1) {
          return { items: sub([['backend', 'ollama, lmstudio, openrouter...'], ['model', 'Model name'], ['base_url', 'Custom endpoint'], ['api_key', 'API key'], ['vt_key', 'VirusTotal key'], ['abuse_key', 'AbuseIPDB key'], ['shodan_key', 'Shodan key']]), final: () => false };
        }
        if (done[0] === 'set' && done[1] === 'backend' && done.length === 2) return { items: Object.keys(PRESETS).map((n) => ({ value: n, desc: PRESETS[n].note })), final: () => true };
        return null;
      case 'provider':
        if (done.length === 0) return { items: sub([['list', 'List providers'], ['add', 'Add provider'], ['key', 'Save API key'], ['default-key', 'Choose default key'], ['remove', 'Remove provider']]), final: (v) => v === 'list' };
        if (done[0] === 'add' && done.length === 2) return { items: Object.keys(PRESETS).map((n) => ({ value: n, desc: PRESETS[n].note })), final: () => false };
        return null;
      case 'route':
        if (done.length === 0) return { items: sub([['list', 'List routes'], ['add', 'Add model route'], ['remove', 'Remove by number'], ['clear', 'Clear routes']]), final: (v) => ['list', 'clear'].includes(v) };
        if (done[0] === 'add' && done.length === 2) return { items: Object.keys(this.config.providers || {}).map((n) => ({ value: n, desc: 'provider' })), final: () => false };
        return null;
      case 'session':
        if (done.length === 0) return { items: sub([['list', 'List sessions'], ['create', 'Create a session'], ['load', 'Restore a session'], ['delete', 'Delete a session']]), final: (v) => v === 'list' };
        if (done.length === 1 && ['load', 'delete'].includes(done[0])) {
          return { items: this.sessionManager.list().slice(0, 15).map((s) => ({ value: s.id, desc: s.name })), final: () => true };
        }
        return null;
      case 'target':
        return done.length === 0 ? { items: sub([['list', 'List targets'], ['create', 'Create a target'], ['info', 'Target details'], ['add', 'Add an identifier']]), final: (v) => v === 'list' } : null;
      case 'task':
        return done.length === 0 ? { items: sub([['list', 'List tasks'], ['stats', 'Task statistics'], ['status', 'Status of one task'], ['cancel', 'Cancel a task']]), final: (v) => ['list', 'stats'].includes(v) } : null;
      case 'server':
        return done.length === 0 ? { items: sub([['list', 'List background servers'], ['start', 'Start: <name> | <command> | [port]'], ['logs', 'Show recent logs'], ['stop', 'Stop one server'], ['stop-all', 'Stop all servers']]), final: (v) => ['list', 'stop-all'].includes(v) } : null;
      case 'discord':
        return done.length === 0 ? { items: sub([['start', 'Start the bot bridge'], ['stop', 'Stop the bridge'], ['status', 'Show bridge status'], ['prefix', 'Set message prefix'], ['token', 'Save bot token'], ['token-env', 'Set token env var'], ['owner', 'Allow a user id'], ['channel', 'Allow a channel id']]), final: (v) => ['start', 'stop', 'status'].includes(v) } : null;
      case 'telegram':
        return done.length === 0 ? { items: sub([['start', 'Start the bot bridge'], ['stop', 'Stop the bridge'], ['status', 'Show bridge status'], ['prefix', 'Set message prefix'], ['token', 'Save bot token'], ['token-env', 'Set token env var'], ['owner', 'Allow a user id'], ['chat', 'Allow a chat id']]), final: (v) => ['start', 'stop', 'status'].includes(v) } : null;
      case 'git':
        return done.length === 0 ? { items: sub([['status', 'Working tree status'], ['diff', 'Show changes'], ['log', 'Recent commits']]), final: () => true } : null;
      case 'reminder':
        return done.length === 0 ? { items: sub([['list', 'List reminders'], ['add', 'Add: <title> | <when>'], ['cancel', 'Cancel by id'], ['export', 'Export to .ics']]), final: (v) => v === 'list' } : null;
      case 'notify':
        if (done.length === 0) return { items: sub([['sound', 'Sound on/off'], ['desktop', 'Desktop notification on/off'], ['min', 'Only for tasks longer than N seconds'], ['test', 'Play the sounds now']]), final: (v) => v === 'test' };
        if (done.length === 1 && ['sound', 'desktop'].includes(done[0])) return { items: sub([['on', ''], ['off', '']]), final: () => true };
        return null;
      case 'resume':
        return done.length === 0 ? { items: [{ value: 'last', desc: 'Most recent conversation' }, ...this._sessionItems().slice(0, 12).map((i) => ({ value: i.value, desc: `${i.label} \u00b7 ${i.desc}` }))], final: () => true } : null;
      case 'undo':
        return done.length === 0 ? { items: sub([['list', 'Show what can be undone'], ['force', 'Revert even if files changed since']]), final: () => true } : null;
      case 'prompt':
        return done.length === 0 ? { items: sub([['lite', 'Compact prompt, skills on demand'], ['full', 'All default skills always loaded']]), final: () => true } : null;
      case 'theme':
        return done.length === 0 ? { items: themes, final: () => true } : null;
      case 'thinking':
        return done.length === 0 ? { items: sub([['on', 'Show a short reasoning summary'], ['off', 'Only show thinking time'], ['full', 'Show the whole reasoning']]), final: () => true } : null;
      default:
        return null;
    }
  }

  /** Project files for the "@" menu: workspace first, then the current directory. */
  _mentionFiles() {
    const ws = path.resolve(this.config.workspace.path);
    const files = [...mentions.listProjectFiles(ws)];
    const cwd = process.cwd();
    const tooBroad = cwd === os.homedir() || path.parse(cwd).root === cwd;
    if (cwd !== ws && !tooBroad) {
      const wsRel = path.relative(cwd, ws).split(path.sep).join('/');
      const seen = new Set(files);
      for (const f of mentions.listProjectFiles(cwd)) {
        if (wsRel && !wsRel.startsWith('..') && (f === `${wsRel}/` || f.startsWith(`${wsRel}/`))) continue;
        if (!seen.has(f)) files.push(f);
      }
    }
    return files;
  }

  _mentionItems(m) {
    return mentions.filterFiles(this._mentionFiles(), m.query, 60).map((f) => ({
      label: `@${f}`,
      desc: f.endsWith('/') ? 'folder' : '',
      insert: `@${f}${f.endsWith('/') ? '' : ' '}`,
      range: { start: m.start, end: m.end },
      final: false,
    }));
  }

  _suggest(text, cursor) {
    const chars = Array.from(text);
    const at = cursor === undefined ? chars.length : cursor;
    const mention = mentions.findMentionAt(chars, at);
    if (mention) return this._mentionItems(mention);
    if (at !== chars.length) return [];
    if (!text.startsWith('/') || text.includes('\n')) return [];

    const nameOnly = /^\/(\S*)$/.exec(text);
    if (nameOnly) {
      const q = nameOnly[1].toLowerCase();
      const all = this._commandItems();
      const starts = all.filter((c) => c.name.startsWith(q));
      const others = all.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || c.description.toLowerCase().includes(q)));
      return [...starts, ...others].map((c) => ({
        label: `/${c.name}`,
        desc: c.description + (c.argsHelp ? `  ${c.argsHelp}` : ''),
        insert: `/${c.name}${c.argsHelp ? ' ' : ''}`,
        // Commands with a sub-menu (e.g. /skill) open it on Enter instead of running bare.
        final: !c.argsHelp || (c.argsHelp.startsWith('[') && !this._argCandidates(c.name, [])),
      }));
    }

    const m = /^\/(\S+)\s([\s\S]*)$/.exec(text);
    if (!m) return [];
    const cmd = m[1].toLowerCase();
    const rest = m[2];
    const endsWithSpace = /\s$/.test(rest);
    const toks = rest.trim().split(/\s+/).filter(Boolean);
    const cur = endsWithSpace ? '' : toks[toks.length - 1] || '';
    const done = endsWithSpace ? toks : toks.slice(0, -1);
    const cands = this._argCandidates(cmd, done);
    if (!cands) return [];

    const base = `/${cmd} ${done.join(' ')}${done.length ? ' ' : ''}`;
    const q = cur.toLowerCase();
    const matches = cands.items.filter((c) => c.value.toLowerCase().startsWith(q));
    const extra = cands.items.filter((c) => !c.value.toLowerCase().startsWith(q) && c.value.toLowerCase().includes(q));
    return [...matches, ...extra].map((c) => {
      const final = cands.final(c.value);
      return { label: c.value, desc: c.desc, insert: `${base}${c.value}${final ? '' : ' '}`, final };
    });
  }

  // -------------------------------------------------------------------
  // Reminders
  // -------------------------------------------------------------------

  _startReminderWorker() {
    const store = new AutomationStore();
    const tick = async () => {
      if (!this._running) return;
      try {
        for (const item of store.due()) {
          this.ui.print(`\n${chalk.hex(getTheme().warn).bold('\u23f0 Raven reminder')} ${item.title || ''}`);
          if (item.prompt && item.prompt !== item.title) this.ui.print(item.prompt);
        }
      } catch (e) {
        /* mirrors the Python worker's blanket except: pass */
      }
      this._reminderTimer = setTimeout(tick, 15000);
      if (this._reminderTimer.unref) this._reminderTimer.unref();
    };
    this._reminderTimer = setTimeout(tick, 15000);
    if (this._reminderTimer.unref) this._reminderTimer.unref();
  }

  // -------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------

  async _handleCommand(userInput) {
    const spaceIdx = userInput.search(/\s/);
    const rawCommand = spaceIdx === -1 ? userInput : userInput.slice(0, spaceIdx);
    const commandName = rawCommand.slice(1);
    const args = spaceIdx === -1 ? '' : userInput.slice(spaceIdx + 1).trim();

    if (['quit', 'exit', 'q'].includes(commandName)) {
      this._requestExit();
      return;
    }
    if (commandName === 'restart') {
      this._restart();
      return;
    }

    const context = { config_manager: this.configManager, cli: this };
    this.ui.setBusy(true, { verb: `Running ${rawCommand}` });
    let result;
    try {
      result = await this.commandSystem.execute(commandName, args, context);
    } finally {
      this.ui.setBusy(false);
    }
    if (result && typeof result === 'object' && result.prompt) {
      await this._handleAiInput(result.prompt);
      return;
    }
    this._updateFooter();
    if (result && typeof result === 'object' && result.raw !== undefined) {
      this.ui.print(String(result.raw));
    } else if (result) {
      const body = formatCommandResult(String(result));
      this.ui.print(body.split('\n').map((l) => `  ${l}`).join('\n'));
    }
  }

  async processExternal(userInput, meta = {}) {
    const text = String(userInput || '').trim();
    if (!text) return '';
    if (text.startsWith('/')) {
      const spaceIdx = text.search(/\s/);
      const rawCommand = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
      const commandName = rawCommand.slice(1);
      const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();
      if (['quit', 'exit', 'q', 'restart'].includes(commandName)) return `/${commandName} is only available in the local terminal.`;
      const result = await this.commandSystem.execute(commandName, args, { config_manager: this.configManager, cli: this, external: meta });
      if (result && typeof result === 'object' && result.prompt) return this.processExternal(result.prompt, meta);
      if (result && typeof result === 'object' && result.raw !== undefined) return String(result.raw);
      return result ? String(result) : '';
    }
    if (text.startsWith('!')) {
      const result = await this.toolRegistry.execute('execute_command', { command: text.slice(1).trim() });
      return result.output || result.error || JSON.stringify(result);
    }

    this.sessionManager.addEntry('user', text);
    fileHistory.beginTurn();
    const response = await this.agent.process(`[External ${meta.source || 'client'} request]\n${text}`, null, { persistInput: text });
    this.sessionManager.addEntry('assistant', response);
    fileHistory.end();
    this._commitTurnChanges(text);
    return response;
  }

  // -------------------------------------------------------------------
  // AI turn
  // -------------------------------------------------------------------

  async _handleAiInput(userInput, pastes = []) {
    const ui = this.ui;
    const t = getTheme();
    const cols = process.stdout.columns || 80;
    const pasteBlocks = pastes.map((paste) => paste.kind === 'text'
      ? `[Pasted text]\n${paste.text}\n[/Pasted text]`
      : `[Pasted ${paste.kind || 'file'}: ${paste.label || paste.kind}]`).join('\n\n');
    const taskInput = pasteBlocks ? `${userInput}${userInput ? '\n\n' : ''}${pasteBlocks}` : userInput;
    this.sessionManager.addEntry('user', taskInput);

    fileHistory.beginTurn();
    const controller = new AbortController();
    this.abortController = controller;
    const startedAt = Date.now();
    let iterStart = Date.now();
    let streamBuf = '';
    let reasoningBuf = '';
    let tokensDone = 0;
    let verbSeed = Math.floor(Math.random() * THINK_VERBS.length);

    const thinkingVerb = () => THINK_VERBS[(verbSeed + Math.floor((Date.now() - iterStart) / 6000)) % THINK_VERBS.length];
    ui.setBusy(true, { verb: thinkingVerb });

    const onStream = () => {
      const tokens = tokensDone + Math.ceil((streamBuf.length + reasoningBuf.length) / 4);
      const open = streamBuf.lastIndexOf('```thinking');
      let phase = 'thinking';
      let thinkingText = reasoningBuf;
      if (open !== -1) {
        const after = streamBuf.slice(open + 11);
        const close = after.indexOf('\n```');
        if (close === -1) thinkingText = after;
        else phase = /```tool/.test(after.slice(close + 4)) ? 'tool' : 'writing';
      } else if (/```tool/.test(streamBuf)) phase = 'tool';
      else if (streamBuf.trim()) phase = 'writing';

      const patch = { tokens };
      if (phase === 'tool') patch.verb = 'Preparing tool call';
      else if (phase === 'writing') patch.verb = 'Writing response';
      else patch.verb = thinkingVerb;
      patch.preview = phase === 'thinking' ? lastLines(thinkingText, 2) : [];
      ui.setActivity(patch);
    };

    const callback = (event, data, extra) => {
      if (event === 'request') {
        tokensDone += Math.ceil((streamBuf.length + reasoningBuf.length) / 4);
        streamBuf = '';
        reasoningBuf = '';
        iterStart = Date.now();
        verbSeed += 1;
        ui.setActivity({ verb: thinkingVerb, preview: [] });
      } else if (event === 'stream') {
        streamBuf += data;
        onStream();
      } else if (event === 'reasoning') {
        reasoningBuf += data;
        onStream();
      } else if (event === 'thinking') {
        this._printThinking(data, (Date.now() - iterStart) / 1000);
      } else if (event === 'notice') {
        ui.print(`  ${chalk.hex(t.warn)('\u21bb')} ${chalk.hex(t.dim)(data)}`);
      } else if (event === 'backend_fallback') {
        ui.print(`  ${chalk.hex(t.warn)('\u21bb')} ${chalk.hex(t.dim)(`model fallback: ${data.from} -> ${data.to}`)}`);
      } else if (event === 'tool_call') {
        fileHistory.begin();
        ui.print(`${chalk.hex(t.primary)('\u23fa')} ${chalk.hex(t.text).bold(data.name)}${chalk.hex(t.dim)(formatToolArgs(data.arguments, cols - data.name.length - 6))}`);
        ui.setActivity({ verb: `Running ${data.name}`, preview: [] });
      } else if (event === 'tool_result') {
        for (const line of summarizeToolResult(data, cols - 6)) ui.print(line);
        this._printChanges(fileHistory.end(), cols);
        ui.setActivity({ verb: thinkingVerb, preview: [] });
      }
    };

    // Lite mode: pull in skill bodies only when the request calls for them.
    const wanted = this.promptMode === 'lite' ? skillsForMessage(taskInput) : [];
    for (const name of wanted) {
      if (this.loadedSkillNames.has(name)) continue;
      const [ok] = await this.loadSkill(name);
      if (ok) ui.print(`  ${chalk.hex(t.accent)('\u273b')} ${chalk.hex(t.dim)(`loaded skill ${name}`)}`);
    }

    // Project context is only useful for code/file requests (or in full mode).
    let context = '';
    if (this.promptMode === 'full' || wanted.includes('raven-code')) {
      try {
        context = this.projectTools.contextForQuery(taskInput);
      } catch (e) {
        context = '(project context unavailable)';
      }
    }
    // @file mentions -> attached file contents
    const { attachments, problems } = mentions.resolveMentions(userInput, [path.resolve(this.config.workspace.path), process.cwd()]);
    for (const a of attachments) {
      const size = a.kind === 'dir' ? `${a.lines} entries` : `${a.lines} lines${a.truncated ? ', truncated' : ''}`;
      ui.print(`  ${chalk.hex(t.faint)('\u23bf')} ${chalk.hex(t.dim)('attached')} ${chalk.hex(t.secondary)(a.mention)} ${chalk.hex(t.dim)(`(${size})`)}`);
    }
    for (const p of problems) ui.print(`  ${chalk.hex(t.faint)('\u23bf')} ${chalk.hex(t.warn)(p)}`);

    const blocks = [];
    if (context) blocks.push(`Project context: ${context}`);
    if (attachments.length) blocks.push(mentions.buildAttachmentBlock(attachments));
    const prompt = blocks.length ? `${blocks.join('\n\n')}\n\nUser request:\n${taskInput}` : taskInput;

    let response;
    try {
      response = await this.agent.process(prompt, callback, { signal: controller.signal, persistInput: taskInput });
    } catch (exc) {
      ui.setBusy(false);
      this.abortController = null;
      this._printChanges(fileHistory.end(), cols); // work done before the interruption
      const partial = this._commitTurnChanges(userInput);
      if (partial) ui.print(partial);
      if (exc && (exc.aborted || exc.name === 'AbortError')) {
        ui.print(`${chalk.hex(t.warn)('\u23bf')} ${chalk.hex(t.dim)('Interrupted')}`);
      } else {
        ui.print(`${chalk.hex(t.err)('\u2717')} ${chalk.hex(t.err)(exc.message || String(exc))}`);
        this._notify('error', { title: 'Raven hit an error', body: String(exc.message || exc).slice(0, 120), seconds: (Date.now() - startedAt) / 1000 });
      }
      return;
    }

    ui.setBusy(false);
    this.abortController = null;
    this.sessionManager.addEntry('assistant', response);
    this._updateFooter();

    const lines = renderMarkdown(response, { width: cols - 3 });
    const out = lines.map((l, i) => (i === 0 ? `${chalk.hex(t.primary)('\u23fa')} ${l}` : `  ${l}`));
    await ui.typeOut(out);
    const changeHint = this._commitTurnChanges(userInput);
    if (changeHint) ui.print(changeHint);
    const secs = (Date.now() - startedAt) / 1000;
    ui.print(separator(`\u273b ${fmtElapsed(secs)}`, cols));
    this._notify('done', { title: 'Raven finished', body: response.replace(/[#*`>\n]+/g, ' ').trim().slice(0, 120), seconds: secs });
  }

  _notify(kind, info) {
    if (this._notifyOn) this.notifier.notify(kind, info);
  }

  _sessionItems() {
    return this.sessionManager.list({ includeEmpty: false }).map((sess) => ({
      label: sess.title || sess.name || sess.id,
      desc: `${sess.count} msgs \u00b7 ${timeAgo(sess.updated_at)}`,
      value: sess.id,
    }));
  }

  /** Reload a saved conversation into the agent and show a short recap. */
  resumeSession(id) {
    const session = this.restoreSessionContext(id);
    if (!session) return null;
    const t = getTheme();
    const chat = session.entries.filter((e) => ['user', 'assistant'].includes(e.role));
    const title = (chat.find((e) => e.role === 'user') || {}).content || session.name;
    const lines = [`${chalk.hex(t.accent)('\u21ba')} ${chalk.hex(t.text).bold('Resumed')} ${chalk.hex(t.textSoft)(truncate(String(title).replace(/\s+/g, ' '), 60))} ${chalk.hex(t.dim)(`\u00b7 ${chat.length} messages \u00b7 ${timeAgo(session.updated_at || session.created_at)}`)}`];
    for (const e of chat.slice(-2)) {
      const flat = String(e.content).replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
      lines.push(`  ${chalk.hex(t.faint)(e.role === 'user' ? '\u203a' : '\u23fa')} ${chalk.hex(t.dim)(truncate(flat, (process.stdout.columns || 80) - 8))}`);
    }
    this.ui.print(lines.join('\n'));
    return session;
  }

  _displayPath(abs) {
    for (const root of [path.resolve(this.config.workspace.path), process.cwd()]) {
      const rel = path.relative(root, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
    }
    return abs;
  }

  /** Colored diffs for the files a tool call just changed. */
  _printChanges(changes, cols) {
    if (!changes || !changes.length) return;
    mentions.invalidate(); // new/removed files should show up in the @ menu
    const t = getTheme();
    const MAX_FILES = 4;
    for (const change of changes.slice(0, MAX_FILES)) {
      const lines = renderChange(change, { width: cols - 6, displayPath: this._displayPath(change.path), maxLines: 30 });
      this.ui.print(lines.map((l) => `    ${l}`).join('\n'));
    }
    if (changes.length > MAX_FILES) this.ui.print(`    ${chalk.hex(t.dim)(`\u2026 and ${changes.length - MAX_FILES} more changed files`)}`);
  }

  /** Close the turn's change set (for /undo); returns a hint line or ''. */
  _commitTurnChanges(userInput) {
    const entry = fileHistory.commitTurn(userInput.replace(/\s+/g, ' ').slice(0, 60));
    if (!entry) return '';
    const t = getTheme();
    const n = entry.changes.length;
    return `  ${chalk.hex(t.accent)('\u21a9')} ${chalk.hex(t.dim)(`${n} file${n > 1 ? 's' : ''} changed \u00b7 `)}${chalk.hex(t.accent)('/undo')}${chalk.hex(t.dim)(' to revert')}`;
  }

  _printThinking(text, seconds) {
    const t = getTheme();
    const secs = seconds >= 0.1 ? ` ${seconds.toFixed(1)}s` : '';
    if (this.thinkingMode === 'off') {
      this.ui.print(chalk.hex(t.dim)(`\u273b Thought for${secs || ' a moment'}`));
      return;
    }
    const width = Math.max((process.stdout.columns || 80) - 6, 20);
    const wrapped = [];
    for (const line of text.split('\n')) wrapped.push(...wrapLine(line.trim(), width));
    const limit = this.thinkingMode === 'full' ? wrapped.length : 6;
    const shown = wrapped.filter((l, i) => l || i < limit).slice(0, limit);
    const out = [chalk.hex(t.dim)(`\u273b Thought for${secs || ' a moment'}`)];
    for (const l of shown) out.push(`  ${chalk.hex(t.faint)('\u2502')} ${chalk.hex(t.dim).italic(l)}`);
    if (wrapped.length > limit) out.push(`  ${chalk.hex(t.faint)('\u2502')} ${chalk.hex(t.faint)(`\u2026 +${wrapped.length - limit} more lines (/thinking full)`)}`);
    this.ui.print(out.join('\n'));
  }

  _restart() {
    this.ui.print(chalk.hex(getTheme().warn)('Restarting\u2026'));
    this._running = false;
    this._exitPending = true;
    this.queue.length = 0;
    this._restarting = true;
    this._finish();
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers for tool activity
// ---------------------------------------------------------------------------

/** Commands that return raw JSON get a readable rendering instead. */
function formatCommandResult(text) {
  const t = getTheme();
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    let obj = null;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      obj = null;
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const lines = [];
      if ('stdout' in obj || 'stderr' in obj) {
        const code = obj.return_code !== undefined ? obj.return_code : obj.returncode;
        lines.push(obj.success ? chalk.hex(t.ok)(`\u2713 exit ${code}`) : chalk.hex(t.err)(`\u2717 exit ${code}`));
        if (obj.stdout) lines.push(...String(obj.stdout).replace(/\s+$/, '').split('\n').slice(0, 200));
        if (obj.stderr) lines.push(...String(obj.stderr).replace(/\s+$/, '').split('\n').slice(0, 60).map((l) => chalk.hex(t.err)(l)));
        return lines.join('\n');
      }
      const w = Math.max(...Object.keys(obj).map((k) => k.length), 1);
      for (const [k, v] of Object.entries(obj)) {
        const val = typeof v === 'string' ? v : JSON.stringify(v);
        lines.push(`${chalk.hex(t.dim)(k.padEnd(w))}  ${truncate(String(val), (process.stdout.columns || 80) - w - 6)}`);
      }
      return lines.join('\n');
    }
  }
  return renderRichMarkup(text).replace(/\s+$/, '');
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : new Date(iso).toISOString().slice(0, 10);
}

/** Underline-colour the @mentions inside an already styled echo line. */
function highlightMentions(line, t) {
  const plain = line;
  return plain.replace(/(^|\s)(@[^\s@]+)/g, (m, pre, tok) => `${pre}${chalk.hex(t.secondary).underline(tok)}`);
}

const THINK_VERBS = ['Thinking', 'Reasoning', 'Cross-checking', 'Pondering', 'Connecting dots', 'Weighing sources', 'Working it out', 'Analysing'];

function lastLines(text, n) {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n);
}

function short(value, max) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = String(s).replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}

function formatToolArgs(args, room) {
  const entries = Object.entries(args || {});
  if (!entries.length) return '';
  const budget = Math.max(room, 20);
  const parts = [];
  for (const [k, v] of entries.slice(0, 3)) parts.push(`${k}: ${short(v, Math.max(Math.floor(budget / Math.min(entries.length, 3)) - k.length - 4, 12))}`);
  if (entries.length > 3) parts.push('\u2026');
  return truncate(`(${parts.join(', ')})`, budget);
}

function summarizeToolResult(data, width) {
  const t = getTheme();
  const gutter = chalk.hex(t.faint)('  \u23bf ');
  const dim = (s) => chalk.hex(t.dim)(truncate(String(s), width));
  const out = [];
  if (!data || typeof data !== 'object') return [`${gutter}${dim(short(data, width))}`];

  // ToolRegistry wraps non-object results as {result}; unwrap JSON strings.
  if (typeof data.result === 'string' && Object.keys(data).length === 1) {
    try {
      const parsed = JSON.parse(data.result);
      if (parsed && typeof parsed === 'object') data = parsed;
    } catch (e) {
      /* plain text result */
    }
  }

  if (data.error) return [`${gutter}${chalk.hex(t.err)(truncate(`error: ${data.error}`, width))}`];

  if (Array.isArray(data.results)) {
    out.push(`${gutter}${dim(`${data.status || 'ok'} \u00b7 ${data.count || data.results.length} result(s)${data.backend ? ` \u00b7 ${data.backend}` : ''}`)}`);
    for (const item of data.results.slice(0, 3)) {
      const title = item && typeof item === 'object' ? item.title || 'untitled' : String(item);
      const url = item && typeof item === 'object' ? item.href || item.url || '' : '';
      out.push(`     ${chalk.hex(t.textSoft)(truncate(title, Math.floor(width * 0.6)))} ${chalk.hex(t.faint)(truncate(url, Math.floor(width * 0.35)))}`);
    }
    return out;
  }
  if (data.success === false) return [`${gutter}${chalk.hex(t.err)(truncate(data.stderr || data.errors || data.status || 'failed', width))}`];
  if (data.status === 'denied') return [`${gutter}${chalk.hex(t.warn)('denied by user')}`];

  const bits = [];
  if (data.path) bits.push(data.path);
  if (data.status) bits.push(data.status);
  if (typeof data.bytes === 'number') bits.push(`${data.bytes} bytes`);
  if (typeof data.size_bytes === 'number') bits.push(`${data.size_bytes} bytes`);
  if (typeof data.return_code === 'number') bits.push(`exit ${data.return_code}`);
  if (typeof data.returncode === 'number') bits.push(`exit ${data.returncode}`);
  if (data.success === true) out.push(`${gutter}${chalk.hex(t.ok)('done')}${bits.length ? chalk.hex(t.dim)(` \u00b7 ${truncate(bits.join(' \u00b7 '), width - 8)}`) : ''}`);
  else if (bits.length) out.push(`${gutter}${dim(bits.join(' \u00b7 '))}`);

  const body = data.stdout || data.output || data.content || '';
  if (body) {
    for (const line of String(body).split('\n').filter((l) => l.trim()).slice(0, 3)) out.push(`     ${chalk.hex(t.dim)(truncate(line, width - 2))}`);
  }
  if (!out.length) out.push(`${gutter}${dim(short(data, width))}`);
  return out;
}

// ---------------------------------------------------------------------------
// CLI wiring (port of the click command group)
// ---------------------------------------------------------------------------

const program = new Command();
program.name('raven').description('Raven \u2014 multi-backend, multi-skill OSINT/CTI agent.').version(VERSION);

program.option('-p, --prompt <text>', 'Run one prompt without opening the interactive UI.');
program.option('--json', 'Return one JSON object in prompt mode.', false);

async function runChat(opts) {
  const rootOpts = program.opts();
  opts = { ...rootOpts, ...opts, prompt: opts.prompt || rootOpts.prompt, json: Boolean(opts.json || rootOpts.json) };
  if (opts.configure) {
    await new SetupWizard().run();
    return;
  }

  const configManager = new ConfigManager();
  const config = configManager.get();

  if (opts.workspace) {
    config.workspace.path = path.resolve(opts.workspace);
    configManager.save();
  }

  let apiKey = opts.apiKey;
  if (opts.apiKeyEnv) apiKey = process.env[opts.apiKeyEnv] || apiKey;

  let backendName = opts.backend || config.backend.type;
  let model = opts.model || config.backend.model;
  let baseUrl = opts.baseUrl || config.backend.base_url;
  apiKey = apiKey || config.backend.api_key;

  if (backendName || model || baseUrl || apiKey) {
    if (opts.backend) config.backend.type = opts.backend;
    if (opts.model) config.backend.model = opts.model;
    if (opts.baseUrl) config.backend.base_url = opts.baseUrl;
    if (apiKey) config.backend.api_key = apiKey;
    configManager.save();
  }

  let skillNames = (opts.skill || []).map(canonicalSkillName);
  const skillDirs = opts.skillDir || [];
  if (!skillNames.length && !skillDirs.length) {
    skillNames = config.enabled_skills && config.enabled_skills.length
      ? [...new Set([...config.enabled_skills.map(canonicalSkillName), ...DEFAULT_SKILLS])]
      : [...DEFAULT_SKILLS, 'raven-code', 'osint-suite', 'telegram-suite'];
    if (config.enabled_skills && config.enabled_skills.includes('osint-threat-intel')) {
      config.enabled_skills = [...new Set(config.enabled_skills.map(canonicalSkillName))];
      configManager.save();
    }
    if (!config.enabled_skills || !config.enabled_skills.length) {
      config.enabled_skills = [...skillNames];
      configManager.save();
    }
  }

  const skillsRoot = opts.skillsRoot ? path.resolve(opts.skillsRoot) : DEFAULT_SKILLS_ROOT;
  if (opts.theme) {
    if (!THEMES[opts.theme]) {
      console.log(chalk.red(`Unknown theme '${opts.theme}'. Available: ${Object.keys(THEMES).join(', ')}`));
      process.exitCode = 1;
      return;
    }
    config.theme = opts.theme;
    configManager.save();
  }

  // Self-repair: re-create the `raven` launcher / PATH entry if they went missing.
  if (process.stdout.isTTY) {
    const heal = installer.autoHeal();
    if (heal.repaired) {
      const t = getTheme();
      console.log(chalk.hex(t.accent)('\u273b') + chalk.hex(t.dim)(' Repaired the `raven` command'));
      if (heal.needsNewTerminal) console.log(chalk.hex(t.dim)('  Open a new terminal and just type: ') + chalk.hex(t.primary)('raven'));
    }
  }

  const ravenCli = new RavenCLI(skillsRoot, skillNames, skillDirs);
  ravenCli.demo = Boolean(opts.demo);
  ravenCli.oneShotPrompt = opts.prompt || null;
  ravenCli.jsonOutput = Boolean(opts.json);
  if (opts.continue) ravenCli.startupCommands.push('/resume last');
  else if (opts.resume) ravenCli.startupCommands.push(opts.resume === true ? '/resume' : `/resume ${opts.resume}`);
  await ravenCli.start(backendName, model, baseUrl, apiKey);

  if (ravenCli._restarting) {
    // Supervisor restart: run a fresh copy attached to this terminal.
    const { spawn } = require('child_process');
    const child = spawn(process.argv[0], process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, RAVEN_RESTARTED: '1' } });
    child.on('exit', (code) => process.exit(code === null ? 0 : code));
  }
}

program
  .command('chat', { isDefault: true })
  .description('Start an interactive chat session with the agent.')
  .option('--backend <name>', `Which LLM server to use (${Object.keys(PRESETS).join('|')})`)
  .option('--model <name>', 'Model name as known by the backend.')
  .option('--base-url <url>', 'Override the default base URL (required for --backend custom).')
  .option('--api-key <key>', 'API key (overrides the environment variable).')
  .option('--api-key-env <name>', 'Name of the environment variable holding the API key.')
  .option('--skills-root <path>', 'Folder containing skill subfolders.', DEFAULT_SKILLS_ROOT)
  .option('--skill <name>', 'Skill name (looked up in --skills-root). Repeatable.', (val, prev) => [...(prev || []), val], [])
  .option('--skill-dir <path>', 'Direct path to a skill folder, bypasses --skills-root. Repeatable.', (val, prev) => [...(prev || []), val], [])
  .option('--workspace <path>', 'Folder Raven may create and modify files in.')
  .option('--configure', 'Run the setup wizard before starting.', false)
  .option('--demo', 'Try the interface offline with a scripted fake model.', false)
  .option('-p, --prompt <text>', 'Run one prompt without opening the interactive UI.')
  .option('--json', 'Return one JSON object in prompt mode.', false)
  .option('-c, --continue', 'Resume the most recent conversation.', false)
  .option('-r, --resume [id]', 'Pick a saved conversation to resume (or pass an id).')
  .option('--theme <name>', `Color theme (${Object.keys(THEMES).join('|')}).`)
  .action(runChat);

program
  .command('config')
  .description('Open configuration wizard')
  .action(async () => {
    await new SetupWizard().run();
  });

program
  .command('setup')
  .description('Make `raven` work from any terminal (adds it to your PATH) and repair it if broken.')
  .option('--check', 'Only report the status, change nothing.', false)
  .action((opts) => {
    const t = getTheme();
    if (opts.check) {
      const r = installer.check();
      console.log(`launcher   ${r.launcher === 'ok' ? chalk.hex(t.ok)('ok') : chalk.hex(t.err)(r.launcher)}  ${chalk.hex(t.dim)(r.launcherFile)}`);
      console.log(`on PATH    ${r.persisted === 'no' ? chalk.hex(t.err)('no') : chalk.hex(t.ok)(r.persisted === 'yes' ? 'yes' : 'yes (after opening a new terminal)')}`);
      if (!r.ok) console.log(chalk.hex(t.warn)(`Problems: ${r.problems.join('; ')}. Run \`raven setup\` to fix.`));
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    try {
      installer.resetProjectState();
      const r = installer.install();
      for (const c of r.changes) console.log(`${chalk.hex(t.ok)('\u2713')} ${c}`);
      if (!r.changes.length) console.log(`${chalk.hex(t.ok)('\u2713')} Already set up (${r.launcherFile})`);
      if (r.needsNewTerminal) {
        console.log(chalk.hex(t.primary)('\nThe launcher is installed in your user PATH.'));
        console.log(chalk.hex(t.primary)('For this already-open PowerShell, run:'));
        console.log(chalk.hex(t.accent)(`$env:Path = "$env:USERPROFILE\\.raven\\bin;$env:Path"`));
        console.log(chalk.hex(t.primary)('Or open a NEW terminal, then just type: raven'));
        if (process.platform !== 'win32') console.log(chalk.hex(t.dim)('(or run `exec $SHELL -l` in this one)'));
      } else console.log(chalk.hex(t.primary)('\nJust type: raven'));
    } catch (e) {
      console.log(chalk.hex(t.err)(`Setup failed: ${e.message}`));
      process.exitCode = 1;
    }
  });

program
  .command('uninstall')
  .description('Remove the `raven` launcher and PATH entry (and stop auto-repair).')
  .action(() => {
    const t = getTheme();
    const r = installer.uninstall();
    if (!r.removed.length) console.log('Nothing to remove.');
    for (const line of r.removed) console.log(`${chalk.hex(t.ok)('\u2713')} ${line}`);
    console.log(chalk.hex(t.dim)('Re-enable any time with: node bin/raven.js setup'));
  });

const skillsCmd = program.command('skills').description('Manage skills: list, create, fork, edit, validate, delete.');

skillsCmd
  .command('list')
  .option('--skills-root <path>', 'Folder containing skill subfolders.', DEFAULT_SKILLS_ROOT)
  .action((opts) => {
    const found = listSkills(opts.skillsRoot);
    if (!found.length) {
      console.log(chalk.yellow(`No skills found in ${opts.skillsRoot}`));
      return;
    }
    console.log(chalk.bold(`Skills in ${opts.skillsRoot}`));
    for (const info of found) console.log(`  ${chalk.bold.cyan(info.name)}  ${info.description}`);
  });

skillsCmd
  .command('create <name>')
  .requiredOption('--description <text>', 'When the model should reach for this skill.')
  .option('--skills-root <path>', 'Folder containing skill subfolders.', DEFAULT_SKILLS_ROOT)
  .action((name, opts) => {
    try {
      const p = createSkill(opts.skillsRoot, name, opts.description);
      console.log(`${chalk.green('Created')} ${p}\nEdit ${path.join(p, 'SKILL.md')} to fill it in, or run \`raven skills edit ${name}\`.`);
    } catch (e) {
      console.log(chalk.red(e.message));
      process.exitCode = 1;
    }
  });

skillsCmd
  .command('fork <sourceName> <newName>')
  .option('--skills-root <path>', 'Folder containing skill subfolders.', DEFAULT_SKILLS_ROOT)
  .action((sourceName, newName, opts) => {
    try {
      const p = duplicateSkill(opts.skillsRoot, sourceName, newName);
      console.log(`${chalk.green('Forked')} '${sourceName}' -> ${p}`);
    } catch (e) {
      console.log(chalk.red(e.message));
      process.exitCode = 1;
    }
  });

skillsCmd
  .command('edit <name>')
  .option('--skills-root <path>', 'Folder containing skill subfolders.', DEFAULT_SKILLS_ROOT)
  .action((name, opts) => {
    const info = findSkill(opts.skillsRoot, name);
    if (!info) {
      console.log(chalk.red(`No skill named '${name}' in ${opts.skillsRoot}`));
      process.exitCode = 1;
      return;
    }
    const editor = process.env.EDITOR || 'nano';
    const { spawnSync } = require('child_process');
    spawnSync(editor, [path.join(info.path, 'SKILL.md')], { stdio: 'inherit' });
  });

skillsCmd
  .command('validate <name>')
  .option('--skills-root <path>', 'Folder containing skill subfolders.', DEFAULT_SKILLS_ROOT)
  .action((name, opts) => {
    const info = findSkill(opts.skillsRoot, name);
    if (!info) {
      console.log(chalk.red(`No skill named '${name}' in ${opts.skillsRoot}`));
      process.exitCode = 1;
      return;
    }
    const problems = validateSkill(info.path);
    if (problems.length) {
      console.log(`${chalk.red('Invalid:')} ${name}`);
      for (const p of problems) console.log(`  - ${p}`);
    } else {
      console.log(`${chalk.green('Valid:')} ${name}`);
    }
  });

skillsCmd
  .command('delete <name>')
  .option('--skills-root <path>', 'Folder containing skill subfolders.', DEFAULT_SKILLS_ROOT)
  .option('-y, --yes', 'Skip the confirmation prompt.', false)
  .action(async (name, opts) => {
    if (!opts.yes) {
      const answer = await askLine('This permanently deletes the skill folder. Continue? [y/N]:');
      if (!['y', 'yes'].includes(answer.trim().toLowerCase())) return;
    }
    try {
      deleteSkill(opts.skillsRoot, name);
      console.log(`${chalk.green('Deleted')} ${name}`);
    } catch (e) {
      console.log(chalk.red(e.message));
      process.exitCode = 1;
    }
  });

program
  .command('completion <shell>')
  .description('Print the line to add to your shell for command/option auto-completion.')
  .action((shell) => {
    if (!['bash', 'zsh', 'fish'].includes(shell)) {
      console.log(chalk.red('shell must be one of: bash, zsh, fish'));
      process.exitCode = 1;
      return;
    }
    console.log(
      chalk.yellow(
        'Node/commander does not ship a completion generator equivalent to click\'s; ' +
          'this is a placeholder. See https://github.com/tj/commander.js for shell completion options.'
      )
    );
  });

if (require.main === module) {
  program.parseAsync(process.argv).catch((e) => {
    console.error(chalk.red(e.message));
    process.exitCode = 1;
  });
}

module.exports = { RavenCLI, formatElapsed: fmtElapsed };
