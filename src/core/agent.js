'use strict';
/**
 * Core Agent Module
 * Port of Raven/core/agent.py
 *
 * The AI agent that orchestrates tool calls, manages context, and provides
 * responses. This is the brain of Raven - reusable across all interfaces.
 */

// Strict form requires a real newline before the closing fence so a ``` inside
// a JSON string (e.g. file content with code fences) can't end the block early.
const TOOL_BLOCK_RE = /```tool\s*\n([\s\S]*?)\n```/g;
const TOOL_BLOCK_LENIENT_RE = /```tool\s*\n([\s\S]*?\})[ \t]*```/g;
const TOOL_OPEN_RE = /```tool\b/g;
const THINKING_BLOCK_RE = /```thinking\s*\n([\s\S]*?)\n```/g;
const THINKING_OPEN_TAIL_RE = /```thinking\s*\n([\s\S]*)$/;

function abortError() {
  const e = new Error('Interrupted');
  e.name = 'AbortError';
  e.aborted = true;
  return e;
}

/** Resolve with `promise`, or reject as soon as `signal` aborts. */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}
// eslint-disable-next-line no-unused-vars
const TASK_BLOCK_RE = /```task\s*\n([\s\S]*?)\n```/g;

function buildSystemPrompt() {
  return `You are Raven, an intelligent assistant with dynamic skill loading.

You have the ability to detect when additional skills might be needed and can request them automatically.

Be concise and useful. Answer greetings and simple questions directly in one short response.
Do not expose chain-of-thought or private reasoning. Use a brief progress note only when a
tool call is needed. Do not mention confidence, reliability, or source grading unless the
user explicitly asks for an assessment, verification, OSINT report, or uncertainty analysis.

Skill Detection:
If you detect that the user's request requires expertise you don't currently have (e.g., frontend design, specialized analysis),
you can request additional skills by using this format in your thinking:
SKILL_REQUEST: skill_name

Available skills that can be loaded:
- frontend-design: UI/UX design, component architecture, responsive layouts, accessibility
- cmd: Shell command execution with user confirmation
(plus your currently loaded skills)

Tool format:
\`\`\`tool
{"name": "tool_name", "arguments": {"key": "value"}}
\`\`\`

IMPORTANT - File Creation:
When you create or edit files, always use a tool block and wait for its result.
Prefer write_file for complete files and keep the JSON tool block valid and
closed before stopping. Never paste a huge unfinished tool block as a final answer.
If the user explicitly asks to create, edit, rename, delete, or inspect a local
file, do not answer with invented content, poetry, or a description of the file.
Call the appropriate file/project tool first. A request is only complete after
the tool result confirms the operation.
When you create files using the write_file or create_file tool:
- DO NOT show the full file content in your response
- Simply confirm that the file was created at the returned path.
- Only show file content if the user specifically asks to see it
- This keeps conversations clean and focused

After using tools, provide only the result and the next useful action, without filler.`;
}

class Agent {
  /**
   * @param {object} config CoreConfig
   * @param {import('./tools').ToolRegistry} toolRegistry
   * @param {{chat: Function}} backendClient object exposing chat(messages, {onChunk})
   * @param {object} [opts]
   */
  constructor(config, toolRegistry, backendClient, opts = {}) {
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.backend = backendClient;
    this.maxIterations = opts.maxIterations ?? 32;
    this.showThinking = opts.showThinking ?? true;
    this.skillsRoot = opts.skillsRoot ?? null;
    this.skillLoaderCallback = opts.skillLoaderCallback ?? null;
    this.loadedSkills = new Set();
    this.messages = [];
    this.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0, estimated: true };
    this._initializeSystemPrompt();
  }

  _initializeSystemPrompt() {
    this.messages.push({ role: 'system', content: buildSystemPrompt(), tool_calls: null, timestamp: null });
  }

  addMessage(role, content, toolCalls = null) {
    this.messages.push({ role, content, tool_calls: toolCalls, timestamp: new Date().toISOString() });
  }

  /**
   * Process user input and return the final response.
   * @param {string} userInput
   * @param {Function} [callback] callback(event, payload)
   * @param {{signal?: AbortSignal}} [opts]
   */
  async process(userInput, callback = null, opts = {}) {
    const signal = opts.signal || null;
    this.addMessage('user', userInput);
    // Keep a handle on the message: the (large) project context prepended to it
    // is only needed while this turn runs, so it is swapped for the plain text
    // afterwards instead of being re-sent with every later request.
    const userMessage = this.messages[this.messages.length - 1];
    let nudges = 0;
    let malformedToolRetries = 0;

    try {
      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        if (signal && signal.aborted) throw abortError();
        this._trimContext();
        if (callback) callback('request', { iteration });

        const before = this.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
        const response = await this._callBackend(callback, signal);
        const after = before + estimateTokens(response);
        this.usage.prompt_tokens += before;
        this.usage.completion_tokens += estimateTokens(response);
        this.usage.total_tokens += estimateTokens(response) + before;
        this.usage.requests += 1;
        this.addMessage('assistant', response);

        const [thinking, remainder] = this._extractThinking(response);

        if (thinking) {
          if (callback && this.showThinking) callback('thinking', thinking);
          // Skill requests work even when the reasoning display is hidden.
          const skillRequest = this._extractSkillRequest(thinking);
          if (skillRequest && this.skillLoaderCallback) await this._loadSkill(skillRequest);
        }

        const { calls, problems } = this._parseToolBlocks(remainder);

        if (!calls.length) {
          // Do not keep a huge truncated tool payload in the context. It makes
          // the model repeat the same broken response until the safety limit.
          if (problems.length && malformedToolRetries < 1) {
            malformedToolRetries += 1;
            const compactReason = problems.join('; ');
            const lastAssistant = this.messages[this.messages.length - 1];
            if (lastAssistant && lastAssistant.role === 'assistant') {
              lastAssistant.content = `[Malformed tool response omitted: ${compactReason}]`;
            }
            this.addMessage(
              'user',
              `SYSTEM NOTICE: your last tool block was invalid or truncated and could not be used (${compactReason}). ` +
                'Retry once with ONE valid, closed tool block containing a single JSON object {"name": ..., "arguments": {...}}. ' +
                'For large files, split the work into several smaller write_file calls. Do not repeat an unfinished payload.'
            );
            if (callback) callback('notice', `Model sent an invalid tool block (${problems[0]}); asking it to retry`);
            continue;
          }
          if (problems.length) {
            throw new Error(`The model returned an invalid or truncated tool call twice (${problems.join('; ')}). The unfinished tool payload was not executed.`);
          }
          if (!remainder.trim()) {
            if (nudges < 3) {
              nudges += 1;
              this.addMessage('user', 'SYSTEM NOTICE: your last message had no final answer and no tool call. Give your final answer now.');
              if (callback) callback('notice', 'Model returned no answer; asking it to continue');
              continue;
            }
            return thinking || '(The model returned an empty response.)';
          }
          return remainder;
        }

        for (const toolCall of calls) {
          if (signal && signal.aborted) throw abortError();
          if (callback) callback('tool_call', toolCall);

          const result = await raceAbort(this._executeTool(toolCall), signal);
          toolCall.result = result;

          if (callback) callback('tool_result', result, toolCall);

          let serialized = JSON.stringify(result, null, 2) || 'null';
          if (serialized.length > 8000) serialized = `${serialized.slice(0, 8000)}\n...[truncated, ${serialized.length} chars]`;
          this.addMessage('user', `TOOL RESULT for ${toolCall.name}:\n${serialized}`);
        }
      }
    } catch (e) {
      if (e && (e.aborted || e.name === 'AbortError')) {
        this.addMessage('assistant', '[Interrupted by the user before finishing.]');
        throw abortError();
      }
      throw e;
    } finally {
      if (typeof opts.persistInput === 'string') userMessage.content = opts.persistInput;
    }

    return '[Raven stopped after the safety limit before producing a final synthesis. The collected tool results remain in the session history; ask for a synthesis or raise max_iterations in config.]';
  }

  _callBackend(callback = null, signal = null) {
    const messages = this.messages.map((m) => ({ role: m.role, content: m.content }));
    return this.backend.chat(messages, {
      signal,
      onChunk: callback ? (chunk) => callback('stream', chunk) : null,
      onReasoning: callback ? (chunk) => callback('reasoning', chunk) : null,
      onFallback: callback ? (info) => callback('backend_fallback', info) : null,
    });
  }

  /** Drop the oldest turns when the conversation outgrows the context budget. */
  _trimContext() {
    const limit = (this.config && this.config.max_context_chars) || 120000;
    const size = (m) => String(m.content || '').length;
    let total = this.messages.reduce((a, m) => a + size(m), 0);
    if (total <= limit) return;
    let dropped = 0;
    while (total > limit && this.messages.length > 8) {
      // Preserve the current turn and the latest tool evidence; remove the
      // oldest complete turn first, then aggressively cap stale tool output.
      let index = this.messages.findIndex((m, i) => i > 0 && i < this.messages.length - 6 && m.role !== 'system');
      if (index < 1) index = 1;
      const [gone] = this.messages.splice(index, 1);
      total -= size(gone);
      dropped += 1;
    }
    if (dropped) {
      this.messages.splice(1, 0, {
        role: 'user',
        content: `[${dropped} earlier messages were trimmed to fit the context window.]`,
        tool_calls: null,
        timestamp: null,
      });
    }
  }

  _extractThinking(text) {
    const parts = [];
    let remainder = text.replace(THINKING_BLOCK_RE, (m, body) => {
      parts.push(body.trim());
      return '';
    });
    // A reply cut off while still "thinking" (no closing fence).
    const tail = THINKING_OPEN_TAIL_RE.exec(remainder);
    if (tail) {
      parts.push(tail[1].trim());
      remainder = remainder.slice(0, tail.index);
    }
    return [parts.filter(Boolean).join('\n\n'), remainder.trim()];
  }

  /** Parse ```tool blocks. Returns valid calls plus human-readable problems. */
  _parseToolBlocks(text) {
    const calls = [];
    const problems = [];
    const opened = (text.match(TOOL_OPEN_RE) || []).length;
    let closed = 0;
    for (const rx of [TOOL_BLOCK_RE, TOOL_BLOCK_LENIENT_RE]) {
      if (closed > 0) break;
      rx.lastIndex = 0;
      let match;
      while ((match = rx.exec(text)) !== null) {
        closed += 1;
        try {
          const data = JSON.parse(match[1]);
          if (!data || typeof data.name !== 'string' || !data.name) {
            problems.push('missing "name"');
            continue;
          }
          const args = data.arguments && typeof data.arguments === 'object' && !Array.isArray(data.arguments) ? data.arguments : {};
          calls.push({ name: data.name, arguments: args, result: null, error: null });
        } catch (e) {
          problems.push(`invalid JSON: ${e.message}`);
        }
      }
    }
    if (opened > closed) problems.push('block was never closed (reply cut off?)');
    return { calls, problems };
  }

  _extractToolCalls(text) {
    return this._parseToolBlocks(text).calls;
  }

  async _executeTool(toolCall) {
    return this.toolRegistry.execute(toolCall.name, toolCall.arguments);
  }

  reset() {
    this.messages = [];
    this._initializeSystemPrompt();
  }

  getHistory() {
    return this.messages.map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp }));
  }

  _extractSkillRequest(thinking) {
    const match = /SKILL_REQUEST:\s*([\w-]+)/.exec(thinking);
    if (match) {
      const skillName = match[1];
      if (!this.loadedSkills.has(skillName)) return skillName;
    }
    return null;
  }

  async _loadSkill(skillName) {
    if (!this.skillLoaderCallback) return;
    try {
      const [success, message] = await this.skillLoaderCallback(skillName);
      if (success) {
        this.loadedSkills.add(skillName);
        this.addMessage('system', `Skill '${skillName}' has been loaded and is now available.`);
      } else {
        this.addMessage('system', `Failed to load skill '${skillName}': ${message}`);
      }
    } catch (e) {
      this.addMessage('system', `Error loading skill '${skillName}': ${e.message}`);
    }
  }
}

function estimateTokens(value) {
  const text = String(value || '');
  if (!text) return 0;
  // Conservative multilingual estimate: punctuation and code are denser than
  // plain English, so 3.5 chars/token avoids under-reporting context usage.
  return Math.max(1, Math.ceil(text.length / 3.5));
}

Agent.estimateTokens = estimateTokens;

module.exports = { Agent, abortError, raceAbort };
