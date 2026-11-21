'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRequestedModel } = require('../src/main/phone-model');

const MODELS = Object.freeze({
  fast: 'gemma-4-heretic-e4b',
  large: 'gemma-4-heretic-26b-a4b',
});

test('resolveRequestedModel returns undefined for auto, null, and undefined', () => {
  assert.equal(resolveRequestedModel(null, MODELS), undefined);
  assert.equal(resolveRequestedModel(undefined, MODELS), undefined);
  assert.equal(resolveRequestedModel('auto', MODELS), undefined);
});

test('resolveRequestedModel maps e4b to fast and 26b to large', () => {
  assert.equal(resolveRequestedModel('e4b', MODELS), MODELS.fast);
  assert.equal(resolveRequestedModel('26b', MODELS), MODELS.large);
});

test('resolveRequestedModel pins the Qwen choices to their Heretic installs', () => {
  assert.equal(resolveRequestedModel('qwen36', MODELS), 'capri-qwen36-heretic:latest');
  assert.equal(resolveRequestedModel('qwen38', MODELS), 'capri-qwen38-heretic:latest');
});

test('resolveRequestedModel handles 26b -> e4b -> 26b transitions without hidden state', () => {
  const first = resolveRequestedModel('26b', MODELS);
  const second = resolveRequestedModel('e4b', MODELS);
  const third = resolveRequestedModel('26b', MODELS);

  assert.equal(first, MODELS.large);
  assert.equal(second, MODELS.fast);
  assert.equal(third, MODELS.large);
});

test('resolveRequestedModel throws RangeError for unsupported selection values', () => {
  const invalidInputs = ['', 'AUTO', 'E4B', '26B', '70b', 'gpt-4', 'default', 42, {}, []];

  for (const invalid of invalidInputs) {
    assert.throws(
      () => resolveRequestedModel(invalid, MODELS),
      {
        name: 'RangeError',
      },
      `Expected RangeError for input: ${String(invalid)}`
    );
  }
});
