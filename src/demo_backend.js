'use strict';
/**
 * Offline demo backend (`raven --demo`). Streams a scripted reply with a
 * thinking block, one tool call and a Markdown answer, so the UI can be tried
 * (and tested) without any LLM server.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THINKING_1 =
  'The user wants an overview. I know the workspace exists but not what is in it yet.\n' +
  'Plan: list the workspace first, then summarise what I find.\n' +
  'Source reliability: local filesystem listing (A1) - no need to cross-check.';

const ANSWER = `# Raven demo

I checked the workspace and here is what I found.

## What I did
- Listed the **workspace** folder with \`list_workspace\`
- Kept the *reasoning* visible above so you can follow along
- Nothing was modified

## Sample code
\`\`\`js
// rendered with light syntax colors
function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

| Feature | Status |
|---------|--------|
| Live input while thinking | on |
| Slash menu | on |
| Queue | on |

> Type another message now: it is queued until I finish.

Confidence: **high** (local data only).`;

class DemoBackend {
  constructor() {
    this.cfg = { model: 'raven-demo', base_url: 'demo://local', timeout: 60 };
  }

  async _emit(text, opts, delay = 14) {
    const { onChunk, signal } = opts;
    for (let i = 0; i < text.length; i += 6) {
      if (signal && signal.aborted) {
        const e = new Error('Interrupted');
        e.name = 'AbortError';
        e.aborted = true;
        throw e;
      }
      if (onChunk) onChunk(text.slice(i, i + 6));
      await sleep(delay);
    }
  }

  async chat(messages, opts = {}) {
    const last = messages[messages.length - 1].content || '';
    let reply;
    const think = (t) => `\`\`\`thinking\n${t}\n\`\`\`\n`;
    const tool = (name, args) => `\`\`\`tool\n${JSON.stringify({ name, arguments: args })}\n\`\`\``;
    const attached = /<file path="([^"]+)">/.exec(last);

    if (/^TOOL RESULT for (create_file|edit_file)/.test(last)) {
      reply = `${think('The tool confirmed the write. I can report back.')}Done. The change is applied in \`workspace/demo-hello.js\`.\n\nRun **/undo** to revert it, or **/redo** to bring it back.`;
    } else if (/^TOOL RESULT/.test(last)) {
      reply = `${think('The listing came back. Nothing surprising, I can summarise now.')}${ANSWER}`;
    } else if (attached && !/^TOOL RESULT/.test(last)) {
      reply = `${think(`The user attached ${attached[1]}. I can answer from it directly.`)}I read the attached file **${attached[1]}** (${last.length} characters of prompt).`;
    } else if (/(modifie|edit|update|change)/i.test(last)) {
      reply = `${think('Small edit: greeting in French, plus a second log line.')}${tool('edit_file', { path: 'demo-hello.js', old_content: "return `Hello, ${name}!`;\n}\nconsole.log(hello('Raven'));", new_content: "return `Bonjour, ${name} !`;\n}\nconsole.log(hello('Raven'));\nconsole.log('done');" })}`;
    } else if (/(cr[ée]e|create|write|[ée]cris)/i.test(last)) {
      reply = `${think('I will create a small JS file in the workspace.')}${tool('create_file', { path: 'demo-hello.js', content: "// demo-hello.js\nfunction hello(name) {\n  return `Hello, ${name}!`;\n}\nconsole.log(hello('Raven'));\n" })}`;
    } else {
      reply = `\`\`\`thinking\n${THINKING_1}\n\`\`\`\n\`\`\`tool\n{"name": "list_workspace", "arguments": {}}\n\`\`\``;
      await sleep(900); // simulate time-to-first-token
    }
    await this._emit(reply, opts);
    return reply;
  }
}

module.exports = { DemoBackend };
