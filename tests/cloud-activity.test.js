'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { claudeActivity, codexActivity, agyActivity } = require('../src/main/cloud-activity');

const cwd = path.resolve('work');

test('Codex: command details are cut and masked, messages are public text, files stay in the workspace', () => {
  assert.deepEqual(codexActivity({
    type: 'item.completed',
    item: { id: 'cmd', type: 'command_execution', command: 'curl -H "Authorization: Bearer abcdefghijklmnop1234" https://x', aggregated_output: 'token=supersecret42\nok', exit_code: 1 },
  }, cwd), { id: 'cmd', kind: 'command', state: 'failed', detail: { command: 'curl -H "«скрыто»" https://x', output: '«скрыто»\nok', exitCode: 1 } });
  assert.deepEqual(codexActivity({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Смотрю тесты.' } }, cwd),
    { id: 'm1', kind: 'message', state: 'done', text: 'Смотрю тесты.' });
  assert.equal(codexActivity({ type: 'item.started', item: { id: 'r', type: 'reasoning', text: 'raw reasoning' } }, cwd).text, undefined);
  assert.deepEqual(codexActivity({
    type: 'item.completed',
    item: { id: 'patch', type: 'file_change', changes: [{ path: '.env' }, { path: '../elsewhere.md' }, { path: path.join(cwd, 'notes.md') }] },
  }, cwd), { id: 'patch', kind: 'file', state: 'done', files: ['notes.md'] });
});
test('Antigravity reports a file only after the actual tool succeeds', () => {
  const update = (state) => ({
    event: 'step_update', step_update: {
      step_index: 2, state, step_type: 'tool', tool_name: 'write_file',
      tool_info: { parameters: { Path: path.join(cwd, 'notes.md'), Content: 'private' } },
    },
  });
  assert.deepEqual(agyActivity(update('ACTIVE'), cwd), { id: 'agy-2', kind: 'tool', state: 'running', name: 'write_file' });
  assert.deepEqual(agyActivity(update('DONE'), cwd), { id: 'agy-2', kind: 'file', state: 'done', name: 'write_file', files: ['notes.md'] });
  assert.equal(agyActivity(update('ERROR'), cwd).files, undefined);
});

test('Claude: tool results carry a cut output, text blocks become messages, thinking stays a state', () => {
  const events = [];
  const capture = claudeActivity(cwd, (event) => events.push(event));
  const stream = (event) => capture({ type: 'stream_event', event });
  stream({ type: 'message_start' });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'raw reasoning' } });
  stream({ type: 'content_block_stop', index: 0 });
  const edit = { type: 'tool_use', id: 'edit', name: 'Edit', input: {} };
  stream({ type: 'content_block_start', index: 1, content_block: edit });
  capture({ type: 'assistant', message: { id: 'msg1', content: [{ type: 'text', text: 'Правлю заметку.' }, { ...edit, input: { file_path: 'notes.md', old_string: 'private' } }] } });
  capture({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'updated' }] } });
  const skill = { type: 'tool_use', id: 'sk', name: 'Skill', input: { skill: 'wiki-query' } };
  capture({ type: 'assistant', message: { id: 'msg2', content: [skill] } });
  capture({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'sk', is_error: true, content: [{ type: 'text', text: 'no vault' }] }] } });
  assert.deepEqual(events.map(({ id, kind, state, name }) => [id, kind, state, name]), [
    ['thinking-1-0', 'thinking', 'running', undefined],
    ['thinking-1-0', 'thinking', 'done', undefined],
    ['edit', 'tool', 'running', 'Edit'],
    [events[3].id, 'message', 'done', undefined],
    ['edit', 'tool', 'running', 'Edit'],
    ['edit', 'tool', 'done', 'Edit'],
    ['file-edit', 'file', 'done', undefined],
    ['sk', 'skill', 'running', 'wiki-query'],
    ['sk', 'skill', 'failed', 'wiki-query'],
  ]);
  assert.equal(events[3].text, 'Правлю заметку.');
  assert.deepEqual(events[5].detail, { output: 'updated' });
  assert.deepEqual(events[8].detail, { output: 'no vault' });
  assert.ok(events.every((e) => !JSON.stringify(e).includes('raw reasoning')));
});