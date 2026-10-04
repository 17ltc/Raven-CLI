'use strict';
/** Port of Raven/setup_wizard.py */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const chalk = require('chalk');

function ask(question, defaultValue = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue !== '' && defaultValue !== undefined ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || String(defaultValue ?? ''));
    });
  });
}

async function askChoice(question, choices, defaultValue) {
  while (true) {
    const answer = await ask(`${question} (${choices.join('/')})`, defaultValue);
    if (choices.includes(answer)) return answer;
    console.log(chalk.red(`Please choose one of: ${choices.join(', ')}`));
  }
}

async function confirm(question, defaultValue = false) {
  const suffix = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await ask(`${question} [${suffix}]`, '')).trim().toLowerCase();
  if (!answer) return defaultValue;
  return ['y', 'yes'].includes(answer);
}

class SetupWizard {
  constructor(configPath = null) {
    this.configPath = configPath || path.join(os.homedir(), '.raven', 'config.json');
    this.config = {};
  }

  async run() {
    console.log();
    console.log(chalk.cyan.bold('\u256d\u2500 Raven Configuration Wizard \u2500\u256e'));
    console.log();

    if (fs.existsSync(this.configPath)) {
      try {
        this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        console.log(chalk.dim('Found existing configuration.'));
      } catch (e) {
        this.config = {};
      }
    }

    if (!(await confirm('Do you want to configure Raven now?', true))) {
      if (Object.keys(this.config).length) {
        console.log(chalk.green('Using existing configuration.'));
        return true;
      }
      console.log(chalk.yellow('No configuration found. Using defaults.'));
      this._createDefaultConfig();
      return true;
    }

    await this._configureBackend();
    await this._configureApiKeys();
    await this._configureDatabases();
    await this._configureAdvanced();
    this._saveConfig();

    console.log();
    console.log(chalk.green('Configuration saved successfully!'));
    console.log(chalk.dim(`Configuration file: ${this.configPath}`));
    return true;
  }

  async _configureBackend() {
    console.log(`\n${chalk.cyan.bold('Backend Configuration')}\n`);
    const backend = await askChoice('Choose your backend', ['ollama', 'openrouter', 'custom', 'omniroute'], this.config.backend || 'ollama');
    this.config.backend = backend;

    if (backend === 'ollama') {
      this.config.ollama_base_url = await ask('Ollama base URL', this.config.ollama_base_url || 'http://localhost:11434');
      this.config.model = await ask('Model name', this.config.model || 'llama3.1');
    } else if (backend === 'openrouter') {
      this.config.openrouter_api_key = await ask('OpenRouter API key', this.config.openrouter_api_key || '');
      this.config.model = await ask('Model name', this.config.model || 'meta-llama/llama-3-8b-instruct:free');
    } else if (backend === 'omniroute') {
      this.config.omniroute_base_url = await ask('OmniRoute base URL', this.config.omniroute_base_url || 'http://localhost:20128/v1');
      this.config.omniroute_api_key = await ask('OmniRoute API key', this.config.omniroute_api_key || '');
      this.config.model = await ask('Model name (with provider prefix)', this.config.model || 'openai/llama3.1');
    } else if (backend === 'custom') {
      this.config.custom_base_url = await ask('Custom base URL', this.config.custom_base_url || '');
      this.config.custom_api_key = await ask('Custom API key (optional)', this.config.custom_api_key || '');
      this.config.model = await ask('Model name', this.config.model || '');
    }
  }

  async _configureApiKeys() {
    console.log(`\n${chalk.cyan.bold('API Keys Configuration')}\n`);
    if (!(await confirm('Configure external API keys?', false))) return;

    const vtKey = await ask('VirusTotal API key (optional)', this.config.virustotal_api_key || '');
    if (vtKey) this.config.virustotal_api_key = vtKey;

    const abuseKey = await ask('AbuseIPDB API key (optional)', this.config.abuseipdb_api_key || '');
    if (abuseKey) this.config.abuseipdb_api_key = abuseKey;

    const shodanKey = await ask('Shodan API key (optional)', this.config.shodan_api_key || '');
    if (shodanKey) this.config.shodan_api_key = shodanKey;
  }

  async _configureDatabases() {
    console.log(`\n${chalk.cyan.bold('Database Configuration')}\n`);
    if (!(await confirm('Configure databases?', false))) return;

    this.config.databases = {};
    while (true) {
      if (!(await confirm('Add a database?', false))) break;
      const dbName = await ask('Database name (internal ID)', '');
      const dbUrl = await ask('Database URL (SQLite, JSON, CSV, or connection string)', '');
      const readOnly = await confirm('Read-only?', true);
      this.config.databases[dbName] = { url: dbUrl, read_only: readOnly };
    }
  }

  async _configureAdvanced() {
    console.log(`\n${chalk.cyan.bold('Advanced Settings')}\n`);

    this.config.workspace = await ask('Workspace directory', this.config.workspace || '.');
    this.config.temperature = parseFloat(await ask('AI temperature (0.0-1.0)', String(this.config.temperature ?? '0.3')));
    this.config.max_iterations = parseInt(await ask('Max tool iterations', String(this.config.max_iterations ?? '12')), 10);
    this.config.show_thinking = await confirm('Show AI thinking process?', this.config.show_thinking !== false);

    if (await confirm('Enable browser?', false)) {
      const headless = await askChoice('Headless mode?', ['true', 'false'], 'true');
      this.config.browser = { enabled: true, headless: headless === 'true' };
    } else {
      this.config.browser = { enabled: false };
    }
  }

  _createDefaultConfig() {
    this.config = {
      backend: 'ollama',
      ollama_base_url: 'http://localhost:11434',
      model: 'llama3.1',
      temperature: 0.3,
      max_iterations: 12,
      show_thinking: true,
      workspace: '.',
      browser: { enabled: false },
      databases: {},
    };
    this._saveConfig();
  }

  _saveConfig() {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
  }

  getConfig() {
    return this.config;
  }
}

async function runSetupWizard() {
  const wizard = new SetupWizard();
  await wizard.run();
  return wizard.getConfig();
}

module.exports = { SetupWizard, runSetupWizard };
