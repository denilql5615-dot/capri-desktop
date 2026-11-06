'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('Hub links accept web links and leave executable schemes and credentials as text', async () => {
  const { hubLinks } = await import('../src/renderer/js/hub-links.js');
  const text = '[Документ](https://docs.google.com/document/d/example/edit) и https://example.org/test. file:///C:/Windows/x.exe javascript:alert(1) https://user:pass@example.org';
  const parts = hubLinks(text);
  assert.deepEqual(parts.filter((part) => part.url), [
    { text: 'Документ', url: 'https://docs.google.com/document/d/example/edit' },
    { text: 'https://example.org/test', url: 'https://example.org/test' },
  ]);
  assert.match(parts.at(-1).text, /^\. file:/);
});
