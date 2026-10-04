'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ConfigManager, ToolRegistry, registerBuiltInTools } = require('../src/core');
const { buildLitePrompt, registerToolHelp, skillsForMessage, argSignature } = require('../src/prompt_lite');

function registry() {
  const r = new ToolRegistry();
  registerBuiltInTools(r, new ConfigManager('/tmp/rv-test-cfg.json').get());
  registerToolHelp(r);
  return r;
}

test('lite prompt stays small and lists every tool', () => {
  const r = registry();
  const prompt = buildLitePrompt({ registry: r, skillNames: ['a', 'b'] });
  assert.ok(prompt.length / 4 < 2500, `prompt too big: ~${Math.round(prompt.length / 4)} tokens`);
  for (const t of r.list()) assert.ok(prompt.includes(t.name), `missing ${t.name}`);
  assert.match(prompt, /Loadable skills: a, b/);
});

test('tool_help returns details or searches', async () => {
  const r = registry();
  const one = await r.execute('tool_help', { name: 'edit_file' });
  assert.match(one.description, /old_content/);
  const search = await r.execute('tool_help', { query: 'rename' });
  assert.ok(search.matches.some((m) => m.name === 'rename_file'));
  assert.ok((await r.execute('tool_help', { name: 'nope' })).error);
});

test('skills load on demand (EN + FR) and signatures are compact', () => {
  assert.deepStrictEqual(skillsForMessage('salut ça va'), []);
  assert.ok(skillsForMessage('crée un fichier html').includes('raven-code'));
  assert.ok(skillsForMessage('run npm install').includes('cmd'));
  assert.ok(skillsForMessage('whois example.com').includes('osint-threat-intel'));
  assert.ok(skillsForMessage('lis @src/app.js').includes('raven-code'));
  assert.strictEqual(argSignature('Do x. Args: {old_path: str, new_path: str}'), '(old_path, new_path)');
  assert.strictEqual(argSignature('No args here'), '()');
});
