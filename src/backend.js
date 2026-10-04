'use strict';
/**
 * Backend adapter.
 * Port of Raven/backend.py
 *
 * Almost every LLM server people run today - Ollama, LM Studio, OpenRouter,
 * NVIDIA NIM, vLLM, text-generation-webui, LocalAI, Groq, Together, etc. -
 * exposes (or can expose) an OpenAI-compatible `/v1/chat/completions` endpoint.
 * So instead of writing one adapter per provider, this is a single client
 * parametrized by base_url / api_key / model. The presets below just fill in
 * the base_url + default port for the common local/hosted options; "custom"
 * covers literally anything else.
 */

// Known presets. base_url should NOT include a trailing slash.
// api_key_env: name of the environment variable holding the key (null = no key needed, e.g. local servers)
const PRESETS = {
  ollama: {
    base_url: 'http://localhost:11434/v1',
    api_key_env: null,
    note: "Run `ollama serve` first. Model name = whatever you `ollama pull`ed, e.g. 'llama3.1'.",
  },
  lmstudio: {
    base_url: 'http://localhost:1234/v1',
    api_key_env: null,
    note: "Start the local server from LM Studio's 'Developer' tab first.",
  },
  openrouter: {
    base_url: 'https://openrouter.ai/api/v1',
    api_key_env: 'OPENROUTER_API_KEY',
    note: "Model names look like 'meta-llama/llama-3.1-70b-instruct'. See openrouter.ai/models.",
  },
  nvidia: {
    base_url: 'https://integrate.api.nvidia.com/v1',
    api_key_env: 'NVIDIA_API_KEY',
    note: "NVIDIA NIM. Model names look like 'meta/llama-3.1-70b-instruct'.",
  },
  vllm: {
    base_url: 'http://localhost:8000/v1',
    api_key_env: null,
    note: 'Default vLLM OpenAI-compatible server address.',
  },
  custom: {
    base_url: null,
    api_key_env: null,
    note: 'Provide --base-url yourself (and --api-key-env if the endpoint needs auth).',
  },
  omniroute: {
    base_url: 'http://localhost:20128/v1',
    api_key_env: 'OMNIROUTE_API_KEY',
    note: 'OmniRoute local inference server. Run omniroute first.',
  },
};

class BackendConfig {
  constructor({ base_url, model, provider = null, api_key = null, temperature = 0.3, max_tokens = 2048, timeout = 120 }) {
    this.base_url = base_url;
    this.model = model;
    this.provider = provider;
    this.api_key = api_key;
    this.temperature = temperature;
    this.max_tokens = max_tokens;
    this.timeout = timeout;
  }
}

function abortError() {
  const e = new Error('Interrupted');
  e.name = 'AbortError';
  e.aborted = true;
  return e;
}

/** Message content can be a string or an array of {type:'text', text}. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  return '';
}

function describeHttpError(status, url, body) {
  const detail = body ? ` ${body}` : '';
  if (status === 401 || status === 403) return `Authentication failed (${status}). Check your API key / the API key env var for this backend.${detail}`;
  if (status === 404) return `Not found (404) at ${url}. Check the base URL and that the model name exists on this server.${detail}`;
  if (status === 429) return `Rate limited (429) by the backend. Wait a moment and retry.${detail}`;
  if (status >= 500) return `The backend returned a server error (${status}).${detail}`;
  return `Backend error ${status} from ${url}:${detail}`;
}

function backendError(message, props = {}) {
  const e = new Error(message);
  Object.assign(e, props);
  return e;
}

function isRetryableBackendError(e) {
  if (!e) return false;
  if (e.aborted || e.name === 'AbortError') return false;
  if (e.retryable) return true;
  return /rate limited|timed out|Cannot reach the backend|server error/i.test(e.message || '');
}

/** Thin client for POST {base_url}/chat/completions. */
class ChatBackend {
  constructor(cfg) {
    this.cfg = cfg;
  }

  /**
   * @param {Array<{role:string, content:string}>} messages
   * @param {{onChunk?: (chunk:string)=>void, onReasoning?: (chunk:string)=>void, signal?: AbortSignal}} [opts]
   * @returns {Promise<string>}
   */
  async chat(messages, opts = {}) {
    const onChunk = opts.onChunk || null;
    const onReasoning = opts.onReasoning || null;
    const signal = opts.signal || null;
    const baseUrl = this.cfg.base_url.replace(/\/+$/, '');
    const url = `${baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.cfg.api_key) headers.Authorization = `Bearer ${this.cfg.api_key}`;

    // Some config files can contain an old or accidental token value far
    // above what a backend can accept. Keep enough room for long code
    // responses without allowing one request to consume the full context.
    const maxTokens = Math.max(256, Math.min(parseInt(this.cfg.max_tokens, 10) || 0, 32768));
    const payload = {
      model: this.cfg.model,
      messages,
      temperature: this.cfg.temperature,
      max_tokens: maxTokens,
      stream: Boolean(onChunk),
    };

    if (signal && signal.aborted) throw abortError();

    // One controller covers user-interrupt AND an idle timeout that stays armed
    // for the whole response (the old timer was cleared as soon as headers
    // arrived, so a stalled stream hung forever).
    const controller = new AbortController();
    const timeoutMs = (this.cfg.timeout || 120) * 1000;
    let timedOut = false;
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    };
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const post = () => fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });

    try {
      arm();
      let resp = await post();

      if (onChunk && [400, 404, 405, 422].includes(resp.status)) {
        // Some OpenAI-compatible servers do not implement SSE streaming.
        payload.stream = false;
        resp = await post();
      }

      if (!resp.ok) {
        const text = (await resp.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
        const needsProvider = resp.status === 400 && /Unable to determine provider|provider\/model prefix/i.test(text);
        const provider = this.cfg.provider || (/localhost:20128(?:\/|$)/i.test(baseUrl) ? 'ollama' : null);
        if (needsProvider && provider && !String(payload.model).includes('/')) {
          payload.model = `${provider}/${payload.model}`;
          this.cfg.model = payload.model;
          resp = await post();
          if (!resp.ok) {
            const retryText = (await resp.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
            throw backendError(describeHttpError(resp.status, url, retryText), {
              status: resp.status,
              retryable: resp.status === 429 || resp.status >= 500,
            });
          }
        } else {
          throw backendError(describeHttpError(resp.status, url, text), {
            status: resp.status,
            retryable: resp.status === 429 || resp.status >= 500,
          });
        }
      }

      if (onChunk && payload.stream) {
        return await this._streamResponse(resp, onChunk, onReasoning, arm);
      }

      const data = await resp.json();
      if (data && data.error) throw new Error(`Backend error: ${typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error)}`);
      try {
        const text = contentToText(data.choices[0].message.content);
        if (onChunk && text) onChunk(text);
        return text;
      } catch (e) {
        throw new Error(`Unexpected response shape from backend: ${JSON.stringify(data).slice(0, 500)}`);
      }
    } catch (e) {
      if (signal && signal.aborted) throw abortError();
      if (timedOut) throw backendError(`Backend timed out after ${timeoutMs / 1000}s (${url}). Raise backend.timeout in ~/.raven/config.json or use a faster model.`, { retryable: true });
      if (e && e.name === 'TypeError' && /fetch failed/i.test(e.message)) {
        const code = (e.cause && (e.cause.code || e.cause.message)) || 'network error';
        throw backendError(`Cannot reach the backend at ${baseUrl} (${code}). Is the server running and is the base URL correct?`, { retryable: true });
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async _streamResponse(resp, onChunk, onReasoning, onActivity) {
    const parts = [];
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finished = false;

    const handleLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line || !line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') {
        finished = true;
        return;
      }
      let delta;
      try {
        delta = JSON.parse(raw);
      } catch (e) {
        return;
      }
      if (delta.error) {
        throw new Error(`Backend error: ${typeof delta.error === 'string' ? delta.error : delta.error.message || JSON.stringify(delta.error)}`);
      }
      const d = delta.choices && delta.choices[0] && delta.choices[0].delta;
      if (!d) return;
      // Models with native reasoning (DeepSeek, Qwen...) stream it separately.
      const reasoning = d.reasoning_content || d.reasoning || '';
      if (reasoning && onReasoning) onReasoning(reasoning);
      const content = contentToText(d.content);
      if (content) {
        parts.push(content);
        onChunk(content);
      }
    };

    const reader = resp.body.getReader();
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      onActivity();
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while (!finished && (idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    }
    if (!finished && buffer) handleLine(buffer);
    if (finished) {
      try {
        await reader.cancel();
      } catch (e) {
        /* ignore */
      }
    }
    return parts.join('');
  }
}

class MultiBackendRouter {
  constructor(routes = []) {
    this.routes = routes.filter((route) => route && route.backend);
    if (!this.routes.length) throw new Error('MultiBackendRouter requires at least one backend route');
    this.index = 0;
    this.cfg = this.routes[0].backend.cfg;
  }

  currentRoute() {
    return this.routes[this.index] || this.routes[0];
  }

  describeRoute(route = this.currentRoute()) {
    const cfg = route.backend.cfg;
    return `${route.name || cfg.model} (${cfg.provider || route.provider || 'provider'}:${cfg.model})`;
  }

  async chat(messages, opts = {}) {
    let lastError = null;
    const start = this.index >= 0 && this.index < this.routes.length ? this.index : 0;
    const order = [...this.routes.slice(start), ...this.routes.slice(0, start)];
    for (const route of order) {
      const idx = this.routes.indexOf(route);
      this.index = idx;
      this.cfg = route.backend.cfg;
      try {
        return await route.backend.chat(messages, opts);
      } catch (e) {
        lastError = e;
        if (!isRetryableBackendError(e)) throw e;
        const next = order[order.indexOf(route) + 1];
        if (opts.onFallback && next) {
          opts.onFallback({
            from: this.describeRoute(route),
            to: this.describeRoute(next),
            reason: e.message,
          });
        }
      }
    }
    throw lastError || new Error('No backend route could answer');
  }
}

module.exports = { PRESETS, BackendConfig, ChatBackend, MultiBackendRouter, isRetryableBackendError };
