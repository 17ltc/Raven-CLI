'use strict';
/**
 * Single entry point for "ask the human a question" (confirmations, security
 * gates...). While the interactive UI is running, questions are routed
 * through its input box. Creating extra readline interfaces on stdin while
 * the UI is active corrupts input handling, which is why every module now
 * goes through here.
 */

const readline = require('readline');

let activeUI = null;
let askHook = null;

function setActiveUI(ui) {
  activeUI = ui;
}

/** Called whenever the human is asked something (used for notifications). */
function setAskHook(fn) {
  askHook = fn;
}

function getActiveUI() {
  return activeUI;
}

/** @returns {Promise<string>} the trimmed answer ('' when cancelled). */
async function askLine(question, opts = {}) {
  if (askHook) {
    try {
      askHook(String(question));
    } catch (e) {
      /* notifications must never break a prompt */
    }
  }
  if (activeUI && activeUI.started) return activeUI.ask(question, opts);

  // Fallback outside the interactive UI (setup wizard, `raven skills delete`...).
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      rl.close();
      resolve((value || '').trim());
    };
    rl.question(`${question} `, finish);
    rl.on('SIGINT', () => finish(''));
    rl.on('close', () => finish(''));
  });
}

module.exports = { askLine, setActiveUI, setAskHook, getActiveUI };
