const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (file) => import(pathToFileURL(path.join(__dirname, '../src/renderer/js', file)).href);

test('quota scale raises the colour at 80, 50, 30, 15 and 5', async () => {
  const { quotaLevel } = await load('quota-scale.js');
  const cases = [[100, 'green'], [80, 'green'], [79.9, 'blue'], [50, 'blue'], [49, 'yellow'], [30, 'yellow'],
    [29, 'orange'], [15, 'orange'], [14, 'red'], [5, 'red'], [4.9, 'bordeaux'], [0, 'bordeaux']];
  for (const [value, level] of cases) assert.equal(quotaLevel(value), level, String(value));
});

test('missing quota data is not the same as a real zero', async () => {
  const { quotaLevel } = await load('quota-scale.js');
  for (const value of [undefined, null, NaN, '40']) assert.equal(quotaLevel(value), 'unknown');
  assert.equal(quotaLevel(0), 'bordeaux');
});

test('quota groups map to recognisable provider logos', async () => {
  const { quotaBrand } = await load('quota-scale.js');
  const { brandSvg } = await load('brand-logos.js');
  assert.equal(quotaBrand('agy-third-party'), 'antigravity');
  assert.equal(quotaBrand('agy-gemini'), 'antigravity');
  assert.equal(quotaBrand('web-gemini'), 'gemini');
  assert.equal(quotaBrand('claude'), 'claude');
  assert.equal(quotaBrand('ollama'), '');
  for (const key of ['claude', 'codex', 'gemini', 'antigravity']) assert.match(brandSvg(key), /^<svg[^>]*viewBox/);
  assert.equal(brandSvg('constructor'), '');
});
