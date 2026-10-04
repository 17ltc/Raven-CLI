'use strict';

const { askLine } = require('./prompt');

function normalizeOptions(options) {
  return Array.isArray(options) ? options.map((value) => String(value)).filter(Boolean).slice(0, 20) : [];
}

async function askOne(question, index) {
  const text = String(question.text || question.question || `Question ${index + 1}`).trim();
  const options = normalizeOptions(question.options);
  const allowOther = question.allow_other !== false;
  let prompt = `\n${index + 1}. ${text}`;
  if (options.length) prompt += `\n${options.map((option, i) => `  ${i + 1}) ${option}`).join('\n')}`;
  if (allowOther) prompt += `\n  ${options.length + 1}) Autre (réponse libre)`;
  const defaultValue = question.default === undefined ? '' : String(question.default);

  while (true) {
    const answer = await askLine(`${prompt}\nRéponse${defaultValue ? ` [${defaultValue}]` : ''}:`);
    if (!answer && defaultValue) return { id: question.id || `q${index + 1}`, answer: defaultValue, source: 'default' };
    if (!answer) return { id: question.id || `q${index + 1}`, answer: '', source: 'empty' };
    const selected = Number(answer);
    if (options.length && Number.isInteger(selected) && selected >= 1 && selected <= options.length) {
      return { id: question.id || `q${index + 1}`, answer: options[selected - 1], option: selected, source: 'option' };
    }
    if (options.length && allowOther && selected === options.length + 1) {
      const free = await askLine('Précise ta réponse:');
      return { id: question.id || `q${index + 1}`, answer: free, source: 'other' };
    }
    if (!options.length) return { id: question.id || `q${index + 1}`, answer, source: 'free_text' };
    if (allowOther && !Number.isInteger(selected)) return { id: question.id || `q${index + 1}`, answer, source: 'other' };
    await askLine('Choix invalide. Appuie sur Entrée pour réessayer.');
  }
}

async function askUser({ questions = [], confirmation, title } = {}) {
  const items = Array.isArray(questions) ? questions : [];
  if (confirmation && !items.length) {
    const answer = await askLine(`\n${title || confirmation} [o/N]:`);
    const normalized = answer.toLowerCase();
    return { confirmed: ['y', 'yes', 'o', 'oui'].includes(normalized), answer };
  }
  if (!items.length) return { error: 'Provide at least one question.' };
  const answers = [];
  for (let i = 0; i < items.length; i++) answers.push(await askOne(items[i] || {}, i));
  return { answers, count: answers.length };
}

function registerInteractiveQuestionTools(registry) {
  const description = 'Ask the human one or more project questions with numbered choices, an Autre free-text option, defaults, or a confirmation. Args: {questions?: [{id?: str, text: str, options?: [str], allow_other?: bool, default?: str}], confirmation?: str, title?: str}';
  if (typeof registry.register === 'function') registry.register('ask_user', description, askUser);
  else registry.ask_user = { fn: askUser, description };
}

module.exports = { askUser, registerInteractiveQuestionTools };
