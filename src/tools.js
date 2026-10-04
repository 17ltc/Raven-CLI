'use strict';
/**
 * Tools available to the agent. Every tool here is passive / read-only:
 * web search, page fetch, WHOIS, DNS, certificate transparency, and a few
 * optional reputation-lookup wrappers that only activate if the user has
 * supplied their own API key. Nothing here performs active scanning,
 * exploitation, or credential testing - that's a deliberate boundary, not
 * an oversight, and it matches the scope of the bundled osint-suite
 * skill. Don't extend this file with active-scan/exploit tools.
 *
 * Port of Raven/tools.py
 */

const { capture: trackCapture, captureTree: trackCaptureTree } = require('./file_history');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const cheerio = require('cheerio');

const MAX_FETCH_CHARS = 6000;
// 5 MB cap on what we'll actually pull into memory, regardless of what a
// server's Content-Length header claims (or lies about).
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = 'raven-cli/0.1 (+passive research tool)';

function truncate(text, n = MAX_FETCH_CHARS) {
  text = text || '';
  return text.length <= n ? text : `${text.slice(0, n)}\n...[truncated, ${text.length} chars total]`;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort DuckDuckGo HTML search - the same bounded fallback the Python
 * version falls back to when the `ddgs` package/backends aren't available. */
async function webSearch({ query, max_results = 8 } = {}) {
  query = (query || '').trim();
  const maxResults = Math.max(1, Math.min(parseInt(max_results, 10) || 8, 25));
  if (!query) return { query, results: [], count: 0, status: 'empty_query' };

  const errors = [];
  try {
    const resp = await fetchWithTimeout('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: query }).toString(),
    });
    const html = await resp.text();
    const $ = cheerio.load(html);
    const results = [];
    $('.result').each((i, el) => {
      if (results.length >= maxResults) return;
      const link = $(el).find('.result__a').first();
      const snippet = $(el).find('.result__snippet').first();
      const href = link.attr('href');
      if (link.length && href) {
        results.push({ title: link.text().trim(), href, body: snippet.text().trim() });
      }
    });
    if (results.length) {
      return { query, results, count: results.length, status: 'ok', backend: 'duckduckgo-html' };
    }
  } catch (e) {
    errors.push(`html: ${e.message}`);
  }
  return {
    query,
    results: [],
    count: 0,
    status: 'no_results',
    message: 'No public results were returned by the available search sources.',
    errors: errors.slice(-3),
  };
}

async function webFetch({ url } = {}) {
  try {
    const parsed = new URL(String(url));
    if (!['http:', 'https:'].includes(parsed.protocol)) return { error: 'Only http(s) URLs are allowed.' };
    const resp = await fetchWithTimeout(parsed.href, { headers: { 'User-Agent': USER_AGENT } });
    if (!resp.ok) return { error: `HTTP ${resp.status} while fetching URL.` };
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        try {
          reader.cancel();
        } catch (e) {
          /* ignore */
        }
        return { error: `Response exceeded ${MAX_DOWNLOAD_BYTES} byte cap; refused to download further.` };
      }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const contentType = resp.headers.get('content-type') || '';
    let text = raw.toString('utf8');
    if (contentType.includes('html')) {
      const $ = cheerio.load(text);
      $('script, style, nav, footer').remove();
      text = $('body').length ? $('body').text() : $.root().text();
      text = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join('\n');
    }
    return { url, status: resp.status, content: truncate(text) };
  } catch (e) {
    return { error: e.message };
  }
}

const WHOIS_SERVERS = {
  com: 'whois.verisign-grs.com',
  net: 'whois.verisign-grs.com',
  org: 'whois.pir.org',
  io: 'whois.nic.io',
  dev: 'whois.nic.google',
  ai: 'whois.nic.ai',
  co: 'whois.nic.co',
};

function whoisQuery(server, query, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(43, server);
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`WHOIS query to ${server} timed out`));
    }, timeoutMs);
    socket.on('connect', () => socket.write(`${query}\r\n`));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function whoisLookup({ domain } = {}) {
  try {
    const tld = domain.split('.').pop().toLowerCase();
    let server = WHOIS_SERVERS[tld];
    if (!server) {
      // Ask IANA which registry server is authoritative for this TLD.
      const ianaResp = await whoisQuery('whois.iana.org', tld);
      const match = /refer:\s*(\S+)/i.exec(ianaResp);
      server = match ? match[1] : 'whois.iana.org';
    }
    let result = await whoisQuery(server, domain);
    // Follow one referral if the registry server points to a registrar.
    const referMatch = /Registrar WHOIS Server:\s*(\S+)/i.exec(result);
    if (referMatch && referMatch[1] && referMatch[1] !== server) {
      try {
        result = await whoisQuery(referMatch[1], domain);
      } catch (e) {
        /* keep the registry response if the registrar lookup fails */
      }
    }
    return { domain, result: { raw: result } };
  } catch (e) {
    return { error: e.message };
  }
}

async function dnsLookup({ domain, record_types } = {}) {
  const recordTypes = record_types && record_types.length ? record_types : ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME'];
  const resolvers = {
    A: () => dns.resolve4(domain),
    AAAA: () => dns.resolve6(domain),
    MX: () => dns.resolveMx(domain).then((r) => r.map((m) => `${m.priority} ${m.exchange}`)),
    NS: () => dns.resolveNs(domain),
    TXT: () => dns.resolveTxt(domain).then((r) => r.map((t) => t.join(''))),
    CNAME: () => dns.resolveCname(domain),
  };
  const out = {};
  for (const rtype of recordTypes) {
    const resolver = resolvers[rtype];
    if (!resolver) {
      out[rtype] = `unsupported record type: ${rtype}`;
      continue;
    }
    try {
      out[rtype] = await resolver();
    } catch (e) {
      out[rtype] = `none/error: ${e.message}`;
    }
  }
  return { domain, records: out };
}

async function reverseDns({ ip } = {}) {
  try {
    const hostnames = await dns.reverse(ip);
    return { ip, hostname: hostnames[0], aliases: hostnames.slice(1) };
  } catch (e) {
    return { error: e.message };
  }
}

/** Certificate Transparency log lookup - a standard passive subdomain enumeration technique. */
async function crtshLookup({ domain } = {}) {
  try {
    const resp = await fetchWithTimeout(`https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (resp.status !== 200) return { error: `crt.sh returned ${resp.status}` };
    const data = await resp.json();
    const names = Array.from(new Set(data.filter((row) => row.name_value).map((row) => row.name_value))).sort();
    return { domain, subdomains_found: names.slice(0, 200), count: names.length };
  } catch (e) {
    return { error: e.message };
  }
}

/** Optional - requires VT_API_KEY env var. indicator_type: domain | ip_address | file_hash | url. */
async function virustotalLookup({ indicator, indicator_type = 'domain' } = {}) {
  const apiKey = process.env.VT_API_KEY;
  if (!apiKey) return { error: 'Set VT_API_KEY env var to enable VirusTotal lookups.' };
  const endpointMap = {
    domain: `domains/${indicator}`,
    ip_address: `ip_addresses/${indicator}`,
    file_hash: `files/${indicator}`,
    url: `urls/${indicator}`,
  };
  const p = endpointMap[indicator_type];
  if (!p) return { error: `unknown indicator_type '${indicator_type}'` };
  try {
    const resp = await fetchWithTimeout(`https://www.virustotal.com/api/v3/${p}`, { headers: { 'x-apikey': apiKey } });
    return { status: resp.status, data: await resp.json() };
  } catch (e) {
    return { error: e.message };
  }
}

/** Optional - requires ABUSEIPDB_API_KEY env var. */
async function abuseipdbLookup({ ip } = {}) {
  const apiKey = process.env.ABUSEIPDB_API_KEY;
  if (!apiKey) return { error: 'Set ABUSEIPDB_API_KEY env var to enable AbuseIPDB lookups.' };
  try {
    const url = `https://api.abuseipdb.com/api/v2/check?${new URLSearchParams({ ipAddress: ip, maxAgeInDays: '90' })}`;
    const resp = await fetchWithTimeout(url, { headers: { Key: apiKey, Accept: 'application/json' } });
    return { status: resp.status, data: await resp.json() };
  } catch (e) {
    return { error: e.message };
  }
}

/** Optional - requires SHODAN_API_KEY env var. Passive: reads Shodan's existing index, no scanning. */
async function shodanLookup({ ip } = {}) {
  const apiKey = process.env.SHODAN_API_KEY;
  if (!apiKey) return { error: 'Set SHODAN_API_KEY env var to enable Shodan lookups.' };
  try {
    const url = `https://api.shodan.io/shodan/host/${ip}?${new URLSearchParams({ key: apiKey })}`;
    const resp = await fetchWithTimeout(url);
    return { status: resp.status, data: await resp.json() };
  } catch (e) {
    return { error: e.message };
  }
}

const TOOLS = {
  web_search: { fn: webSearch, description: 'Search the web. Args: {query: str, max_results?: int}' },
  web_fetch: { fn: webFetch, description: 'Fetch and extract readable text from a URL. Args: {url: str}' },
  whois_lookup: { fn: whoisLookup, description: 'WHOIS lookup for a domain. Args: {domain: str}' },
  dns_lookup: { fn: dnsLookup, description: 'DNS record lookup. Args: {domain: str, record_types?: [str]}' },
  reverse_dns: { fn: reverseDns, description: 'Reverse DNS lookup for an IP. Args: {ip: str}' },
  crtsh_lookup: { fn: crtshLookup, description: 'Certificate transparency subdomain enumeration. Args: {domain: str}' },
  virustotal_lookup: {
    fn: virustotalLookup,
    description:
      "VirusTotal reputation lookup (needs VT_API_KEY). Args: {indicator: str, indicator_type: 'domain'|'ip_address'|'file_hash'|'url'}",
  },
  abuseipdb_lookup: {
    fn: abuseipdbLookup,
    description: 'AbuseIPDB reputation lookup (needs ABUSEIPDB_API_KEY). Args: {ip: str}',
  },
  shodan_lookup: {
    fn: shodanLookup,
    description: 'Shodan indexed host lookup, passive (needs SHODAN_API_KEY). Args: {ip: str}',
  },
};

async function runTool(name, args, registry = null) {
  registry = registry || TOOLS;
  if (!registry[name]) {
    return { error: `Unknown tool '${name}'. Available: ${Object.keys(registry)}` };
  }
  try {
    return await registry[name].fn(args || {});
  } catch (e) {
    // Safety net: a tool must never be able to crash the agent loop.
    return { error: `${e.constructor.name} while running ${name}: ${e.message}` };
  }
}

/**
 * Combine the always-available passive tools with the ones enabled/configured
 * in settings.json: file tools (sandboxed to a workspace), database tools
 * (one per configured connection), and the real-browser tool (if enabled).
 */
function buildRegistry(config) {
  const { BrowserTools } = require('./browser_tools');
  const { CommandExecutor } = require('./command_executor');
  const { DatabaseTools } = require('./db_tools');
  const { FileTools } = require('./file_tools');
  const { TargetManager } = require('./target_manager');
  const { ProjectTools } = require('./project_tools');
  const { registerIdeTools } = require('./ide_tools');
  const { registerAutomationTools } = require('./automation');
  const { registerIntegrationTools } = require('./integrations');
  const { registerPassiveOsintTools } = require('./passive_osint_tools');
  const { registerCsintOpsecTools } = require('./csint_opsec_tools');
  const { registerInteractiveQuestionTools } = require('./interactive_questions');
  const { getServerManager } = require('./server_manager');
  const { AdvancedIPLookup, SelfReflectionSystem } = require('./advanced_tools');

  const registry = { ...TOOLS };

  const workspaceConfig = config.workspace || {};
  const workspaceRoot =
    typeof workspaceConfig === 'object' ? workspaceConfig.path || './workspace' : workspaceConfig;
  const unrestricted = typeof workspaceConfig === 'object' ? Boolean(workspaceConfig.unrestricted) : false;
  const fileTools = new FileTools(workspaceRoot, unrestricted);

  registry.write_file = {
    fn: ({ path: p, content, mode }) => fileTools.writeFile(p, content, mode || 'overwrite'),
    description: "Create or overwrite a file inside the workspace. Args: {path: str, content: str, mode?: 'overwrite'|'append'}",
  };
  registry.list_workspace = { fn: () => fileTools.listWorkspace(), description: 'List files currently in the workspace. Args: {}' };
  registry.undo_file = {
    fn: ({ path: p }) => fileTools.undoFile(p),
    description: 'Restore the previous saved version of a file in the workspace. Args: {path: str}',
  };

  const projectTools = new ProjectTools(workspaceRoot);
  registry.project_tree = {
    fn: ({ max_depth } = {}) => projectTools.tree(max_depth || 3),
    description: 'List the project tree while excluding generated and dependency directories. Args: {max_depth?: int}',
  };
  registry.project_read = {
    fn: ({ path: p, start_line, max_lines }) => projectTools.read(p, Number(start_line) || 1, Number(max_lines) || 240),
    description: 'Read a bounded line range from a project file. Args: {path: str, start_line?: int, max_lines?: int}',
  };
  registry.project_search = {
    fn: ({ query }) => projectTools.search(query),
    description: 'Search text across project files and return file, line, and matching text. Args: {query: str}',
  };
  registry.project_inspect = {
    fn: () => projectTools.inspect(),
    description: 'Inspect project root, file count, extensions, and a shallow tree. Args: {}',
  };
  registry.project_context = {
    fn: ({ query, limit }) => projectTools.contextForQuery(query, limit || 6000),
    description: 'Build a bounded project context from a user query and relevant files. Args: {query: str, limit?: int}',
  };
  registry.project_diff = {
    fn: ({ path: p }) => projectTools.diffFile(p),
    description: 'Show the Git diff for one project file. Args: {path: str}',
  };
  registry.project_git = {
    fn: ({ args } = {}) => projectTools.git(...(args && args.length ? args : ['status'])),
    description: 'Run a read-only Git inspection command such as status, diff, or log. Args: {args: list[str]}',
  };

  registerIdeTools(registry, workspaceRoot);
  registerAutomationTools(registry);
  registerIntegrationTools(registry, config);
  registerPassiveOsintTools(registry);
  registerCsintOpsecTools(registry);
  registerInteractiveQuestionTools(registry);

  registry.delete_file = {
    fn: ({ path: p }) => fileTools.deleteFile(p),
    description:
      'Delete a file inside the workspace. This ALWAYS pauses and asks the ' +
      'human operator for a y/N confirmation in the terminal before deleting ' +
      "anything - that confirmation cannot be skipped or pre-answered, so " +
      "don't bother asking the user for permission yourself first, just call " +
      'the tool and the human will be prompted directly. Args: {path: str}',
  };

  const dbCfg = config.databases || {};
  if (dbCfg && Object.keys(dbCfg).length) {
    const dbCfgDict = {};
    for (const [name, dbConfig] of Object.entries(dbCfg)) {
      dbCfgDict[name] = typeof dbConfig.toDict === 'function' ? dbConfig.toDict() : dbConfig;
    }
    const dbTools = new DatabaseTools(dbCfgDict);
    registry.db_query = {
      fn: ({ connection, sql, max_rows }) => dbTools.dbQuery(connection, sql, max_rows || 100),
      description:
        'Query public security databases for threat intelligence, breach data, and security research. ' +
        'These are publicly accessible databases aggregated from security vendors and research organizations. ' +
        'Read-only access for research and investigation purposes. Args: {connection: str, sql: str, max_rows?: int}',
    };
    registry.list_databases = {
      fn: () => dbTools.listDatabases(),
      description:
        'List available public security databases including threat intelligence feeds, breach databases, ' +
        'and security research repositories. Shows database descriptions, data types, and access information. Args: {}',
    };
  }

  const browserCfg = config.browser || {};
  if (browserCfg.enabled) {
    const browserTools = new BrowserTools(browserCfg.headless !== false, browserCfg.user_data_dir || null);
    registry.browser_fetch = {
      fn: ({ url }) => browserTools.browserFetch(url),
      description:
        'Fetch a page using a real browser engine (renders JavaScript, can reuse your logged-in session if ' +
        'user_data_dir is set). Use this when web_fetch returns empty/broken content. Args: {url: str}',
    };
  }

  const discordCfg = config.discord || {};
  if (discordCfg.enabled) {
    const { DiscordTools } = require('./discord_bot_tools');
    const token = process.env[discordCfg.token_env || 'DISCORD_BOT_TOKEN'] || discordCfg.token || '';
    if (token) {
      const discord = new DiscordTools(token, String(discordCfg.guild_id || ''), (discordCfg.channel_ids || []).map(String));
      registry.discord_list_guilds = {
        fn: () => discord.listGuilds(),
        description: 'List Discord servers accessible to the configured bot after human confirmation. Args: {}',
      };
      registry.discord_configure_scope = {
        fn: ({ guild_id, channel_ids }) => discord.configureScope(guild_id, channel_ids),
        description: 'Save the authorized Discord server and channel scope after human confirmation. Args: {guild_id: str, channel_ids: list[str]}',
      };
      registry.discord_list_channels = {
        fn: () => discord.guildChannels(),
        description: 'List channels in the configured Discord guild after human confirmation. Args: {}',
      };
      registry.discord_lookup_user = {
        fn: ({ user_id }) => discord.lookupUser(user_id),
        description: 'Look up a Discord user by ID after human confirmation. Args: {user_id: str}',
      };
      registry.discord_search_messages = {
        fn: ({ query, channel_id, author_id, limit }) => discord.searchMessages(query, channel_id, author_id, limit || 50),
        description:
          'Search bounded message history in configured channels after human confirmation. Args: {query: str, channel_id?: str, author_id?: str, limit?: int}',
      };
    }
  }

  const commandExecutor = new CommandExecutor();
  registry.execute_command = {
    fn: ({ command, timeout }) => commandExecutor.executeCommand(command, timeout),
    description:
      'Execute a shell command with mandatory user confirmation. Always shows the exact command and asks for approval before running. Args: {command: str, timeout?: int}',
  };

  const serverManager = getServerManager(workspaceRoot);
  registry.server_start = {
    fn: ({ name, command, cwd, env, port }) => serverManager.start({ name, command, cwd, env, port }),
    description:
      'Start a long-running development/test server in the background after human confirmation. Args: {name?: str, command: str, cwd?: str, env?: dict, port?: int}',
  };
  registry.server_list = {
    fn: () => serverManager.list(),
    description: 'List background servers started by Raven. Args: {}',
  };
  registry.server_logs = {
    fn: ({ id, lines }) => serverManager.logs(id, lines || 80),
    description: 'Read recent stdout/stderr lines from a background server. Args: {id: str, lines?: int}',
  };
  registry.server_stop = {
    fn: ({ id }) => serverManager.stop(id),
    description: 'Stop one Raven-managed background server after human confirmation. Args: {id: str}',
  };
  registry.server_stop_all = {
    fn: () => serverManager.stopAll(),
    description: 'Stop all Raven-managed background servers after human confirmation. Args: {}',
  };

  const ipLookup = new AdvancedIPLookup();
  registry.advanced_ip_lookup = {
    fn: ({ ip, sources }) => ipLookup.lookupIp(ip, sources),
    description:
      'Multi-source IP lookup using free APIs (ip-api.com, ipinfo.io, ipgeolocation.io). Correlates results from multiple sources and provides confidence scores. Args: {ip: str, sources?: list}',
  };

  const selfReflection = new SelfReflectionSystem();
  registry.self_reflection = {
    fn: ({ results, original_query }) => selfReflection.analyzeResults(results, original_query),
    description:
      'Analyze AI results for consistency, completeness, and accuracy. Identifies potential issues and suggests corrections. Args: {results: dict, original_query: str}',
  };

  registry.system_info = {
    fn: getSystemInfo,
    description: 'Get comprehensive system information including OS, CPU, memory, disk, and network details. Useful for understanding the local environment. Args: {}',
  };
  registry.list_files = {
    fn: ({ path: p, recursive, pattern } = {}) => listFiles(p || '.', Boolean(recursive), pattern || '*'),
    description: 'List files in a directory with metadata. Useful for examining local data repositories and logs. Args: {path: str, recursive?: bool, pattern?: str}',
  };
  registry.read_file = {
    fn: ({ path: p, lines }) => readFileTool(p, lines || 100),
    description: 'Read contents of a file. Useful for examining logs, configuration files, and data files. Args: {path: str, lines?: int}',
  };
  registry.list_processes = {
    fn: listProcesses,
    description: 'List running processes with details. Useful for identifying suspicious processes or malware. Args: {}',
  };
  registry.network_connections = {
    fn: getNetworkConnections,
    description: 'Get current network connections and listening ports. Useful for network reconnaissance and identifying suspicious connections. Args: {}',
  };

  // Keep coding tools on the same configured workspace as write_file. The
  // legacy implementations used process.cwd(), so launching Raven from
  // another directory silently created files in the wrong place.
  function workspaceCreateFile({ path: p, content, mode }) {
    const result = fileTools.writeFile(p, content, mode || 'overwrite');
    if (result.status === 'written') return { success: true, path: result.path, size_bytes: result.bytes };
    return { success: false, error: result.error || 'File write failed' };
  }

  function workspaceEditFile({ path: p, old_content, new_content }) {
    try {
      const target = fileTools._resolve(p);
      const fs = require('fs');
      if (!fs.existsSync(target)) return { success: false, error: `File does not exist: ${p}` };
      const current = fs.readFileSync(target, 'utf8');
      if (!current.includes(old_content)) return { success: false, error: 'Old content not found in file' };
      const result = fileTools.writeFile(p, current.replace(old_content, () => new_content));
      if (result.status === 'written') return { success: true, path: result.path, modified: true };
      return { success: false, error: result.error || 'File write failed' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  registry.create_file = {
    fn: workspaceCreateFile,
    description: "Create or write a file inside the configured workspace. Args: {path: str, content: str, mode?: 'overwrite'|'append'}",
  };
  registry.edit_file = {
    fn: workspaceEditFile,
    description: 'Edit an existing file inside the configured workspace by replacing specific content. Args: {path: str, old_content: str, new_content: str}',
  };
  registry.create_directory = { fn: ({ path: p }) => createDirectory(p), description: 'Create a new directory. Useful for organizing code into proper folder structures. Args: {path: str}' };
  registry.rename_file = { fn: ({ old_path, new_path }) => renameFile(old_path, new_path), description: 'Rename a file or directory. Use for refactoring and code organization. Args: {old_path: str, new_path: str}' };
  registry.copy_file = { fn: ({ source, destination }) => copyFile(source, destination), description: 'Copy a file to a new location. Useful for creating variations or backups. Args: {source: str, destination: str}' };
  registry.run_tests = { fn: ({ framework, path: p } = {}) => runTests(framework || 'auto', p || '.'), description: 'Run tests for the project. Supports pytest, npm test, and other test frameworks. Args: {framework?: str, path?: str}' };
  registry.install_dependencies = { fn: ({ manager, packages } = {}) => installDependencies(manager || 'auto', packages), description: 'Install project dependencies. Supports pip, npm, yarn, and other package managers. Args: {manager: str, packages?: list}' };
  registry.run_linter = { fn: ({ tool, path: p } = {}) => runLinter(tool || 'auto', p || '.'), description: 'Run code linter and formatter. Supports pylint, flake8, eslint, prettier, and other tools. Args: {tool: str, path?: str}' };
  registry.build_project = { fn: ({ command } = {}) => buildProject(command || 'auto'), description: 'Build the project using appropriate build tools. Supports npm run build, python setup.py, make, and others. Args: {command?: str}' };

  const targetManager = new TargetManager(path.join(path.resolve(workspaceRoot), 'targets'));

  registry.target_create = {
    fn: ({ name, identifiers }) => {
      try {
        const target = targetManager.createTarget(name, identifiers);
        return { success: true, target: target.name, path: targetManager._targetPath(name) };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
    description: 'Create a new investigation target. Args: {name: str, identifiers?: dict}',
  };
  registry.target_add_identifier = {
    fn: ({ target_name, identifier_type, value }) => {
      try {
        const target = targetManager.addIdentifier(target_name, identifier_type, value);
        return { success: true, target: target.name, identifiers: target.identifiers };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
    description: 'Add an identifier to a target. Args: {target_name: str, identifier_type: str, value: str}',
  };
  registry.target_find = {
    fn: ({ identifier_type, value }) => {
      try {
        const target = targetManager.findTargetByIdentifier(identifier_type, value);
        if (target) return { success: true, target: target.name, identifiers: target.identifiers };
        return { success: false, error: 'Target not found' };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
    description: 'Find a target by identifier. Args: {identifier_type: str, value: str}',
  };
  registry.target_save_research = {
    fn: ({ target_name, research_type, content }) => {
      try {
        const p = targetManager.saveResearch(target_name, research_type, content);
        return { success: true, path: p };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
    description: 'Save research content to a target. Args: {target_name: str, research_type: str, content: str}',
  };
  registry.target_auto_associate = {
    fn: ({ identifier, identifier_type }) => {
      try {
        const targetName = targetManager.autoAssociateIdentifier(identifier, identifier_type || 'email');
        if (targetName) return { success: true, target: targetName };
        return { success: false, error: 'Could not auto-associate identifier' };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
    description: 'Automatically find or create a target based on an identifier. Args: {identifier: str, identifier_type?: str}',
  };

  return registry;
}

// ---------------------------------------------------------------------------
// System and file tools implementations
// ---------------------------------------------------------------------------

/**
 * Get comprehensive system information.
 * NOTE: Node's `os` module covers CPU/memory/OS natively without extra
 * dependencies; per-partition disk usage isn't exposed cross-platform by
 * core Node, so this reports the current working directory's filesystem via
 * a best-effort `df`/`wmic` shell-out and degrades gracefully if that fails.
 */
async function getSystemInfo() {
  try {
    const cpus = os.cpus();
    const info = {
      os: {
        system: process.platform,
        release: os.release(),
        version: os.version ? os.version() : os.release(),
        machine: os.arch(),
        processor: cpus.length ? cpus[0].model : 'N/A',
      },
      cpu: {
        physical_cores: cpus.length,
        logical_cores: cpus.length,
        frequency: cpus.length ? `${cpus[0].speed} MHz` : 'N/A',
        usage_percent: await cpuUsagePercent(),
      },
      memory: {
        total_gb: os.totalmem() / 1024 ** 3,
        available_gb: os.freemem() / 1024 ** 3,
        used_gb: (os.totalmem() - os.freemem()) / 1024 ** 3,
        percent: ((os.totalmem() - os.freemem()) / os.totalmem()) * 100,
      },
      disk: await diskUsageBestEffort(),
    };
    return info;
  } catch (e) {
    return { error: e.message };
  }
}

function cpuUsagePercent() {
  return new Promise((resolve) => {
    const start = os.cpus();
    setTimeout(() => {
      const end = os.cpus();
      let idleDiff = 0;
      let totalDiff = 0;
      for (let i = 0; i < start.length; i++) {
        const s = start[i].times;
        const e = end[i].times;
        const sTotal = s.user + s.nice + s.sys + s.idle + s.irq;
        const eTotal = e.user + e.nice + e.sys + e.idle + e.irq;
        idleDiff += e.idle - s.idle;
        totalDiff += eTotal - sTotal;
      }
      resolve(totalDiff > 0 ? 100 * (1 - idleDiff / totalDiff) : 0);
    }, 200);
  });
}

async function diskUsageBestEffort() {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);
  const disk = {};
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('wmic', ['logicaldisk', 'get', 'size,freespace,caption']);
      const lines = stdout.split(/\r?\n/).slice(1).filter((l) => l.trim());
      for (const line of lines) {
        const [caption, freespace, size] = line.trim().split(/\s+/);
        if (!caption || !size) continue;
        const total = parseInt(size, 10);
        const free = parseInt(freespace, 10) || 0;
        disk[caption] = {
          total_gb: total / 1024 ** 3,
          used_gb: (total - free) / 1024 ** 3,
          free_gb: free / 1024 ** 3,
          percent: total ? ((total - free) / total) * 100 : 0,
        };
      }
    } else {
      const { stdout } = await execFileAsync('df', ['-k']);
      const lines = stdout.split('\n').slice(1).filter(Boolean);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 6) continue;
        const [, blocks, used, avail, , mount] = parts;
        const totalGb = (parseInt(blocks, 10) * 1024) / 1024 ** 3;
        const usedGb = (parseInt(used, 10) * 1024) / 1024 ** 3;
        const freeGb = (parseInt(avail, 10) * 1024) / 1024 ** 3;
        disk[mount] = { total_gb: totalGb, used_gb: usedGb, free_gb: freeGb, percent: totalGb ? (usedGb / totalGb) * 100 : 0 };
      }
    }
  } catch (e) {
    /* best effort only, mirrors the Python `except: pass` per partition */
  }
  return disk;
}

const fsSync = require('fs');

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function walkAll(root, recursive) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      out.push(full);
      if (entry.isDirectory() && recursive) stack.push(full);
    }
  }
  return out;
}

/** List files in a directory with metadata. */
function listFiles(dirPath = '.', recursive = false, pattern = '*') {
  try {
    if (!fsSync.existsSync(dirPath)) return { error: `Path does not exist: ${dirPath}` };
    const rx = globToRegExp(pattern);
    const entries = recursive
      ? walkAll(dirPath, true)
      : fsSync.readdirSync(dirPath).map((n) => path.join(dirPath, n));

    const files = [];
    for (const filePath of entries) {
      const base = path.basename(filePath);
      if (!rx.test(base)) continue;
      let stat;
      try {
        stat = fsSync.statSync(filePath);
      } catch (e) {
        continue;
      }
      if (stat.isFile()) {
        files.push({
          name: base,
          path: filePath,
          size_bytes: stat.size,
          size_mb: stat.size / (1024 * 1024),
          modified: stat.mtimeMs / 1000,
          is_file: true,
        });
      } else if (stat.isDirectory()) {
        files.push({ name: base, path: filePath, is_dir: true });
      }
    }
    return { files, count: files.length };
  } catch (e) {
    return { error: e.message };
  }
}

/** Read contents of a file. */
function readFileTool(filePath, lines = 100) {
  try {
    if (!fsSync.existsSync(filePath)) return { error: `File does not exist: ${filePath}` };
    if (!fsSync.statSync(filePath).isFile()) return { error: `Path is not a file: ${filePath}` };

    let content = fsSync.readFileSync(filePath, 'utf8');
    const splitLines = content.split('\n');
    if (lines && splitLines.length > lines) {
      content = `${splitLines.slice(0, lines).join('\n')}\n... (truncated)`;
    }
    return { content, size_bytes: fsSync.statSync(filePath).size, line_count: content.split('\n').length };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * List running processes with details.
 * NOTE: psutil has no zero-dependency Node equivalent; this shells out to
 * `ps`/`tasklist` for best-effort parity rather than pulling in a native
 * addon, and reports what's available per platform.
 */
async function listProcesses() {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);
  try {
    const processes = [];
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH']);
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
        if (cols.length >= 2) {
          processes.push({ pid: parseInt(cols[1], 10), name: cols[0], username: null, cpu_percent: null, memory_percent: null });
        }
      }
    } else {
      const { stdout } = await execFileAsync('ps', ['-Ao', 'pid,user,pcpu,pmem,comm']);
      const lines = stdout.split('\n').slice(1).filter(Boolean);
      for (const line of lines) {
        const [pid, username, cpu, mem, ...rest] = line.trim().split(/\s+/);
        processes.push({
          pid: parseInt(pid, 10),
          name: rest.join(' '),
          username,
          cpu_percent: parseFloat(cpu),
          memory_percent: parseFloat(mem),
        });
      }
    }
    return { processes, count: processes.length };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Get current network connections and listening ports.
 * NOTE: best-effort via `netstat`, mirroring psutil.net_connections() without
 * a native dependency.
 */
async function getNetworkConnections() {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);
  try {
    const args = process.platform === 'win32' ? ['-ano'] : ['-an'];
    const { stdout } = await execFileAsync('netstat', args);
    const connections = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!/^(tcp|udp)/i.test(trimmed)) continue;
      const parts = trimmed.split(/\s+/);
      connections.push({
        type: parts[0],
        local_address: parts[1] || 'N/A',
        remote_address: parts[2] || 'N/A',
        status: parts[3] || 'N/A',
        pid: process.platform === 'win32' ? parseInt(parts[parts.length - 1], 10) || null : null,
      });
    }
    return { connections, count: connections.length };
  } catch (e) {
    return { error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Code development tools implementations
// ---------------------------------------------------------------------------

/** Create a new file with specified content. Unlike create_file in the
 * registry (workspace-sandboxed), this legacy variant writes anywhere,
 * matching the Python original's lack of a workspace check. */
function createFile(filePath, content) {
  try {
    let target = filePath;
    if (!path.isAbsolute(target)) target = path.join(process.cwd(), target);
    trackCapture(target);
    fsSync.mkdirSync(path.dirname(target), { recursive: true });
    if (Buffer.isBuffer(content)) fsSync.writeFileSync(target, content);
    else fsSync.writeFileSync(target, String(content), 'utf8');
    return { success: true, path: target, size_bytes: fsSync.statSync(target).size };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function editFile(filePath, oldContent, newContent) {
  try {
    if (!fsSync.existsSync(filePath)) return { success: false, error: `File does not exist: ${filePath}` };
    const current = fsSync.readFileSync(filePath, 'utf8');
    if (!current.includes(oldContent)) return { success: false, error: 'Old content not found in file' };
    trackCapture(filePath);
    fsSync.writeFileSync(filePath, current.replace(oldContent, () => newContent), 'utf8');
    return { success: true, path: filePath, modified: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function createDirectory(dirPath) {
  try {
    fsSync.mkdirSync(dirPath, { recursive: true });
    return { success: true, path: dirPath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function renameFile(oldPath, newPath) {
  try {
    if (fsSync.existsSync(oldPath) && fsSync.statSync(oldPath).isDirectory()) {
      for (const rel of trackCaptureTree(oldPath)) trackCapture(path.join(newPath, rel));
    } else {
      trackCapture(oldPath);
      trackCapture(newPath);
    }
    fsSync.renameSync(oldPath, newPath);
    return { success: true, old_path: oldPath, new_path: newPath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function copyFile(source, destination) {
  try {
    trackCapture(destination);
    fsSync.mkdirSync(path.dirname(destination), { recursive: true });
    fsSync.copyFileSync(source, destination);
    return { success: true, source, destination };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Async subprocess runner (a sync spawn would freeze the UI - spinner, input
 * box - for the whole duration of `npm test`). Has a hard timeout and caps
 * captured output.
 */
function runShell(cmd, args, opts = {}) {
  const { spawn } = require('child_process');
  const timeoutMs = opts.timeout || 300000;
  const MAX = 2 * 1024 * 1024;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // npm/npx are .cmd shims on Windows and need a shell to be found.
    const useShell = Boolean(opts.shell) || (process.platform === 'win32' && /^(npm|npx|yarn|pnpm)$/.test(cmd));
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, shell: useShell, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      done({ returncode: -1, stdout: '', stderr: e.message });
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (e) {
        /* ignore */
      }
      done({ returncode: -1, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX) stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX) stderr += d.toString();
    });
    child.on('error', (e) => done({ returncode: -1, stdout, stderr: e.code === 'ENOENT' ? `${cmd}: command not found` : e.message }));
    child.on('close', (code) => done({ returncode: code === null ? -1 : code, stdout, stderr }));
  });
}

/** python3 first (most Linux/macOS installs have no bare `python`). */
async function runPython(args, opts) {
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  let last;
  for (const bin of candidates) {
    last = await runShell(bin, args, opts);
    if (!/command not found/.test(last.stderr)) return last;
  }
  return last;
}

async function runTests(framework = 'auto', projectPath = '.') {
  try {
    if (framework === 'auto') {
      if (fsSync.existsSync('package.json')) framework = 'npm';
      else framework = 'pytest';
    }
    if (framework === 'pytest') {
      const r = await runPython(['-m', 'pytest', projectPath]);
      return { success: r.returncode === 0, framework: 'pytest', output: r.stdout, errors: r.stderr, returncode: r.returncode };
    }
    if (framework === 'npm') {
      const r = await runShell('npm', ['test'], { cwd: projectPath });
      return { success: r.returncode === 0, framework: 'npm', output: r.stdout, errors: r.stderr, returncode: r.returncode };
    }
    return { success: false, error: `Unsupported framework: ${framework}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function installDependencies(manager = 'auto', packages = null) {
  try {
    if (manager === 'auto') {
      if (fsSync.existsSync('package.json')) manager = 'npm';
      else if (fsSync.existsSync('requirements.txt')) manager = 'pip';
      else return { success: false, error: 'Could not auto-detect package manager' };
    }
    if (manager === 'pip') {
      const args = packages && packages.length ? ['install', ...packages] : ['install', '-r', 'requirements.txt'];
      const r = await runPython(['-m', 'pip', ...args]);
      return { success: r.returncode === 0, manager: 'pip', output: r.stdout, errors: r.stderr, returncode: r.returncode };
    }
    if (manager === 'npm') {
      const args = packages && packages.length ? ['install', ...packages] : ['install'];
      const r = await runShell('npm', args);
      return { success: r.returncode === 0, manager: 'npm', output: r.stdout, errors: r.stderr, returncode: r.returncode };
    }
    return { success: false, error: `Unsupported manager: ${manager}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function runLinter(tool = 'auto', projectPath = '.') {
  try {
    if (tool === 'auto') {
      tool = fsSync.existsSync('package.json') ? 'eslint' : 'pylint';
    }
    if (tool === 'pylint') {
      const r = await runPython(['-m', 'pylint', projectPath]);
      return { success: r.returncode === 0, tool: 'pylint', output: r.stdout, errors: r.stderr, returncode: r.returncode };
    }
    if (tool === 'eslint') {
      const r = await runShell('npx', ['eslint', projectPath]);
      return { success: r.returncode === 0, tool: 'eslint', output: r.stdout, errors: r.stderr, returncode: r.returncode };
    }
    if (tool === 'prettier') {
      const r = await runShell('npx', ['prettier', '--check', projectPath]);
      return { success: r.returncode === 0, tool: 'prettier', output: r.stdout, errors: r.stderr, returncode: r.returncode };
    }
    return { success: false, error: `Unsupported tool: ${tool}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function buildProject(command = 'auto') {
  try {
    if (command === 'auto') {
      if (fsSync.existsSync('package.json')) command = 'npm run build';
      else if (fsSync.existsSync('Makefile')) command = 'make';
      else return { success: false, error: 'Could not auto-detect build command' };
    }
    const result = await runShell(command, [], { shell: true });
    return {
      success: result.returncode === 0,
      command,
      output: result.stdout || '',
      errors: result.stderr || '',
      returncode: result.returncode,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  TOOLS,
  runTool,
  buildRegistry,
  webSearch,
  webFetch,
  whoisLookup,
  dnsLookup,
  reverseDns,
  crtshLookup,
  virustotalLookup,
  abuseipdbLookup,
  shodanLookup,
  getSystemInfo,
  listFiles,
  readFileTool,
  listProcesses,
  getNetworkConnections,
  createFile,
  editFile,
  createDirectory,
  renameFile,
  copyFile,
  runTests,
  installDependencies,
  runLinter,
  buildProject,
  MAX_FETCH_CHARS,
  MAX_DOWNLOAD_BYTES,
  USER_AGENT,
};
