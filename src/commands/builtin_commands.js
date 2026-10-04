'use strict';
/** Built-in commands for Raven CLI. Port of Raven/commands/builtin_commands_new.py */

const fs = require('fs');
const path = require('path');
const os = require('os');

function splitMax(str, sep, maxSplits) {
  const parts = str.split(sep);
  if (parts.length <= maxSplits + 1) return parts;
  return [...parts.slice(0, maxSplits), parts.slice(maxSplits).join(sep)];
}

function registerBuiltinCommands(commandSystem, sessionManager, targetManager, taskQueue, configManager) {
  commandSystem.register('help', 'Show help for commands', (args, ctx) => cmdHelp(args, ctx, commandSystem), '[command]', ['/help', '/help config']);
  commandSystem.register('quit', 'Exit Raven', () => '', '', ['/quit'], ['exit', 'q']);
  commandSystem.register('new', 'Start a fresh conversation (keeps the screen)', (args, ctx) => cmdNew(args, ctx), '', ['/new'], ['reset']);
  commandSystem.register('model', 'Show or switch the model for this session', (args, ctx) => cmdModel(args, ctx), '[name]', ['/model', '/model llama3.1']);
  commandSystem.register('provider', 'Manage LLM providers and saved API keys', (args, ctx) => cmdProvider(args, ctx), '[list|add|key|remove] ...', ['/provider list', '/provider add openrouter openrouter https://openrouter.ai/api/v1', '/provider key openrouter main KEY']);
  commandSystem.register('route', 'Manage ordered model fallback routes', (args, ctx) => cmdRoute(args, ctx), '[list|add|remove|clear] ...', ['/route list', '/route add fast openrouter meta-llama/llama-3.1-70b-instruct main']);
  commandSystem.register('thinking', 'Choose how much reasoning is displayed', (args, ctx) => cmdThinking(args, ctx), '[on|off|full]', ['/thinking full']);
  commandSystem.register('theme', 'Change the color theme', (args, ctx) => cmdTheme(args, ctx), '[name]', ['/theme aurora']);
  commandSystem.register('undo', 'Revert the file changes of the last AI turn', (args, ctx) => cmdUndo(args, ctx, 'undo'), '[list|force|file]', ['/undo', '/undo list', '/undo src/app.js']);
  commandSystem.register('redo', 'Re-apply what /undo reverted', (args, ctx) => cmdUndo(args, ctx, 'redo'), '[force]', ['/redo']);
  commandSystem.register('resume', 'Resume a previous conversation', (args, ctx) => cmdResume(args, ctx), '[id|last|text]', ['/resume', '/resume last']);
  commandSystem.register('notify', 'Sound / desktop notifications', (args, ctx) => cmdNotify(args, ctx), '[sound|desktop|min|test]', ['/notify', '/notify sound off', '/notify min 15', '/notify test']);
  commandSystem.register('prompt', 'Choose the system prompt: lite (fast, on-demand skills) or full', (args, ctx) => cmdPrompt(args, ctx), '[lite|full]', ['/prompt', '/prompt full']);
  commandSystem.register('status', 'Show backend, model, skills and context size', (args, ctx) => cmdStatus(args, ctx), '', ['/status']);
  commandSystem.register('init', 'Create a RAVEN.md project memory file', (args, ctx) => cmdInit(args, ctx), '', ['/init']);
  commandSystem.register('compact', 'Compact older conversation context while keeping recent turns', (args, ctx) => cmdCompact(args, ctx), '', ['/compact']);

  commandSystem.register(
    'config',
    'Manage configuration (backend, API keys, etc.)',
    (args, ctx) => cmdConfig(args, ctx, configManager),
    '[set|show|reset] [key] [value]',
    ['/config show', '/config set backend ollama', '/config set api_key YOUR_KEY']
  );

  commandSystem.register('restart', 'Restart Raven with new configuration', (args, ctx) => cmdRestart(args, ctx), '', ['/restart']);

  commandSystem.register(
    'session',
    'Manage sessions',
    (args, ctx) => cmdSession(args, ctx, sessionManager),
    '[list|create|load|delete] [name/id]',
    ['/session list', '/session create investigation1', '/session load 20260926_201000']
  );

  commandSystem.register(
    'target',
    'Manage investigation targets',
    (args, ctx) => cmdTarget(args, ctx, targetManager),
    '[create|list|info|add] [args...]',
    ['/target create mathieu', '/target list']
  );

  commandSystem.register(
    'task',
    'Manage tasks',
    (args, ctx) => cmdTask(args, ctx, taskQueue),
    '[list|status|cancel|stats] [id]',
    ['/task list', '/task stats']
  );

  commandSystem.register(
    'skill',
    'Load and manage skills dynamically',
    (args, ctx) => cmdSkill(args, ctx),
    '[load|list|info] [skill_name]',
    ['/skill load raven-code', '/skill list', '/skill info frontend-design']
  );

  commandSystem.register('clear', 'Clear the screen (conversation is kept)', (args, ctx) => cmdClear(args, ctx), '', ['/clear']);

  commandSystem.register('files', 'List project files', (args, ctx) => cmdProjectFiles(args, ctx), '[pattern]', ['/files', '/files *.py']);
  commandSystem.register('find', 'Search text in the project', (args, ctx) => cmdProjectFind(args, ctx), '<text>', ['/find TODO']);
  commandSystem.register('diff', 'Show the diff for one project file', (args, ctx) => cmdProjectDiff(args, ctx), '<file>', ['/diff raven/cli.py']);
  commandSystem.register('git', 'Show Git status or diff', (args, ctx) => cmdProjectGit(args, ctx), '[status|diff|log]', ['/git status', '/git diff']);

  for (const [name, tool, description] of [
    ['test', 'run_tests', 'Run the project tests'],
    ['lint', 'run_linter', 'Run the project linter'],
    ['build', 'build_project', 'Build the project'],
  ]) {
    commandSystem.register(name, description, (args, ctx) => cmdProjectAction(tool, args, ctx), '[path|framework|tool]', [`/${name}`]);
  }

  commandSystem.register('context', 'Summarize the project structure and entry points', (args, ctx) => cmdProjectContext(args, ctx), '', ['/context']);
  commandSystem.register('run', 'Run a shell command after explicit confirmation', (args, ctx) => cmdProjectRun(args, ctx), '<command>', ['/run pytest', '/run npm test']);
  commandSystem.register('server', 'Manage Raven background servers', (args, ctx) => cmdServer(args, ctx), '[list|start|logs|stop|stop-all] ...', ['/server list', '/server start web | npm run dev | 3000', '/server stop web']);
  commandSystem.register('discord', 'Run the Discord-to-Raven bot bridge', (args, ctx) => cmdDiscord(args, ctx), '[start|stop|status|prefix|token|owner|channel] ...', ['/discord start', '/discord token BOT_TOKEN', '/discord owner 123']);
  commandSystem.register('telegram', 'Run the Telegram-to-Raven bot bridge', (args, ctx) => cmdTelegram(args, ctx), '[start|stop|status|prefix|token|owner|chat] ...', ['/telegram start', '/telegram token BOT_TOKEN', '/telegram owner 123']);
  commandSystem.register(
    'reminder',
    'Create, list or cancel persistent reminders',
    (args, ctx) => cmdReminder(args, ctx),
    '[add|list|cancel|export] ...',
    ['/reminder add Appeler Paul | in 20m', '/reminder list', '/reminder export calendar.ics']
  );

  for (const [name, description, handler, argsHelp] of [
    ['plan', 'Prepare an execution plan without changing files', cmdPlan, '<objective>'],
    ['doctor', 'Diagnose Raven and the current workspace', cmdDoctor, ''],
    ['timeline', 'Show recent Raven activity', cmdTimeline, ''],
    ['cost', 'Estimate the current context size', cmdCost, ''],
    ['approve', 'Show the safe approval workflow', cmdApprove, ''],
    ['watch', 'Inspect workspace changes', cmdWatch, ''],
    ['projects', 'Show the active project workspace', cmdProjects, ''],
  ]) {
    commandSystem.register(name, description, (args, ctx) => handler(args, ctx), argsHelp, [`/${name}`]);
  }
}

function cmdHelp(args, ctx, commandSystem) {
  if (args.trim()) return commandSystem.getHelp(args.trim().replace(/^\//, ''));
  const cmds = commandSystem.list().sort((a, b) => a.name.localeCompare(b.name));
  const width = Math.max(...cmds.map((c) => c.name.length)) + 2;
  let out = '[bold]Commands[/bold]\n';
  for (const c of cmds) out += `  [cyan]${`/${c.name}`.padEnd(width + 1)}[/cyan]${c.description}\n`;
  out += '\n[dim]Type / to open the command menu \u00b7 tab completes \u00b7 alt+enter for a new line \u00b7 esc interrupts[/dim]\n';
  out += '[dim]You can keep typing while Raven works: messages are queued.[/dim]';
  return out;
}

async function cmdNew(args, ctx) {
  const cli = ctx.cli;
  if (!cli || !cli.agent) return 'No active agent';
  cli.agent.reset();
  cli.agent.messages[0].content = cli.systemPrompt;
  cli.sessionManager.create('session');
  return '[green]Started a fresh conversation.[/green]';
}

async function cmdModel(args, ctx) {
  const cli = ctx.cli;
  if (!cli || !cli.backend) return 'No active backend';
  const name = args.trim();
  if (!name) return `Model: [cyan]${cli.backend.cfg.model}[/cyan]  (change with /model <name>)`;
  cli.backend.cfg.model = name;
  cli.config.backend.model = name;
  cli.configManager.save();
  cli._modelLabel = `${name} \u00b7 ${cli.config.backend.type}`;
  if (cli.ui) cli.ui.setFooterRight(cli._modelLabel);
  return `[green]Model set to ${name}[/green]`;
}

function maskSecret(value) {
  const s = String(value || '');
  if (!s) return 'not set';
  if (s.length <= 8) return '***';
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

function cmdProvider(args, ctx) {
  const cli = ctx.cli;
  if (!cli) return 'Provider config unavailable';
  const parts = splitMax(args.trim(), ' ', 4).filter(Boolean);
  const action = (parts[0] || 'list').toLowerCase();
  const cfg = cli.config;
  cfg.providers = cfg.providers || {};

  if (action === 'list') {
    const names = Object.keys(cfg.providers).sort();
    if (!names.length) return 'No saved providers yet.';
    return names.map((name) => {
      const p = cfg.providers[name] || {};
      const keys = Object.keys(p.api_keys || {});
      return `${name}  ${p.type || name}  ${p.base_url || '(preset URL)'}  keys: ${keys.length ? keys.join(', ') : 'none'}${p.default_key ? `  default: ${p.default_key}` : ''}`;
    }).join('\n');
  }

  if (action === 'add') {
    const [, name, type, baseUrl] = parts;
    if (!name || !type) return 'Usage: /provider add <name> <type> [base_url]';
    cfg.providers[name] = { ...(cfg.providers[name] || {}), type, base_url: baseUrl || (cfg.providers[name] && cfg.providers[name].base_url) || '', api_keys: (cfg.providers[name] && cfg.providers[name].api_keys) || {} };
    cli.configManager.save();
    return `[green]Provider saved:[/green] ${name}`;
  }

  if (action === 'key') {
    const [, name, keyName, keyValue] = parts;
    if (!name || !keyName || !keyValue) return 'Usage: /provider key <provider> <key_name> <api_key>';
    cfg.providers[name] = cfg.providers[name] || { type: name, base_url: '', api_keys: {} };
    cfg.providers[name].api_keys = cfg.providers[name].api_keys || {};
    cfg.providers[name].api_keys[keyName] = keyValue;
    cfg.providers[name].default_key = cfg.providers[name].default_key || keyName;
    cli.configManager.save();
    return `[green]API key saved:[/green] ${name}/${keyName} (${maskSecret(keyValue)})`;
  }

  if (action === 'default-key') {
    const [, name, keyName] = parts;
    if (!name || !keyName) return 'Usage: /provider default-key <provider> <key_name>';
    if (!cfg.providers[name] || !cfg.providers[name].api_keys || !cfg.providers[name].api_keys[keyName]) return `Unknown provider/key: ${name}/${keyName}`;
    cfg.providers[name].default_key = keyName;
    cli.configManager.save();
    return `[green]Default key set:[/green] ${name}/${keyName}`;
  }

  if (action === 'remove') {
    const [, name] = parts;
    if (!name) return 'Usage: /provider remove <name>';
    delete cfg.providers[name];
    cfg.model_routes = (cfg.model_routes || []).filter((r) => r.provider !== name);
    cli.configManager.save();
    return `[green]Provider removed:[/green] ${name}`;
  }

  return 'Usage: /provider [list|add|key|default-key|remove]';
}

function cmdRoute(args, ctx) {
  const cli = ctx.cli;
  if (!cli) return 'Route config unavailable';
  const parts = splitMax(args.trim(), ' ', 5).filter(Boolean);
  const action = (parts[0] || 'list').toLowerCase();
  cli.config.model_routes = cli.config.model_routes || [];

  if (action === 'list') {
    if (!cli.config.model_routes.length) return 'No model routes configured. Raven is using the single backend config.';
    return cli.config.model_routes.map((r, i) => `${i + 1}. ${r.enabled === false ? '[off] ' : ''}${r.name || '(unnamed)'}  ${r.provider}  ${r.model}${r.api_key ? `  key:${r.api_key}` : ''}${r.base_url ? `  ${r.base_url}` : ''}`).join('\n');
  }

  if (action === 'add') {
    const [, name, provider, model, apiKey, baseUrl] = parts;
    if (!name || !provider || !model) return 'Usage: /route add <name> <provider> <model> [api_key_name] [base_url]';
    cli.config.model_routes.push({ name, provider, model, api_key: apiKey || '', base_url: baseUrl || '', enabled: true });
    cli.configManager.save();
    return `[green]Route added:[/green] ${name}. Restart Raven to activate the new route order.`;
  }

  if (action === 'remove') {
    const idx = Number(parts[1]);
    if (!Number.isInteger(idx) || idx < 1 || idx > cli.config.model_routes.length) return 'Usage: /route remove <number>';
    const [removed] = cli.config.model_routes.splice(idx - 1, 1);
    cli.configManager.save();
    return `[green]Route removed:[/green] ${removed.name || idx}. Restart Raven to apply.`;
  }

  if (action === 'clear') {
    cli.config.model_routes = [];
    cli.configManager.save();
    return '[green]Routes cleared.[/green] Restart Raven to use the single backend config.';
  }

  return 'Usage: /route [list|add|remove|clear]';
}

function cmdThinking(args, ctx) {
  const cli = ctx.cli;
  if (!cli) return 'Unavailable';
  const mode = args.trim().toLowerCase();
  if (!mode) return `Reasoning display: [cyan]${cli.thinkingMode}[/cyan]  (on | off | full)`;
  if (!['on', 'off', 'full'].includes(mode)) return 'Usage: /thinking [on|off|full]';
  cli.thinkingMode = mode;
  cli.config.show_thinking = mode !== 'off';
  cli.configManager.save();
  return `[green]Reasoning display: ${mode}[/green]`;
}

function cmdTheme(args, ctx) {
  const { THEMES, setTheme, gradientLine } = require('../style');
  const name = args.trim().toLowerCase();
  if (!name) {
    let out = 'Themes:\n';
    for (const [n, t] of Object.entries(THEMES)) out += `  ${n.padEnd(8)} ${gradientLine('\u2588'.repeat(18), t.gradient)}  ${t.label}\n`;
    return out + '\nUsage: /theme <name>';
  }
  if (!THEMES[name]) return `[red]Unknown theme '${name}'.[/red] Available: ${Object.keys(THEMES).join(', ')}`;
  setTheme(name);
  const cli = ctx.cli;
  if (cli) {
    cli.config.theme = name;
    cli.configManager.save();
  }
  return `[green]Theme: ${name}[/green]  ${gradientLine('\u2588'.repeat(24), THEMES[name].gradient)}`;
}

function cmdUndo(args, ctx, direction) {
  const chalk = require('chalk');
  const { fileHistory } = require('../file_history');
  const { renderChange } = require('../tui/diff');
  const { getTheme } = require('../style');
  const t = getTheme();
  const cli = ctx.cli;
  const show = (p) => (cli && cli._displayPath ? cli._displayPath(p) : p);
  const arg = args.trim().toLowerCase();

  if (direction === 'undo' && arg === 'list') {
    if (!fileHistory.undoStack.length) return 'Nothing to undo yet. (Only file changes made by Raven\'s file tools are tracked.)';
    const lines = [];
    fileHistory.undoStack.slice().reverse().forEach((e, i) => {
      const time = new Date(e.time).toTimeString().slice(0, 5);
      lines.push(`${chalk.hex(t.accent)(i === 0 ? '\u2192' : ' ')} ${chalk.hex(t.dim)(time)}  ${e.label}  ${chalk.hex(t.dim)(`${e.changes.length} file(s): ${e.changes.map((c) => show(c.path)).slice(0, 3).join(', ')}`)}`);
    });
    return { raw: `${lines.join('\n')}\n${chalk.hex(t.dim)('/undo reverts the top entry')}` };
  }

  // `/undo <file>` keeps the older behaviour: restore one file from its backup.
  if (direction === 'undo' && arg && !['force', '--force'].includes(arg)) return cmdUndoFile(args, ctx);

  const force = arg === 'force' || arg === '--force';
  const r = direction === 'undo' ? fileHistory.undo(force) : fileHistory.redo(force);
  if (r.status === 'empty') return direction === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.';
  if (r.status === 'conflict') {
    return { raw: `${chalk.hex(t.warn)(`Cannot ${direction}: these files changed since Raven edited them:`)}\n${r.conflicts.map((p) => `  ${show(p)}`).join('\n')}\n${chalk.hex(t.dim)(`Use /${direction} force to overwrite them anyway.`)}` };
  }
  const cols = process.stdout.columns || 80;
  const out = [chalk.hex(t.ok)(`${direction === 'undo' ? 'Reverted' : 'Re-applied'}: ${r.entry.label}`)];
  for (const res of r.results) {
    if (res.status !== 'ok') {
      out.push(chalk.hex(t.err)(`  ${show(res.path)}: ${res.error}`));
      continue;
    }
    out.push(...renderChange({ path: res.path, before: res.before, after: res.after }, { width: cols - 4, displayPath: show(res.path), maxLines: 20 }).map((l) => `  ${l}`));
  }
  return { raw: out.join('\n') };
}

async function cmdResume(args, ctx) {
  const cli = ctx.cli;
  if (!cli || !cli.agent) return 'No active agent';
  const items = cli._sessionItems();
  if (!items.length) return 'No saved conversations yet.';
  const q = args.trim();
  let id = null;
  if (!q) {
    id = await cli.ui.select('Resume a conversation', items);
    if (!id) return 'Cancelled.';
  } else if (q === 'last') {
    id = items[0].value;
  } else if (/^\d+$/.test(q) && Number(q) >= 1 && Number(q) <= items.length) {
    id = items[Number(q) - 1].value;
  } else {
    const lower = q.toLowerCase();
    const hit = items.find((i) => i.value === q) || items.find((i) => i.value.startsWith(q)) || items.find((i) => i.label.toLowerCase().includes(lower));
    if (!hit) return `No conversation matches '${q}'. Type /resume to pick one.`;
    id = hit.value;
  }
  if (!cli.resumeSession(id)) return 'Could not load that conversation.';
  return '';
}

async function cmdNotify(args, ctx) {
  const cli = ctx.cli;
  if (!cli) return 'Unavailable';
  const cfg = cli.config.notifications;
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const onOff = (v) => (v === 'on' || v === 'true' ? true : v === 'off' || v === 'false' ? false : null);
  const save = () => cli.configManager.save();

  if (parts[0] === 'test') {
    const { Notifier } = require('../notify');
    const n = new Notifier(() => ({ ...cfg, sound: true, min_seconds: 0 }));
    await n.notify('done', { title: 'Raven', body: 'Test: task finished', seconds: 99 });
    await new Promise((r) => setTimeout(r, 900));
    await n.notify('attention', { title: 'Raven needs your approval', body: 'Test: approval needed' });
    return 'Played the \u201cdone\u201d and \u201cattention\u201d sounds.';
  }
  if (parts[0] === 'min') {
    const n = Number(parts[1]);
    if (!Number.isFinite(n) || n < 0) return 'Usage: /notify min <seconds>';
    cfg.min_seconds = n;
    save();
    return `[green]Notify for tasks longer than ${n}s[/green]`;
  }
  if (['sound', 'desktop'].includes(parts[0])) {
    const v = onOff(parts[1]);
    if (v === null) return `Usage: /notify ${parts[0]} on|off`;
    cfg[parts[0]] = v;
    save();
    return `[green]${parts[0]} notifications: ${v ? 'on' : 'off'}[/green]`;
  }
  if (onOff(parts[0]) !== null) {
    cfg.sound = onOff(parts[0]);
    save();
    return `[green]Sound notifications: ${cfg.sound ? 'on' : 'off'}[/green]`;
  }
  return [
    `Sound    [cyan]${cfg.sound ? 'on' : 'off'}[/cyan]`,
    `Desktop  [cyan]${cfg.desktop ? 'on' : 'off'}[/cyan]  [dim](macOS, Linux)[/dim]`,
    `Min time [cyan]${cfg.min_seconds}s[/cyan]  [dim]tasks shorter than this stay silent; approval prompts always notify[/dim]`,
    '[dim]/notify sound on|off \u00b7 /notify desktop on|off \u00b7 /notify min <sec> \u00b7 /notify test[/dim]',
  ].join('\n');
}

function cmdPrompt(args, ctx) {
  const cli = ctx.cli;
  if (!cli || !cli.agent) return 'No active agent';
  const mode = args.trim().toLowerCase();
  if (!mode) {
    const tokens = Math.round(cli.systemPrompt.length / 4);
    return `Prompt mode: [cyan]${cli.promptMode}[/cyan]  (~${tokens} tokens)\n[dim]lite = compact tools + skills loaded on demand \u00b7 full = all default skills always loaded[/dim]`;
  }
  if (!['lite', 'full'].includes(mode)) return 'Usage: /prompt [lite|full]';
  const tokens = cli.setPromptMode(mode);
  return `[green]Prompt mode: ${mode}[/green]  (~${tokens} tokens)`;
}

async function cmdStatus(args, ctx) {
  const cli = ctx.cli;
  if (!cli || !cli.agent) return 'No active agent';
  const chars = cli.agent.messages.reduce((a, m) => a + String(m.content || '').length, 0);
  const rows = [
    ['Backend', cli.config.backend.type],
    ['Model', cli.backend.cfg.model],
    ['Endpoint', cli.backend.cfg.base_url],
    ['Routes', cli.config.model_routes && cli.config.model_routes.length ? `${cli.config.model_routes.filter((r) => r.enabled !== false).length} active` : 'single backend'],
    ['Prompt', `${cli.promptMode} \u00b7 ~${Math.ceil(cli.systemPrompt.length / 3.5)} tokens`],
    ['Skills', [...cli.loadedSkillNames].join(', ') || '(loaded on demand)'],
    ['Tools', String(cli.toolRegistry.list().length)],
    ['Context', `${cli.agent.messages.length} messages \u00b7 ~${Math.ceil(chars / 3.5)} tokens`],
    ['Workspace', cli.projectTools.root],
    ['Reasoning', cli.thinkingMode],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `[dim]${k.padEnd(w)}[/dim]  ${v}`).join('\n');
}

function cmdInit(args, ctx) {
  const cli = ctx.cli;
  if (!cli || !cli.projectContext) return 'Project context unavailable';
  const result = cli.projectContext.init();
  return result.created ? `[green]Created ${result.path}[/green]` : `[dim]Already exists: ${result.path}[/dim]`;
}

function cmdCompact(args, ctx) {
  const cli = ctx.cli;
  if (!cli || !cli.agent) return 'No active agent context';
  const before = cli.agent.messages.length;
  const system = cli.agent.messages[0];
  const recent = cli.agent.messages.slice(-6).filter((m) => m !== system);
  const dropped = Math.max(0, before - recent.length - 1);
  cli.agent.messages = [system, {
    role: 'user',
    content: `[Context compacted: ${dropped} earlier messages summarized. Keep the current objective, decisions, risks, and latest evidence.]`,
    tool_calls: null,
    timestamp: new Date().toISOString(),
  }, ...recent];
  return `[green]Context compacted[/green]  ${before} -> ${cli.agent.messages.length} messages`;
}

async function cmdConfig(args, ctx, configManager) {
  const raw = args.trim().split(/\s+/).filter(Boolean);

  if (!raw.length || raw[0] === 'show') {
    return showConfig(configManager);
  }

  if (raw[0] === 'set') {
    if (raw.length < 3) {
      return 'Usage: /config set <key> <value>\nKeys: backend, model, base_url, api_key, vt_key, abuse_key, shodan_key';
    }
    const key = raw[1];
    const value = raw.slice(2).join(' ');
    const cfg = configManager.get();

    if (key === 'backend') {
      cfg.backend.type = value;
      configManager.save();
      return `Backend set to: ${value}`;
    }
    if (key === 'model') {
      cfg.backend.model = value;
      configManager.save();
      return `Model set to: ${value}`;
    }
    if (key === 'base_url') {
      cfg.backend.base_url = value;
      configManager.save();
      return `Base URL set to: ${value}`;
    }
    if (key === 'api_key') {
      cfg.backend.api_key = value;
      configManager.save();
      return 'API key set (hidden)';
    }
    if (key === 'vt_key') {
      cfg.api_keys.virustotal = value;
      configManager.save();
      return 'VirusTotal API key set (hidden)';
    }
    if (key === 'abuse_key') {
      cfg.api_keys.abuseipdb = value;
      configManager.save();
      return 'AbuseIPDB API key set (hidden)';
    }
    if (key === 'shodan_key') {
      cfg.api_keys.shodan = value;
      configManager.save();
      return 'Shodan API key set (hidden)';
    }
    return `Unknown key: ${key}`;
  }

  if (raw[0] === 'reset') {
    configManager.reset();
    return 'Configuration reset to defaults';
  }

  return 'Usage: /config [show|set|reset]';
}

function showConfig(configManager) {
  const config = configManager.get();
  const rows = [
    ['Backend Type', config.backend.type],
    ['Model', config.backend.model],
    ['Base URL', config.backend.base_url || 'default'],
    ['API Key', config.backend.api_key ? '***' : 'not set'],
    ['Providers', String(Object.keys(config.providers || {}).length)],
    ['Model Routes', String((config.model_routes || []).length)],
    ['Temperature', String(config.backend.temperature)],
    ['VirusTotal Key', config.api_keys.virustotal ? '***' : 'not set'],
    ['AbuseIPDB Key', config.api_keys.abuseipdb ? '***' : 'not set'],
    ['Shodan Key', config.api_keys.shodan ? '***' : 'not set'],
    ['Discord Bot', config.discord && (config.discord.token || config.discord.token_env) ? `configured (${(config.discord.owner_ids || []).length} owner(s))` : 'not set'],
    ['Telegram Bot', config.telegram && (config.telegram.token || config.telegram.token_env) ? `configured (${(config.telegram.owner_ids || []).length} owner(s))` : 'not set'],
    ['Max Concurrent Tasks', String(config.tasks.max_concurrent)],
    ['Queue Size', String(config.tasks.queue_size)],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  let out = 'Current Configuration\n';
  for (const [k, v] of rows) out += `  ${k.padEnd(width)}  ${v}\n`;
  return out;
}

function cmdRestart() {
  return 'Restarting... (handled by CLI)';
}

function cmdSession(args, ctx, sessionManager) {
  const parts = splitMax(args.trim(), ' ', 1).filter(Boolean);

  if (!parts.length || parts[0] === 'list') {
    const sessions = sessionManager.list();
    if (!sessions.length) return 'No sessions found';
    let output = 'Sessions:\n';
    for (const session of sessions.slice(0, 10)) {
      output += `  ${session.id} - ${session.name} (${session.created_at})\n`;
    }
    return output;
  }

  if (parts[0] === 'create') {
    if (parts.length < 2) return 'Usage: /session create <name>';
    const session = sessionManager.create(parts[1]);
    return `Session created: ${session.id}`;
  }

  if (parts[0] === 'load') {
    if (parts.length < 2) return 'Usage: /session load <id>';
    const cliInstance = ctx.cli;
    const session = cliInstance && cliInstance.restoreSessionContext
      ? cliInstance.restoreSessionContext(parts[1])
      : sessionManager.load(parts[1]);
    if (session) return `Session loaded: ${session.name} (${session.entries.length} messages restored)`;
    return 'Session not found';
  }

  if (parts[0] === 'delete') {
    if (parts.length < 2) return 'Usage: /session delete <id>';
    if (sessionManager.delete(parts[1])) return 'Session deleted';
    return 'Session not found';
  }

  return 'Usage: /session [list|create|load|delete]';
}

function cmdTarget(args, ctx, targetManager) {
  const parts = splitMax(args.trim(), ' ', 2).filter(Boolean);

  if (!parts.length || parts[0] === 'list') {
    const targets = targetManager.list();
    if (!targets.length) return 'No targets found';
    let output = 'Targets:\n';
    for (const target of targets) output += `  ${target.name} (${target.identifiers.length} identifiers)\n`;
    return output;
  }

  if (parts[0] === 'create') {
    if (parts.length < 2) return 'Usage: /target create <name>';
    const target = targetManager.create(parts[1]);
    return `Target created: ${target.name}`;
  }

  if (parts[0] === 'info') {
    if (parts.length < 2) return 'Usage: /target info <name>';
    const target = targetManager.get(parts[1]);
    if (!target) return 'Target not found';
    let output = `Target: ${target.name}\n`;
    output += `Created: ${target.created_at}\n`;
    output += `Identifiers: ${target.identifiers.length}\n`;
    output += `Notes: ${target.notes.length}\n`;
    output += `Research entries: ${target.research.length}\n`;
    return output;
  }

  if (parts[0] === 'add') {
    if (parts.length < 4) return 'Usage: /target add <name> <type> <value>';
    if (targetManager.addIdentifier(parts[1], parts[2], parts[3])) return `Identifier added to ${parts[1]}`;
    return 'Target not found or error adding identifier';
  }

  return 'Usage: /target [list|create|info|add]';
}

function cmdTask(args, ctx, taskQueue) {
  const parts = splitMax(args.trim(), ' ', 1).filter(Boolean);

  if (!parts.length || parts[0] === 'list') {
    const tasks = taskQueue.list();
    if (!tasks.length) return 'No tasks found';
    let output = 'Tasks:\n';
    for (const task of tasks.slice(0, 10)) output += `  ${task.id} - ${task.name} (${task.status})\n`;
    return output;
  }

  if (parts[0] === 'stats') {
    const stats = taskQueue.getStats();
    let output = 'Task Statistics:\n';
    for (const [key, value] of Object.entries(stats)) output += `  ${key}: ${value}\n`;
    return output;
  }

  if (parts[0] === 'status') {
    if (parts.length < 2) return 'Usage: /task status <task_id>';
    const status = taskQueue.getStatus(parts[1]);
    if (!status) return 'Task not found';
    return JSON.stringify(status);
  }

  if (parts[0] === 'cancel') {
    if (parts.length < 2) return 'Usage: /task cancel <task_id>';
    if (taskQueue.cancel(parts[1])) return 'Task cancelled';
    return 'Task not found or cannot be cancelled';
  }

  return 'Usage: /task [list|stats|status|cancel]';
}

function cmdClear(args, ctx) {
  const ui = ctx && ctx.cli && ctx.cli.ui;
  if (ui && typeof ui.clearScreen === 'function') ui.clearScreen();
  else process.stdout.write(process.platform === 'win32' ? '\x1Bc' : '\x1b[2J\x1b[3J\x1b[H');
  return '';
}

function cmdProjectFiles(args, ctx) {
  const cli = ctx.cli;
  if (!cli) return 'Project context unavailable';
  const pattern = args.trim() || '*';
  const files = cli.projectTools.files(pattern);
  return files.length ? files.join('\n') : 'No matching files';
}

function cmdProjectFind(args, ctx) {
  const cli = ctx.cli;
  const query = args.trim();
  if (!cli || !query) return 'Usage: /find <text>';
  const results = cli.projectTools.search(query);
  return results.length ? results.map((r) => `${r.file}:${r.line}  ${r.text}`).join('\n') : 'No matches';
}

async function cmdProjectDiff(args, ctx) {
  const cli = ctx.cli;
  const p = args.trim();
  if (!cli || !p) return 'Usage: /diff <file>';
  const result = await cli.projectTools.diffFile(p);
  if (!result.success) return result.error || 'Unable to read diff';
  return result.output || 'No Git changes for this file';
}

async function cmdProjectGit(args, ctx) {
  const cli = ctx.cli;
  const action = args.trim() || 'status';
  if (!['status', 'diff', 'log'].includes(action)) return 'Usage: /git [status|diff|log]';
  const gitArgs = [action];
  if (action === 'log') gitArgs.push('--oneline', '-10');
  const result = await cli.projectTools.git(...gitArgs);
  return result.output || result.error || 'No output';
}

async function cmdUndoFile(args, ctx) {
  const p = args.trim();
  const cli = ctx.cli;
  if (!cli || !p) return 'Usage: /undo <file>';
  const result = await cli.toolRegistry.execute('undo_file', { path: p });
  return result.error || `Restored ${result.path || p}`;
}

async function cmdProjectAction(tool, args, ctx) {
  const cli = ctx.cli;
  if (!cli) return 'Project context unavailable';
  const result = await cli.toolRegistry.execute(tool, {});
  if (result.error) return result.error;
  const output = result.output || result.errors || 'completed';
  return String(output);
}

function cmdProjectContext(args, ctx) {
  const cli = ctx.cli;
  if (!cli) return 'Project context unavailable';
  const files = cli.projectTools.files();
  const importantNames = new Set(['readme.md', 'pyproject.toml', 'package.json', 'cargo.toml', 'dockerfile']);
  const important = files.filter((f) => importantNames.has(path.basename(f).toLowerCase()));
  return (
    `Project: ${cli.projectTools.root}\n` +
    `Files: ${files.length}\n` +
    'Entry points:\n' +
    (important.length ? important.map((p) => `  ${p}`).join('\n') : '  none detected')
  );
}

async function cmdProjectRun(args, ctx) {
  const command = args.trim();
  const cli = ctx.cli;
  if (!cli || !command) return 'Usage: /run <command>';
  const result = await cli.toolRegistry.execute('execute_command', { command });
  return result.output || result.error || JSON.stringify(result);
}

async function cmdServer(args, ctx) {
  const cli = ctx.cli;
  if (!cli) return 'Server manager unavailable';
  const parts = splitMax(args.trim(), '|', 3).map((p) => p.trim());
  const head = parts[0].split(/\s+/).filter(Boolean);
  const action = (head[0] || 'list').toLowerCase();

  if (action === 'list') {
    const result = await cli.toolRegistry.execute('server_list', {});
    const servers = result.servers || [];
    if (!servers.length) return 'No Raven background servers.';
    return servers.map((s) => `${s.running ? 'running' : 'stopped'}  ${s.id}  pid:${s.pid || '-'}${s.port ? `  port:${s.port}` : ''}  ${s.command}`).join('\n');
  }

  if (action === 'start') {
    const name = head[1] || parts[1] || '';
    const command = parts.length > 1 ? parts[1] : head.slice(2).join(' ');
    const port = parts[2] ? Number(parts[2]) : undefined;
    if (!command) return 'Usage: /server start <name> | <command> | [port]';
    const result = await cli.toolRegistry.execute('server_start', { name, command, port });
    return JSON.stringify(result);
  }

  if (action === 'logs') {
    const id = head[1];
    if (!id) return 'Usage: /server logs <id> [lines]';
    const result = await cli.toolRegistry.execute('server_logs', { id, lines: Number(head[2]) || 80 });
    if (result.error) return result.error;
    return (result.logs || []).map((l) => `${l.stream} ${l.line}`).join('\n') || 'No logs yet.';
  }

  if (action === 'stop') {
    const id = head[1];
    if (!id) return 'Usage: /server stop <id>';
    return JSON.stringify(await cli.toolRegistry.execute('server_stop', { id }));
  }

  if (action === 'stop-all') return JSON.stringify(await cli.toolRegistry.execute('server_stop_all', {}));

  return 'Usage: /server [list|start|logs|stop|stop-all]';
}

async function cmdDiscord(args, ctx) {
  const cli = ctx.cli;
  if (!cli) return 'Discord bridge unavailable';
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const action = (parts[0] || 'status').toLowerCase();
  const cfg = cli.config.discord || {};
  cfg.prefix = cfg.prefix || '!raven';
  cfg.owner_ids = cfg.owner_ids || [];
  cfg.channel_ids = cfg.channel_ids || [];
  cli.config.discord = cfg;

  if (action === 'prefix') {
    if (!parts[1]) return `Discord prefix: ${cfg.prefix}`;
    cfg.prefix = parts[1];
    cli.configManager.save();
    return `[green]Discord prefix:[/green] ${cfg.prefix}`;
  }
  if (action === 'token') {
    if (!parts[1]) return `Discord token: ${cfg.token ? maskSecret(cfg.token) : `env:${cfg.token_env || 'DISCORD_BOT_TOKEN'}`}`;
    cfg.token = parts.slice(1).join(' ');
    cfg.enabled = true;
    cli.configManager.save();
    return `[green]Discord bot token saved:[/green] ${maskSecret(cfg.token)}`;
  }
  if (action === 'token-env') {
    if (!parts[1]) return `Discord token env: ${cfg.token_env || 'DISCORD_BOT_TOKEN'}`;
    cfg.token_env = parts[1];
    cfg.enabled = true;
    cli.configManager.save();
    return `[green]Discord token env:[/green] ${cfg.token_env}`;
  }
  if (action === 'owner') {
    if (!parts[1]) return `Discord owners: ${cfg.owner_ids.join(', ') || 'none'}`;
    cfg.owner_ids = [...new Set([...cfg.owner_ids.map(String), parts[1]])];
    cfg.enabled = true;
    cli.configManager.save();
    return `[green]Discord owner added:[/green] ${parts[1]}`;
  }
  if (action === 'channel') {
    if (!parts[1]) return `Discord channels: ${cfg.channel_ids.join(', ') || 'none'}`;
    cfg.channel_ids = [...new Set([...cfg.channel_ids.map(String), parts[1]])];
    cfg.enabled = true;
    cli.configManager.save();
    return `[green]Discord channel added:[/green] ${parts[1]}`;
  }

  const token = process.env[cfg.token_env || 'DISCORD_BOT_TOKEN'] || cfg.token || '';
  if (!token) return `No Discord bot token. Set ${cfg.token_env || 'DISCORD_BOT_TOKEN'} or configure discord.token_env.`;
  if (!cfg.channel_ids || !cfg.channel_ids.length) return 'No Discord channels configured. Use discord_configure_scope or edit config.discord.channel_ids.';

  const { DiscordTools, getDiscordBridge } = require('../discord_bot_tools');
  const discord = new DiscordTools(token, String(cfg.guild_id || ''), (cfg.channel_ids || []).map(String));
  const bridge = getDiscordBridge(discord, cli, { prefix: cfg.prefix, poll_ms: cfg.poll_ms || 3500, owner_ids: cfg.owner_ids || [], use_gateway: cfg.use_gateway !== false });

  if (action === 'start') return JSON.stringify(await bridge.start());
  if (action === 'stop') return JSON.stringify(bridge.stop());
  if (action === 'status') return JSON.stringify(bridge.status());
  return 'Usage: /discord [start|stop|status|prefix]';
}

async function cmdTelegram(args, ctx) {
  const cli = ctx.cli;
  if (!cli) return 'Telegram bridge unavailable';
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const action = (parts[0] || 'status').toLowerCase();
  const cfg = cli.config.telegram || {};
  cfg.prefix = cfg.prefix || '/raven';
  cfg.owner_ids = cfg.owner_ids || [];
  cfg.chat_ids = cfg.chat_ids || [];
  cli.config.telegram = cfg;

  if (action === 'prefix') {
    if (!parts[1]) return `Telegram prefix: ${cfg.prefix}`;
    cfg.prefix = parts[1];
    cli.configManager.save();
    return `[green]Telegram prefix:[/green] ${cfg.prefix}`;
  }
  if (action === 'token') {
    if (!parts[1]) return `Telegram token: ${cfg.token ? maskSecret(cfg.token) : `env:${cfg.token_env || 'TELEGRAM_BOT_TOKEN'}`}`;
    cfg.token = parts.slice(1).join(' ');
    cfg.enabled = true;
    cli.configManager.save();
    return `[green]Telegram bot token saved:[/green] ${maskSecret(cfg.token)}`;
  }
  if (action === 'token-env') {
    if (!parts[1]) return `Telegram token env: ${cfg.token_env || 'TELEGRAM_BOT_TOKEN'}`;
    cfg.token_env = parts[1];
    cfg.enabled = true;
    cli.configManager.save();
    return `[green]Telegram token env:[/green] ${cfg.token_env}`;
  }
  if (action === 'owner') {
    if (!parts[1]) return `Telegram owners: ${cfg.owner_ids.join(', ') || 'none'}`;
    cfg.owner_ids = [...new Set([...cfg.owner_ids.map(String), parts[1]])];
    cfg.enabled = true;
    cli.configManager.save();
    return `[green]Telegram owner added:[/green] ${parts[1]}`;
  }
  if (action === 'chat') {
    if (!parts[1]) return `Telegram chats: ${cfg.chat_ids.join(', ') || 'none'}`;
    cfg.chat_ids = [...new Set([...cfg.chat_ids.map(String), parts[1]])];
    cfg.enabled = true;
    cli.configManager.save();
    return `[green]Telegram chat added:[/green] ${parts[1]}`;
  }

  const token = process.env[cfg.token_env || 'TELEGRAM_BOT_TOKEN'] || cfg.token || '';
  if (!token) return `No Telegram bot token. Set ${cfg.token_env || 'TELEGRAM_BOT_TOKEN'} or run /telegram token <token>.`;

  const { getTelegramBridge } = require('../telegram_bot_tools');
  const bridge = getTelegramBridge(token, cli, { prefix: cfg.prefix, chat_ids: cfg.chat_ids || [], owner_ids: cfg.owner_ids || [], polling: cfg.polling !== false });
  if (action === 'start') return JSON.stringify(await bridge.start());
  if (action === 'stop') return JSON.stringify(bridge.stop());
  if (action === 'status') return JSON.stringify(bridge.status());
  return 'Usage: /telegram [start|stop|status|prefix|token|token-env|owner|chat]';
}

async function cmdSkill(args, ctx) {
  const cliInstance = ctx.cli;
  const parts = splitMax(args.trim(), ' ', 2).filter(Boolean);
  const skillsRoot = cliInstance ? cliInstance.skillsRoot : path.join(process.cwd(), 'skills');

  if (!parts.length || parts[0] === 'list') {
    const { listSkills } = require('../skills_manager');
    const skills = listSkills(skillsRoot);
    if (!skills.length) return 'No skills found in skills/ directory';
    let output = 'Available skills:\n';
    for (const skill of skills) output += `  [cyan]${skill.name}[/cyan] - ${skill.description}\n`;
    return output;
  }

  if (parts.length >= 2 && ['enable', 'disable'].includes(parts[1])) {
    const skillName = parts[0];
    const enabled = parts[1] === 'enable';
    if (!cliInstance) return 'Error: CLI instance not available';
    const [success, message] = await cliInstance.setSkillEnabled(skillName, enabled);
    return success ? `[green]${message}[/green]` : `[red]${message}[/red]`;
  }

  if (['enable', 'disable'].includes(parts[0])) {
    if (parts.length < 2) return `Usage: /skill <name> ${parts[0]}`;
    const skillName = parts[1];
    const enabled = parts[0] === 'enable';
    if (!cliInstance) return 'Error: CLI instance not available';
    const [success, message] = await cliInstance.setSkillEnabled(skillName, enabled);
    return success ? `[green]${message}[/green]` : `[red]${message}[/red]`;
  }

  let skillName;
  if (parts[0] === 'load') {
    if (parts.length < 2) return 'Usage: /skill load <skill_name>';
    skillName = parts[1];
  } else {
    skillName = parts[0];
  }

  if (!cliInstance) return 'Error: CLI instance not available for dynamic skill loading';

  const [success, message] = await cliInstance.loadSkill(skillName);
  return success ? `[green]${message}[/green]` : `[red]${message}[/red]`;
}

async function cmdReminder(args, ctx) {
  const cli = ctx.cli;
  if (!cli) return 'Reminder system unavailable';
  const parts = splitMax(args.trim(), ' ', 1).filter(Boolean);
  const action = (parts[0] || 'list').toLowerCase();

  if (action === 'list') {
    const result = await cli.toolRegistry.execute('reminder_list', {});
    const items = Array.isArray(result) ? result : result.result || result;
    if (!items || !items.length) return 'No active reminders';
    return items.map((item) => `${item.id}  ${item.run_at}  ${item.title}`).join('\n');
  }
  if (action === 'add' && parts.length > 1) {
    const fields = splitMax(parts[1], '|', 1).map((v) => v.trim());
    if (fields.length !== 2) return 'Usage: /reminder add <title> | <when>';
    const result = await cli.toolRegistry.execute('reminder_create', { title: fields[0], when: fields[1] });
    return String(result.error || result.reminder || JSON.stringify(result));
  }
  if (action === 'cancel' && parts.length > 1) {
    const result = await cli.toolRegistry.execute('reminder_cancel', { reminder_id: parts[1].trim() });
    return String(result.error || JSON.stringify(result));
  }
  if (action === 'export' && parts.length > 1) {
    const result = await cli.toolRegistry.execute('calendar_export_ics', { output: parts[1].trim() });
    return String(result.error || JSON.stringify(result));
  }
  return 'Usage: /reminder [list|add <title> | <when>|cancel <id>|export <file.ics>]';
}

function cmdPlan(args) {
  const objective = args.trim();
  if (!objective) return 'Usage: /plan <objective>';
  return (
    'PLAN ONLY\n1. Inspect the workspace and relevant files\n2. Identify constraints and risks\n' +
    `3. Propose the smallest implementation steps\n4. Define verification commands\n\nObjective: ${objective}\nNo files were changed.`
  );
}

function cmdDoctor(args, ctx) {
  const cli = ctx.cli;
  if (!cli) return 'Raven CLI unavailable';
  const checks = {
    backend: Boolean(cli.backend),
    tools: cli.toolRegistry.list().length,
    workspace: cli.projectTools.root,
    skills: cli._availableSkillNames().length,
  };
  return Object.entries(checks).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function cmdTimeline() {
  const p = path.join(os.homedir(), '.raven', 'audit.log');
  if (!fs.existsSync(p)) return 'No Raven activity recorded yet';
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  return lines.slice(-31, -1).join('\n');
}

async function cmdCost(args, ctx) {
  const cli = ctx.cli;
  if (!cli || !cli.agent) return 'No active agent context';
  const text = cli.agent.messages.map((m) => String(m.content || '')).join('\n');
  const result = await cli.toolRegistry.execute('context_budget', { text });
  const usage = cli.agent.usage || {};
  return JSON.stringify({
    context: result,
    session_usage: usage,
    note: 'Estimation locale; un fournisseur OpenAI-compatible peut fournir usage.prompt_tokens/completion_tokens.',
  }, null, 2);
}

function cmdApprove() {
  return 'Sensitive actions use a human-only confirmation code. Raven never accepts approval from model output.';
}

async function cmdWatch(args, ctx) {
  const cli = ctx.cli;
  if (!cli) return 'Workspace unavailable';
  const result = await cli.toolRegistry.execute('project_map', { max_depth: 2 });
  return JSON.stringify(result);
}

function cmdProjects(args, ctx) {
  const cli = ctx.cli;
  return cli ? cli.projectTools.root : 'Workspace unavailable';
}

module.exports = { registerBuiltinCommands };
