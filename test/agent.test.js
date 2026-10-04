'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Agent } = require('../src/core/agent');
const { ToolRegistry } = require('../src/core');

function makeAgent(replies, tools = {}) {
  const seen = [];
  const backend = {
    async chat(messages, opts = {}) {
      seen.push(messages);
      const r = replies.shift();
      if (typeof r === 'function') return r(opts);
      if (opts.onChunk) opts.onChunk(r);
      return r;
    },
  };
  const registry = new ToolRegistry();
  for (const [name, fn] of Object.entries(tools)) registry.register(name, name, fn);
  const agent = new Agent({}, registry, backend, { showThinking: true, maxIterations: 6 });
  agent.messages = [{ role: 'system', content: 'sys' }];
  return { agent, seen };
}

test('runs a tool then returns the final answer', async () => {
  const { agent } = makeAgent(['```thinking\nplan\n```\n```tool\n{"name":"echo","arguments":{"x":1}}\n```', 'Done.'], { echo: async ({ x }) => ({ success: true, x }) });
  const events = [];
  const out = await agent.process('hi', (e) => events.push(e));
  assert.strictEqual(out, 'Done.');
  assert.ok(events.includes('tool_call') && events.includes('tool_result') && events.includes('thinking'));
});

test('invalid tool JSON is sent back to the model instead of shown as the answer', async () => {
  const { agent, seen } = makeAgent(['```tool\n{oops}\n```', 'Fixed answer'], {});
  const out = await agent.process('hi');
  assert.strictEqual(out, 'Fixed answer');
  assert.match(seen[1][seen[1].length - 1].content, /could not be used/);
});

test('truncated tool blocks are compacted and do not retry forever', async () => {
  const broken = '```tool\n{"name":"write_file","arguments":{"path":"package.json","content":"' + 'x'.repeat(5000);
  const { agent, seen } = makeAgent([broken, broken, broken], {});
  await assert.rejects(agent.process('create the project'), /invalid or truncated tool call twice/);
  assert.ok(seen[1].every((m) => !String(m.content || '').includes('x'.repeat(1000))));
});

test('empty reply after thinking triggers a nudge', async () => {
  const { agent } = makeAgent(['```thinking\nhmm\n```', 'Real answer'], {});
  assert.strictEqual(await agent.process('hi'), 'Real answer');
});

test('thinking hidden still allows skill requests', async () => {
  let requested = null;
  const { agent } = makeAgent(['```thinking\nSKILL_REQUEST: frontend-design\n```\nok'], {});
  agent.showThinking = false;
  agent.skillLoaderCallback = async (n) => {
    requested = n;
    return 'x';
  };
  await agent.process('hi');
  assert.strictEqual(requested, 'frontend-design');
});

test('abort stops the turn and marks history', async () => {
  const { agent } = makeAgent([
    (opts) =>
      new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('Interrupted');
          e.aborted = true;
          reject(e);
        });
      }),
  ]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(agent.process('hi', null, { signal: ac.signal }), (e) => e.aborted);
  assert.match(agent.messages[agent.messages.length - 1].content, /Interrupted/);
});

test('long tool runs can be interrupted', async () => {
  const { agent } = makeAgent(['```tool\n{"name":"slow","arguments":{}}\n```'], { slow: () => new Promise((r) => setTimeout(r, 5000)) });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 60);
  const t0 = Date.now();
  await assert.rejects(agent.process('hi', null, { signal: ac.signal }), (e) => e.aborted);
  assert.ok(Date.now() - t0 < 2000);
});

test('context trimming keeps the system message', () => {
  const { agent } = makeAgent([]);
  agent.config = { max_context_chars: 1000 };
  for (let i = 0; i < 30; i++) agent.messages.push({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(200) });
  agent._trimContext();
  assert.strictEqual(agent.messages[0].content, 'sys');
  assert.ok(agent.messages.length < 31);
});
