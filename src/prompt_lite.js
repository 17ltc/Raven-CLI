'use strict';
/**
 * Lightweight system prompt.
 *
 * The "full" prompt loads three skills (~8.5k tokens) plus a verbose list of
 * every tool (~2k tokens) on EVERY request. The lite prompt sends:
 *   - a compact protocol (~300 tokens)
 *   - core tools with a one-line description, the rest as `name(args)` only
 *   - the names of loadable skills (bodies are loaded on demand)
 * Skill bodies are pulled in automatically when the request matches (see
 * SKILL_TRIGGERS) or when the model writes `SKILL_REQUEST: name`.
 * The model can call `tool_help` for the exact description of any tool.
 */

const CORE_TOOLS = new Set([
  'write_file', 'create_file', 'edit_file', 'read_file', 'list_files', 'list_workspace', 'undo_file', 'delete_file',
  'ask_user',
  'create_directory', 'rename_file', 'copy_file', 'run_tests', 'install_dependencies', 'run_linter', 'build_project',
  'execute_command', 'web_search', 'web_fetch', 'project_tree', 'project_read', 'project_search', 'project_inspect',
  'project_diff', 'project_git', 'safe_edit', 'multi_file_edit', 'tool_help',
]);

/** Keyword triggers (EN + FR) that auto-load the default skills on demand. */
const SKILL_TRIGGERS = {
  'raven-code': /\b(code|coder|coding|script|fonction|function|class|classe|bug|debug\w*|refactor\w*|fichier|files?|cr[ée]e[rz]?|create|[ée]cri[st]\w*|write|edit\w*|modifi\w*|fix\w*|corrig\w*|tests?|projet|project|app|application|api|composant|component|html|css|jsx?|tsx?|python|node|react|repo|compile|build|impl[ée]ment\w*|renomm\w*|rename|supprim\w*|delete)\b|@\S+/i,
  cmd: /\b(commandes?|command|terminal|shell|bash|powershell|ex[ée]cute\w*|execute|run|lance\w*|install\w*|npm|pip|docker|sudo)\b/i,
  'osint-suite': /\b(osint|cti|ioc|threat|menaces?|malware|domaine|domain|whois|dns|ip|cve|hash|sha256|md5|phishing|apt|recon\w*|virustotal|shodan|certificat\w*|urls?|leaks?|fuites?|breach|attack surface|surface d'attaque)\b/i,
  // Legacy result name retained so existing tests/configs can migrate safely.
  'osint-threat-intel': /\b(osint|cti|ioc|threat|menaces?|malware|domaine|domain|whois|dns|ip|cve|hash|sha256|md5|phishing|apt|recon\w*|virustotal|shodan|certificat\w*|urls?|leaks?|fuites?|breach|attack surface|surface d'attaque)\b/i,
  'telegram-suite': /\btelegram|t[ée]l[ée]gram|chat bot|bot telegram\b/i,
  'discord-suite': /\bdiscord|guild|server|channel|moderation|moderate|bot|community\b/i,
  'context-engineering': /\bcontext|contexte|compact|mémoire|memoire|RAVEN\.md|prompt engineering\b/i,
};

function argSignature(description) {
  const m = /Args:\s*(\{[\s\S]*\})/.exec(description) || /Args:\s*(\{[^}]*\})/.exec(description);
  if (!m) return '()';
  const inner = m[1].slice(1, -1);
  const keys = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if ('[{('.includes(ch)) depth += 1;
    if (']})'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      keys.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) keys.push(cur);
  return `(${keys.map((k) => k.split(':')[0].trim()).filter(Boolean).join(', ')})`;
}

function shortDescription(description, max = 64) {
  let s = description.replace(/Args:[\s\S]*$/, '').trim();
  const dot = s.search(/[.!?](\s|$)/);
  if (dot > 0) s = s.slice(0, dot);
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

function compactToolList(registry) {
  const tools = registry.list();
  const core = [];
  const rest = [];
  for (const t of tools) {
    const sig = `${t.name}${argSignature(t.description)}`;
    if (CORE_TOOLS.has(t.name)) core.push(`- ${sig}: ${shortDescription(t.description)}`);
    else rest.push(sig);
  }
  return `${core.join('\n')}\n\nOther tools (call tool_help {"name": ...} for details): ${rest.join(', ')}`;
}

function buildLitePrompt({ registry, skillNames = [], loadedBodies = [] }) {
  const parts = [
    `You are Raven, a terminal agent for software development and defensive OSINT/CTI. Reply in the user's language.

## Protocol (every turn)
1. If a tool is needed, briefly state the action (no chain-of-thought), then call ONE tool:
\`\`\`tool
{"name": "tool_name", "arguments": {"key": "value"}}
\`\`\`
and wait for the "TOOL RESULT" (never invent results), OR give the final answer as Markdown with no tool block, stating your confidence.

Rules:
- Be concise. For greetings and simple questions, answer directly without tools, confidence labels, or long explanations.
- Mention confidence, source reliability, or Admiralty ratings only when the user asks for them or requests OSINT/research verification.
- For any file/project request call the file tools first; a task is done only when a tool result confirms it. Do not paste file contents in the answer unless asked - confirm the path.
- Keep tool JSON valid and closed. Unsure about a tool's arguments? Call tool_help.
- Need more expertise? First call \`skill_search\`, then call \`skill_load\` for the best matching skill. You may also write \`SKILL_REQUEST: skill-name\` inside your thinking block.
- Loadable skills: ${skillNames.join(', ') || '(none)'}.

## Tools
${compactToolList(registry)}`,
  ];
  for (const body of loadedBodies) parts.push(body);
  return parts.join('\n\n');
}

/** Which default skills does this message call for? */
function skillsForMessage(text) {
  return Object.entries(SKILL_TRIGGERS)
    .filter(([, rx]) => rx.test(text))
    .map(([name]) => name);
}

/** Register the `tool_help` meta-tool (full description on demand). */
function registerToolHelp(registry) {
  registry.register(
    'tool_help',
    'Show the full description and arguments of a tool, or search tools by keyword. Args: {name?: str, query?: str}',
    ({ name, query } = {}) => {
      if (name) {
        const tool = registry.get(name);
        if (!tool) return { error: `Tool '${name}' not found. Try {"query": "keyword"}.` };
        return { name: tool.name, description: tool.description };
      }
      const q = String(query || '').toLowerCase();
      if (!q) return { error: 'Provide {"name": "..."} or {"query": "..."}' };
      const hits = registry
        .list()
        .filter((t) => t.name.includes(q) || t.description.toLowerCase().includes(q))
        .slice(0, 12)
        .map((t) => ({ name: t.name, description: shortDescription(t.description, 100), args: argSignature(t.description) }));
      return { query: q, matches: hits };
    }
  );
}

module.exports = { buildLitePrompt, skillsForMessage, registerToolHelp, compactToolList, argSignature, shortDescription, SKILL_TRIGGERS };
