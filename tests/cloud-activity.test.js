'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { claudeActivity, codexActivity, agyActivity } = require('../src/main/cloud-activity');

const cwd = path.resolve('work');

test('Codex exposes activity state and in-workspace changes without raw payloads', () => {
  assert.deepEqual(codexActivity({
    type: 'item.completed',
    item: { id: 'cmd', type: 'command_execution', command: 'secret command args', aggregated_output: 'secret output', exit_code: 1 },
  }, cwd), { id: 'cmd', kind: 'command', state: 'failed' });
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

test('Claude links a tool result to a confirmed edit and forwards only the state of thinking', () => {
  const events = [];
  const capture = claudeActivity(cwd, (event) => events.push(event));
  const stream = (event) => capture({ type: 'stream_event', event });
  stream({ type: 'message_start' });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'raw reasoning' } });
  stream({ type: 'content_block_stop', index: 0 });
  const edit = { type: 'tool_use', id: 'edit', name: 'Edit' };
  stream({ type: 'content_block_start', index: 1, content_block: edit });
  capture({ type: 'assistant', message: { content: [{ ...edit, input: { file_path: 'notes.md', old_string: 'private' } }] } });
  capture({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'private result' }] } });
  assert.deepEqual(events, [
    { id: 'thinking-1-0', kind: 'thinking', state: 'running' },
    { id: 'thinking-1-0', kind: 'thinking', state: 'done' },
    { id: 'edit', kind: 'tool', name: 'Edit', state: 'running' },
    { id: 'edit', kind: 'tool', name: 'Edit', state: 'done' },
    { id: 'file-edit', kind: 'file', files: ['notes.md'], state: 'done' },
  ]);
});
