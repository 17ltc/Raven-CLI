'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { ChatBackend, MultiBackendRouter } = require('../src/backend');

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const sse = (res, chunks) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\r\n\r\n`);
  res.end('data: [DONE]\n\n');
};

test('streams content and native reasoning', async () => {
  const { server, url } = await serve((req, res) =>
    sse(res, [
      { choices: [{ delta: { reasoning_content: 'hmm ' } }] },
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
    ])
  );
  const b = new ChatBackend({ base_url: url, model: 'm', timeout: 5, max_tokens: 100, temperature: 0 });
  const got = [];
  const reasoning = [];
  const out = await b.chat([{ role: 'user', content: 'x' }], { onChunk: (c) => got.push(c), onReasoning: (c) => reasoning.push(c) });
  server.close();
  assert.strictEqual(out, 'Hello');
  assert.deepStrictEqual(reasoning, ['hmm ']);
});

test('falls back to non-streaming when the server rejects stream', async () => {
  const { server, url } = await serve((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (JSON.parse(body).stream) {
        res.writeHead(400).end('no stream');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'plain reply' } }] }));
    });
  });
  const b = new ChatBackend({ base_url: url, model: 'm', timeout: 5, max_tokens: 100, temperature: 0 });
  const chunks = [];
  const out = await b.chat([{ role: 'user', content: 'x' }], { onChunk: (c) => chunks.push(c) });
  server.close();
  assert.strictEqual(out, 'plain reply');
  assert.deepStrictEqual(chunks, ['plain reply']);
});

test('adds the provider prefix when the gateway requires one', async () => {
  const seen = [];
  const { server, url } = await serve((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body);
      seen.push(payload.model);
      if (payload.model === 'llama3.1') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: "Unable to determine provider for model 'llama3.1'. Use a provider/model prefix." } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'routed reply' } }] }));
    });
  });
  const b = new ChatBackend({ base_url: url, model: 'llama3.1', provider: 'ollama', timeout: 5, max_tokens: 100, temperature: 0 });
  const out = await b.chat([{ role: 'user', content: 'x' }]);
  server.close();
  assert.strictEqual(out, 'routed reply');
  assert.deepStrictEqual(seen, ['llama3.1', 'ollama/llama3.1']);
  assert.strictEqual(b.cfg.model, 'ollama/llama3.1');
});

test('friendly errors: 401, connection refused', async () => {
  const { server, url } = await serve((req, res) => res.writeHead(401).end('nope'));
  const b = new ChatBackend({ base_url: url, model: 'm', timeout: 5, max_tokens: 100, temperature: 0 });
  await assert.rejects(b.chat([{ role: 'user', content: 'x' }]), /Authentication failed \(401\)/);
  server.close();
  const dead = new ChatBackend({ base_url: 'http://127.0.0.1:1', model: 'm', timeout: 5, max_tokens: 100, temperature: 0 });
  await assert.rejects(dead.chat([{ role: 'user', content: 'x' }]), /Cannot reach the backend/);
});

test('multi backend router falls back on rate limits', async () => {
  const { server: limited, url: limitedUrl } = await serve((req, res) => res.writeHead(429).end('slow down'));
  const { server: ok, url: okUrl } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'fallback reply' } }] }));
  });
  const router = new MultiBackendRouter([
    { name: 'primary', backend: new ChatBackend({ base_url: limitedUrl, model: 'a', timeout: 5, max_tokens: 100, temperature: 0 }) },
    { name: 'backup', backend: new ChatBackend({ base_url: okUrl, model: 'b', timeout: 5, max_tokens: 100, temperature: 0 }) },
  ]);
  const events = [];
  const out = await router.chat([{ role: 'user', content: 'x' }], { onFallback: (info) => events.push(info) });
  limited.close();
  ok.close();
  assert.strictEqual(out, 'fallback reply');
  assert.strictEqual(events.length, 1);
  assert.match(events[0].from, /primary/);
  assert.match(events[0].to, /backup/);
});

test('stalled stream times out instead of hanging', async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`);
    // never ends
  });
  const b = new ChatBackend({ base_url: url, model: 'm', timeout: 0.4, max_tokens: 100, temperature: 0 });
  await assert.rejects(b.chat([{ role: 'user', content: 'x' }], { onChunk() {} }), /timed out/);
  server.closeAllConnections();
  server.close();
});

test('AbortSignal interrupts a running request', async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`);
  });
  const b = new ChatBackend({ base_url: url, model: 'm', timeout: 10, max_tokens: 100, temperature: 0 });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  await assert.rejects(b.chat([{ role: 'user', content: 'x' }], { onChunk() {}, signal: ac.signal }), (e) => e.aborted === true);
  server.closeAllConnections();
  server.close();
});
