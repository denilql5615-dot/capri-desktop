'use strict';

const QWEN_MODELS = Object.freeze({
  qwen36: 'capri-qwen36-heretic:latest',
  qwen38: 'capri-qwen38-heretic:latest',
});
const PHONE_MODEL_KEYS = ['auto', 'e4b', '26b', ...Object.keys(QWEN_MODELS)];

function resolveRequestedModel(selection, { fast, large }) {
  if (selection == null || selection === 'auto') return undefined;
  if (selection === 'e4b') return fast;
  if (selection === '26b') return large;
  if (typeof selection === 'string' && Object.hasOwn(QWEN_MODELS, selection)) return QWEN_MODELS[selection];
  throw new RangeError('Выбранная модель недоступна на ПК.');
}

module.exports = { PHONE_MODEL_KEYS, QWEN_MODELS, resolveRequestedModel };
