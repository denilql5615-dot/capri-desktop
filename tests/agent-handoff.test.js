'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildHandoffNote } = require('../src/main/agent-sessions');

test('handoff note names both models, lists agent files with paths and user uploads', () => {
  const root = path.join('D:', 'work', 'hub-artifacts');
  const note = buildHandoffNote({
    from: 'codex',
    fromModel: 'gpt-6.2-sol',
    to: 'claude',
    messages: [
      { role: 'user', content: 'сделай отчёт' },
      { role: 'assistant', content: 'готово', provider: 'codex', artifacts: [{ run: 'abc-1', name: 'report.docx' }] },
    ],
    artifactRoot: root,
    sessionId: 's1',
    listDir: (dir) => (dir.endsWith('s1') ? ['file-x'] : dir.endsWith('file-x') ? ['data.csv'] : []),
  });
  assert.match(note, /codex \(gpt-6\.2-sol\).*claude/);
  assert.ok(note.includes(path.join(root, 'abc-1', 'report.docx')));
  assert.ok(note.includes(path.join(root, 'uploads', 's1', 'file-x', 'data.csv')));
  assert.match(note, /не начинай заново/);
});

test('handoff note digests the part of a long chat the transcript will not show', () => {
  const messages = [];
  for (let i = 0; i < 60; i += 1) messages.push({ role: i % 2 ? 'assistant' : 'user', content: `сообщение ${i}`, provider: 'codex' });
  const note = buildHandoffNote({ from: 'codex', to: 'claude', messages });
  assert.match(note, /Ранее в этом чате \(19 сообщений/);
  assert.match(note, /сообщение 0/);
  assert.doesNotMatch(note, /сообщение 59/);
});
