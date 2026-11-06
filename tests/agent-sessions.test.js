'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentSessions } = require('../src/main/agent-sessions');
const { parseTranscript } = require('../src/main/agent-import');

function make(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-session-test-'));
  const file = path.join(dir, 'sessions.json');
  return { file, hub: new AgentSessions(file, run, () => {}) };
}

test('a stopped run affects only its own chat; the other history survives reopening', async () => {
  const { hub, file } = make((agent, model, messages, signal) => agent === 'codex'
    ? new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    : Promise.resolve(messages.at(-1).content));
  const a = hub.create('codex');
  const b = hub.create('claude');
  const running = hub.send(a, 'gpt-6.1-sol', 'first');
  assert.deepEqual(await hub.send(b, 'sonnet', 'second'), { ok: true });
  assert.equal(hub.list().find((row) => row.id === a).busy, true);
  hub.stop(a);
  assert.equal((await running).stopped, true);
  const reopened = new AgentSessions(file, () => {}, () => {});
  assert.deepEqual(reopened.list().find((row) => row.id === a).messages.map((m) => m.content), ['first']);
  assert.deepEqual(reopened.list().find((row) => row.id === b).messages.map((m) => m.content), ['second', 'second']);
});

test('switching model after a limit retries the same prompt once in the same chat', async () => {
  const { hub } = make(async (_agent, model) => {
    if (model === 'gemini-4-argon-medium') throw new Error('rate limit');
    return 'answered';
  });
  const id = hub.create('gemini');
  assert.match((await hub.send(id, 'gemini-4-argon-medium', 'same prompt')).error, /limit/);
  assert.deepEqual(await hub.send(id, 'gemini-3.8-flash-high', '', true), { ok: true });
  assert.deepEqual(hub.list()[0].messages.map((m) => m.content), ['same prompt', 'answered']);
  assert.equal(hub.list()[0].model, 'gemini-3.8-flash-high');
});

test('import keeps visible turns, skips tools and does not duplicate an existing transcript', async () => {
  const { hub } = make(() => {});
  const codex = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Question' }] } },
    { type: 'response_item', payload: { type: 'function_call' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] } },
  ].map((row) => JSON.stringify(row)).join('\n');
  const messages = parseTranscript(codex);
  assert.deepEqual(messages.map((m) => m.content), ['Question', 'Answer']);
  assert.equal(hub.import('codex', [messages, messages]).length, 1);
  assert.deepEqual(hub.import('codex', [messages]), []);
  assert.equal(hub.list()[0].agent, 'codex');
  const [pendingImport] = hub.import('codex', [[{ role: 'user', content: 'An unfinished external request' }]]);
  assert.equal(hub.summaries().find((s) => s.id === pendingImport).canRetry, false);
  await assert.rejects(hub.send(pendingImport, '', '', true), /Нет запроса/);
  assert.equal(parseTranscript(JSON.stringify([{ type: 'user', message: { role: 'user', content: 'Claude' } }]))[0].content, 'Claude');
  assert.equal(parseTranscript(JSON.stringify({ messages: [{ role: 'assistant', text: 'Antigravity' }] }))[0].content, 'Antigravity');
});
