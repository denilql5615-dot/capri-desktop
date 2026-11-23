'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const { PhoneBridge, tokenMatches, controlPatch, parseModelCommand } = require('../src/main/phone');

test('tokenMatches: only the right key, never an empty one', () => {
  assert.strictEqual(tokenMatches('abc', 'abc'), true);
  assert.strictEqual(tokenMatches('abd', 'abc'), false);
  assert.strictEqual(tokenMatches('', ''), false);
});

test('the phone can read current swarm quotas only with the bridge token', async () => {
  const groups = [{ id: 'codex', bars: [{ kind: '5h', remaining: 42 }] }];
  const bridge = new PhoneBridge({ token: () => 'fixture', quotaActivity: () => groups });
  const port = await bridge.start(0, '127.0.0.1');
  try {
    const url = `http://127.0.0.1:${port}/quotas/activity`;
    assert.strictEqual((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { 'x-capri-token': 'fixture' } });
    assert.deepStrictEqual(await response.json(), { groups });
  } finally {
    bridge.stop();
  }
});

test('phone research activity is scoped to the request and command kind', async () => {
  const ready = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const requestId = randomUUID();
  const groups = [{ id: 'codex', bars: [] }, { id: 'claude', bars: [] }];
  const bridge = new PhoneBridge({
    token: () => 'fixture',
    quotaSnapshot: () => ({ groups }),
    quotaGroup: (agent) => agent,
    runMobileCouncil: async (question, { notifyActivity }) => {
      assert.equal(question, 'synthetic question');
      notifyActivity({ runId: 'worker', agent: 'codex', event: { kind: 'turn', state: 'running' } });
      ready.resolve();
      await finish.promise;
      notifyActivity({ runId: 'worker', agent: 'codex', event: { kind: 'turn', state: 'done' } });
      return { reply: 'verdict' };
    },
  });
  const port = await bridge.start(0, '127.0.0.1');
  const url = `http://127.0.0.1:${port}`;
  const headers = { 'x-capri-token': 'fixture' };
  const activity = (id) => fetch(`${url}/deep-research/activity?requestId=${id}`, { headers }).then((res) => res.json());
  try {
    assert.deepEqual(await (await fetch(`${url}/quotas`, { headers })).json(), { groups });
    const pending = fetch(`${url}/deep-research`, { method: 'POST', headers,
      body: JSON.stringify({ kind: 'council', requestId, query: 'synthetic question' }) });
    await ready.promise;
    assert.deepEqual(await activity(requestId), { running: true,
      steps: [{ agent: 'codex', kind: 'turn', state: 'running' }], groups: [groups[0]] });
    assert.deepEqual(await activity(randomUUID()), { running: false, steps: [], groups: [] });
    finish.resolve();
    assert.deepEqual(await (await pending).json(), { reply: 'verdict' });
    const done = await activity(requestId);
    assert.equal(done.running, false);
    assert.equal(done.steps[0].state, 'done');
    assert.deepEqual(done.groups, [groups[0]]);
  } finally {
    finish.resolve();
    bridge.stop();
  }
});

test('mobile chat carries model and isolated context, and retries one PC turn', async () => {
  const calls = [];
  const logged = [];
  const longReply = 'Развёрнутый ответ. '.repeat(2500) + 'Конечная строка.';
  const bridge = new PhoneBridge({
    token: () => 'k',
    persona: () => 'Персона.',
    log: (row) => logged.push(row.said),
    chat: async (messages, _signal, options) => {
      calls.push({ messages, options });
      return { text: messages.at(-1).content === 'длинный ответ' ? longReply : 'готово', brain: options.requestedModel };
    },
  });
  const port = await bridge.start(0, '127.0.0.1');
  const post = async (body) => {
    const r = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: 'POST', headers: { 'x-capri-token': 'k' }, body: JSON.stringify(body),
    });
    return r.json();
  };
  try {
    const input = { text: 'продолжим', history: [{ role: 'user', content: 'контекст' }], model: '26b',
      requestId: 'a2345678-abcd-abcd-abcd-123456789012' };
    const [firstReply, secondReply] = await Promise.all([post(input), post(input)]);
    assert.deepStrictEqual(firstReply, secondReply);
    assert.strictEqual(firstReply.reply, 'готово');
    assert.strictEqual(firstReply.brain, '26b');
    assert.strictEqual(firstReply.pose, '');
    assert.strictEqual(firstReply.context.maxTokens, 32768);
    assert.strictEqual(firstReply.context.source, 'estimated');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].messages.at(-2).content, 'контекст');
    assert.strictEqual(calls[0].options.numPredict, -1);
    await post({ text: 'тайна', history: [], model: 'e4b', ephemeral: true, useVault: false });
    assert.strictEqual(calls[1].messages.length, 2);
    assert.strictEqual(calls[1].options.localOnly, true);
    assert.strictEqual(calls[1].options.useVault, false);
    await post({ text: 'без обсидиана', history: [], model: 'e4b', useVault: false });
    assert.strictEqual(calls[2].options.useVault, false);
    await post({ text: 'новый чат', history: [], model: 'e4b' });
    assert.strictEqual(calls[3].messages.length, 2);
    assert.strictEqual(calls[3].options.requestedModel, 'e4b');
    assert.strictEqual((await post({ text: 'длинный ответ', history: [], model: 'e4b' })).reply, longReply);
    assert.deepStrictEqual(logged, ['продолжим', 'новый чат', 'длинный ответ']);
  } finally {
    bridge.stop();
  }
});

test('mobile chat recovers private and temporary replies after an HTTP disconnect', async () => {
  let token = 'old-token';
  let started;
  let finish;
  let calls = 0;
  const bridge = new PhoneBridge({
    token: () => token,
    persona: () => 'Персона.',
    log: () => assert.fail('isolated chats must not enter the shared log'),
    chat: async (_messages, signal, { localOnly }) => {
      assert.strictEqual(localOnly, true);
      calls++;
      started();
      await new Promise((resolve) => { finish = resolve; });
      assert.strictEqual(signal.aborted, false);
      return { text: 'синтетический ответ', brain: 'e4b' };
    },
  });
  const port = await bridge.start(0, '127.0.0.1');
  const api = (path, body, signal) => fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { 'x-capri-token': token }, ...(body && { method: 'POST', body: JSON.stringify(body) }), signal,
  });
  try {
    for (const flags of [{ mode: 'private' }, { ephemeral: true }]) {
      const input = { text: 'синтетический запрос', history: [], requestId: randomUUID(), ...flags };
      const start = new Promise((resolve) => { started = resolve; });
      const disconnect = new AbortController();
      const first = api('/chat', input, disconnect.signal);
      await start;
      disconnect.abort();
      await assert.rejects(first, { name: 'AbortError' });
      const statusPath = `/chat/status?requestId=${input.requestId}`;
      assert.deepStrictEqual(await (await api(statusPath)).json(), { state: 'running' });
      assert.strictEqual((await api('/chat', { ...input, text: 'другой запрос' })).status, 409);
      const retry = api('/chat', input);
      finish();
      const recovered = await (await retry).json();
      assert.strictEqual(recovered.reply, 'синтетический ответ');
      assert.strictEqual(recovered.brain, 'e4b');
      assert.strictEqual(recovered.pose, '');
      assert.strictEqual(recovered.context.maxTokens, 32768);
      assert.deepStrictEqual(await (await api(statusPath)).json(), { state: 'complete' });
      token = 'new-token';
      assert.strictEqual((await api(statusPath)).status, 404);
      assert.strictEqual((await api('/chat', input)).status, 404);
      token = 'old-token';
    }
    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(bridge.turns, []);
  } finally {
    finish?.();
    await bridge.stop();
  }
});

test('mobile chat status distinguishes terminal model errors and confirmed stops', async () => {
  let calls = 0;
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  const bridge = new PhoneBridge({
    token: () => 'k',
    persona: () => 'Персона.',
    chat: async (messages, signal) => {
      calls++;
      if (messages.at(-1).content === 'сбой') throw new Error('синтетический сбой');
      started();
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const port = await bridge.start(0, '127.0.0.1');
  const api = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { 'x-capri-token': 'k' }, ...(body && { method: 'POST', body: JSON.stringify(body) }),
  });
  const status = (id) => api(`/chat/status?requestId=${id}`).then((r) => r.json());
  const error = { text: 'сбой', ephemeral: true, requestId: randomUUID() };
  const active = { text: 'стоп', ephemeral: true, requestId: randomUUID() };
  const early = { ...active, requestId: randomUUID() };
  try {
    const failed = await (await api('/chat', error)).json();
    assert.strictEqual(failed.brain, 'error');
    assert.deepStrictEqual(await status(error.requestId), { state: 'error' });
    assert.deepStrictEqual(await (await api('/chat', error)).json(), failed);

    const pending = api('/chat', active);
    await start;
    assert.deepStrictEqual(await (await api('/chat/stop', { requestId: active.requestId })).json(), { state: 'stopped' });
    assert.strictEqual((await (await pending).json()).brain, 'stopped');
    assert.deepStrictEqual(await status(active.requestId), { state: 'stopped' });
    assert.strictEqual((await (await api('/chat', active)).json()).brain, 'stopped');

    assert.strictEqual((await api(`/chat/status?requestId=${early.requestId}`)).status, 404);
    assert.deepStrictEqual(await (await api('/chat/stop', { requestId: early.requestId })).json(), { state: 'stopped' });
    assert.strictEqual((await (await api('/chat', early)).json()).brain, 'stopped');
    assert.strictEqual(calls, 2);
  } finally {
    await bridge.stop();
  }
});

test('controlPatch: the remote may switch its few settings, nothing else', () => {
  assert.deepStrictEqual(controlPatch({ voice: false }), { voice: false });
  assert.strictEqual(controlPatch({ voice: 'yes' }), null);
  assert.strictEqual(controlPatch({ claudeMode: 'acceptEdits' }), null);
  assert.deepStrictEqual(controlPatch({ router: true, worker: 'codex' }), { router: true, worker: 'codex' });
  assert.strictEqual(controlPatch({ renderMode: 'sprite' }), null); // GENESIS's, gone here
});

test('bridge: token, chat with the phone note, voice, events, control', async () => {
  const seen = { events: [], messages: null, control: null };
  const bridge = new PhoneBridge({
    token: () => 'k',
    persona: () => 'Ты Капри.',
    chat: async (messages) => { seen.messages = messages; return { text: 'йо', brain: 'qwen3:8b' }; },
    speak: async () => new Uint8Array([1, 2, 3]),
    event: (kind) => seen.events.push(kind),
    control: () => ({ voice: true }),
    applyControl: (patch) => { seen.control = patch; return { voice: patch.voice }; },
  });
  const port = await bridge.start(0, '127.0.0.1');
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const post = (p, body, token = 'k') => fetch(url(p), { method: 'POST', headers: { 'x-capri-token': token }, body: JSON.stringify(body) });
  try {
    assert.strictEqual((await fetch(url('/ping'))).status, 401);
    assert.strictEqual((await post('/chat', { text: 'hi' }, 'wrong')).status, 401);
    const ping = await (await fetch(url('/ping?token=k'))).json();
    assert.strictEqual(ping.ok, true);
    assert.strictEqual(ping.pose, '');
    assert.strictEqual(ping.sprites, '');
    assert.strictEqual(ping.isolatedChat, true);
    assert.strictEqual(ping.modelSelection, true);
    assert.strictEqual(ping.chatRecovery, true);
    assert.strictEqual(ping.privateVaultSave, false);
    assert.strictEqual(ping.contextLimits.e4b, 32768);
    assert.strictEqual(ping.contextLimits['26b'], 32768);
    assert.strictEqual(ping.contextLimits.qwen36, 32768);
    assert.strictEqual(ping.contextLimits['gpt-6.2-sol'], 500000);
    assert.strictEqual(ping.contextLimits['gpt-6.2-astra'], 272000);
    assert.strictEqual(ping.contextLimits['claude-opus-5-5'], 1000000);
    assert.strictEqual(ping.contextLimits['gemini-4-neon-high'], 1048576);

    const chat = await (await post('/chat', { text: 'привет', voice: true })).json();
    assert.strictEqual(chat.reply, 'йо');
    assert.strictEqual(chat.brain, 'qwen3:8b');
    assert.match(seen.messages[0].content, /^Ты Капри\.\nКанал: телефон/);
    const audio = await fetch(url(`${chat.audio}?token=k`));
    assert.strictEqual(audio.headers.get('content-type'), 'audio/mpeg');
    assert.deepStrictEqual([...new Uint8Array(await audio.arrayBuffer())], [1, 2, 3]);

    await post('/chat', { text: 'а ты?' });
    assert.strictEqual(seen.messages.length, 4); // persona, the first exchange, this message

    await post('/chat', { text: '[NO_MEMORY]', files: ['first', 'second'].map(data => ({ mime: 'image/png', data })) });
    assert.equal(seen.messages.at(-1).content, 'Кратко опиши каждое прикреплённое изображение по порядку.');
    assert.deepStrictEqual(seen.messages.at(-1).images, ['first', 'second']);

    await post('/event', { kind: 'pet' });
    await post('/event', { kind: 'rm -rf' });
    assert.deepStrictEqual(seen.events, ['pet']);

    assert.strictEqual((await post('/control', { claudeMode: 'acceptEdits' })).status, 400);
    assert.deepStrictEqual(await (await post('/control', { voice: false })).json(), { voice: false });
  } finally {
    await bridge.stop();
  }
});

test('bridge: private and temporary chat do not cross the shared history or research boundary', async () => {
  const calls = [];
  const logged = [];
  const bridge = new PhoneBridge({
    token: () => 'test',
    persona: () => 'test',
    chat: async (rows, _signal, opts) => {
      calls.push({ rows: rows.slice(1).map(row => row.content), localOnly: opts.localOnly });
      return { text: 'answer', brain: 'stub' };
    },
    log: (row) => logged.push(row.said),
    deepResearch: async () => assert.fail('isolated research reached the worker'),
  });
  const port = await bridge.start(0, '127.0.0.1');
  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'x-capri-token': 'test' }, body: JSON.stringify(body),
  });
  try {
    await post('/chat', { text: 'public marker' });
    await post('/chat', { text: 'private marker', mode: 'private', reset: true });
    await post('/chat', { text: 'temporary marker', ephemeral: true });
    await post('/chat', { text: 'next public turn' });
    assert.deepStrictEqual(calls, [
      { rows: ['public marker'], localOnly: false },
      { rows: ['private marker'], localOnly: true },
      { rows: ['temporary marker'], localOnly: true },
      { rows: ['public marker', 'answer', 'next public turn'], localOnly: false },
    ]);
    assert.deepStrictEqual(logged, ['public marker', 'next public turn']);
    assert.equal((await post('/deep-research', { query: 'private', mode: 'private' })).status, 403);
    assert.equal((await post('/deep-research', { query: 'temporary', ephemeral: true })).status, 403);
    assert.equal((await post('/deep-research', { query: 'invalid mode', mode: 'privtae' })).status, 400);
    assert.equal((await post('/chat', { text: 'invalid flag', ephemeral: 'true' })).status, 400);
    const result = await (await post('/chat', { text: '[DEEP_RESEARCH] temporary', ephemeral: true })).json();
    assert.equal(result.brain, 'error');
  } finally {
    await bridge.stop();
  }
});

test('bridge: private autosave only runs for a completed private request and reports Vault failure', async (t) => {
  const writes = [];
  const shared = [];
  let available = true;
  const bridge = new PhoneBridge({
    token: () => 'fixture',
    persona: () => '',
    chat: async () => ({ text: 'Синтетический ответ', brain: 'local' }),
    log: row => shared.push(row),
    savePrivateChat: (...args) => {
      if (!available) throw new Error('fixture filesystem error');
      writes.push(args);
    },
  });
  const port = await bridge.start(0, '127.0.0.1');
  t.after(() => bridge.stop());
  const post = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'x-capri-token': 'fixture', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const chatId = randomUUID();
  const body = { mode: 'private', privateChatId: chatId, text: 'Приватнаяметка', requestId: randomUUID() };
  assert.equal((await (await post('/chat', body)).json()).vaultSaved, true);
  assert.equal((await (await post('/chat', body)).json()).vaultSaved, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0][2], { append: true });
  assert.match(writes[0][1][0].content, /Приватнаяметка/);
  assert.equal((await post('/chat', { ...body, ephemeral: true })).status, 400);
  const manual = { chatId, history: writes[0][1] };
  assert.deepEqual(await (await post('/chat/private/save', manual)).json(), { saved: true });
  available = false;
  assert.equal((await post('/chat/private/save', manual)).status, 503);
  const failure = await (await post('/chat', { ...body, requestId: randomUUID() })).json();
  assert.equal(failure.vaultSaved, false);
  assert.match(failure.vaultError, /Vault недоступен/);
  assert.deepEqual(shared, []);
});

test('bridge: an isolated desktop turn forwards cancellation without calling web or logging', async () => {
  const abort = new AbortController();
  const bridge = new PhoneBridge({
    persona: () => 'test',
    log: () => assert.fail('isolated turn was logged'),
    webSearch: () => assert.fail('isolated turn reached the web'),
    chat: async (rows, signal, { ephemeral, localOnly, source }) => {
      assert.deepStrictEqual({ ephemeral, localOnly, source }, { ephemeral: true, localOnly: true, source: 'vault' });
      assert.equal(rows.length, 2);
      abort.abort();
      signal.throwIfAborted();
    },
  });
  const flags = { ephemeral: true, privateMode: true, deepResearch: false, skills: [] };
  const web = await bridge.turn({ text: 'найди в сети: пример', ...flags }, false);
  assert.equal(web.brain, 'error');
  const cancelled = await bridge.turn({ text: 'isolated marker', ...flags }, false, abort.signal);
  assert.equal(abort.signal.aborted, true);
  assert.equal(cancelled.brain, 'error');
  assert.deepStrictEqual(bridge.turns, []);
});

test('bridge: a desktop task with images keeps the attachments and forces the local route', async () => {
  const bridge = new PhoneBridge({
    persona: () => 'test',
    log: () => assert.fail('a separate task was logged'),
    chat: async (rows, _signal, opts) => {
      assert.deepStrictEqual(rows.at(-1).images, ['first', 'second']);
      assert.equal(opts.localOnly, true);
      assert.equal(opts.requireVision, true);
      assert.equal(opts.localMode, 'task');
      return { text: 'vision answer', brain: 'vision' };
    },
  });
  const result = await bridge.turn({
    text: 'describe', images: ['first', 'second'], localOnly: true, localMode: 'task', requireVision: true, skills: [],
  }, false);
  assert.equal(result.reply, 'vision answer');
  assert.deepStrictEqual(bridge.turns, []);
});

test('bridge: research saves the full synthesis artifact from completed agent history', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'altair-research-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'report.md');
  fs.writeFileSync(file, '# Full synthesis\n\nChecked facts.');
  const histories = [];
  let saved;
  const bridge = new PhoneBridge({
    agentsList: async () => ({ models: { codex: [['test']] } }),
    agentCreate: async () => histories.push([]) - 1,
    agentSend: async ({ id, text }) => {
      histories[id].push({ role: 'user', content: text }, id === 0
        ? { role: 'assistant', content: 'worker report' }
        : { role: 'assistant', content: 'See report.md', artifacts: [{ run: 'fixture-run', name: 'report.md' }] });
      return { ok: true };
    },
    agentHistory: async (id) => histories[id],
    agentArtifact: async (locator) => {
      assert.deepStrictEqual(locator, { id: 1, run: 'fixture-run', name: 'report.md' });
      return file;
    },
    saveObsidianResearch: async (report) => { saved = report; return true; },
  });
  const result = await bridge.runDeepResearch('public fixture');
  assert.deepStrictEqual(result.workers, ['codex']);
  assert.match(histories[1][0].content, /report/);
  assert.deepStrictEqual(saved, { query: 'public fixture', markdown: '# Full synthesis\n\nChecked facts.' });
  assert.equal(result.reply, saved.markdown);
  assert.equal(result.obsidianSaved, true);
  await assert.rejects(new PhoneBridge({}).runDeepResearch('public fixture'), { status: 503 });
});

test('bridge: research completes with another worker when one reaches quota', async () => {
  const calls = [];
  const workersWithActivity = [];
  const bridge = new PhoneBridge({
    agentsList: async () => ({
      models: { gemini: [['gemini-default']], codex: [['codex-default']] },
    }),
    agentCreate: async (agent) => agent,
    agentSend: async ({ id, text, notifyActivity }) => {
      calls.push(id);
      notifyActivity?.(id);
      if (id === 'gemini') return { ok: false, error: 'quota reached' };
      return { ok: true, text: text.startsWith('Тема') ? 'combined report' : 'backup report' };
    },
  });
  const first = await bridge.runDeepResearch('public question', { notifyActivity: (id) => workersWithActivity.push(id) });
  assert.deepStrictEqual(first.workers, ['codex']);
  assert.equal(first.reply, 'combined report');
  assert.ok(workersWithActivity.includes('gemini') && workersWithActivity.includes('codex'));
  await bridge.runDeepResearch('next public question');
  assert.equal(calls.filter((id) => id === 'gemini').length, 1);
});

test('bridge: disconnecting a research client stops its worker and skips the final report', async () => {
  const started = Promise.withResolvers();
  const worker = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  let sessions = 0;
  let saved = 0;
  const bridge = new PhoneBridge({
    token: () => 'fixture',
    agentsList: async () => ({ models: { codex: [['fixture']] } }),
    agentCreate: async () => `fixture-${++sessions}`,
    agentSend: async ({ id }) => { started.resolve(id); return worker.promise; },
    agentStop: async (id) => { worker.resolve({ text: 'late answer' }); stopped.resolve(id); },
    saveObsidianResearch: async () => { saved++; },
  });
  const port = await bridge.start(0, '127.0.0.1');
  const abort = new AbortController();
  try {
    const pending = fetch(`http://127.0.0.1:${port}/deep-research`, {
      method: 'POST', headers: { 'x-capri-token': 'fixture' }, body: JSON.stringify({ query: 'fixture' }),
      signal: abort.signal,
    }).catch(error => error);
    assert.equal(await started.promise, 'fixture-1');
    abort.abort();
    assert.equal((await pending).name, 'AbortError');
    assert.equal(await stopped.promise, 'fixture-1');
    await new Promise(setImmediate);
    assert.equal(sessions, 1);
    assert.equal(saved, 0);
  } finally {
    abort.abort();
    await bridge.stop();
  }
});

test('bridge: Android read tools and scoped research stop use authenticated, separate calls', async () => {
  const { randomUUID } = require('node:crypto');
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const bridge = new PhoneBridge({
    token: () => 'fixture',
    webSearch: async () => ({ results: [{ title: 'IANA', url: 'https://www.iana.org/' }] }),
    readPim: async (text) => ({ reply: text }),
    chat: () => assert.fail('read tool used the chat model'),
    log: () => assert.fail('read tool was logged'),
    deepResearch: async ({ signal }) => {
      markStarted();
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const port = await bridge.start(0, '127.0.0.1');
  const post = (path, body, token = 'fixture') => fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'x-capri-token': token }, body: JSON.stringify(body),
  });
  try {
    assert.match((await (await post('/tool', { tool: 'search', text: 'IANA' })).json()).reply, /iana\.org/);
    assert.deepStrictEqual(await (await post('/tool', { tool: 'pim', text: 'calendar' })).json(), { reply: 'calendar' });
    assert.equal((await post('/tool', { tool: 'pim', text: 'calendar', mode: 'private' })).status, 403);
    assert.equal((await post('/tool', { tool: 'pim', text: 'calendar' }, 'wrong')).status, 401);
    const requestId = randomUUID();
    const pending = post('/deep-research', { query: 'test', requestId });
    await started;
    const earlierStop = randomUUID();
    assert.equal((await post('/deep-research/stop', { requestId }, 'wrong')).status, 401);
    assert.equal((await post('/deep-research/stop', { requestId: earlierStop })).status, 200);
    assert.deepStrictEqual(await (await post('/deep-research', { query: 'test', requestId: earlierStop })).json(), { stopped: true });
    assert.equal((await post('/deep-research/stop', { requestId })).status, 200);
    assert.deepStrictEqual(await (await pending).json(), { stopped: true });
    assert.deepStrictEqual(bridge.turns, []);
  } finally {
    await bridge.stop();
  }
});

test('background research runs once, restores its result, and confirms stop only after the worker exits', async () => {
  let runs = 0;
  let pending = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const bridge = new PhoneBridge({ token: () => 'fixture', deepResearch: async () => {
    runs++;
    entered.resolve();
    return pending.promise;
  } });
  const port = await bridge.start(0, '127.0.0.1');
  const headers = { 'x-capri-token': 'fixture' };
  const base = `http://127.0.0.1:${port}/deep-research`;
  const start = (requestId) => fetch(base, { method: 'POST', headers, body: JSON.stringify({ requestId, query: 'fixture', background: true }) });
  const read = (id) => fetch(`${base}/result?requestId=${id}`, { headers }).then((r) => r.json());
  try {
    const id = randomUUID();
    const disconnect = new AbortController();
    const oldConnection = fetch(base, { method: 'POST', headers, signal: disconnect.signal,
      body: JSON.stringify({ requestId: id, query: 'fixture' }) }).catch((error) => error);
    await entered.promise;
    disconnect.abort();
    assert.equal((await oldConnection).name, 'AbortError');
    assert.equal((await read(id)).state, 'running');
    assert.equal((await (await start(id)).json()).state, 'running');
    assert.equal(runs, 1);
    pending.resolve({ reply: 'saved result' });
    assert.deepEqual(await read(id), { state: 'done', result: { reply: 'saved result' }, status: 200 });
    assert.equal((await (await start(id)).json()).state, 'done');
    assert.equal(runs, 1);

    const next = randomUUID();
    pending = Promise.withResolvers();
    assert.equal((await start(next)).status, 202);
    const stopping = await (await fetch(`${base}/stop`, { method: 'POST', headers, body: JSON.stringify({ requestId: next }) })).json();
    assert.equal(stopping.state, 'stopping');
    assert.equal((await read(next)).state, 'stopping');
    pending.resolve({ reply: 'late answer' });
    assert.equal((await read(next)).state, 'stopped');
    assert.equal(runs, 2);
  } finally {
    pending.resolve({ reply: 'fixture' });
    await bridge.stop();
  }
});

test('bridge: explicit web search uses the adapter and reports unavailable sources honestly', async () => {
  const calls = [];
  const bridge = new PhoneBridge({
    persona: () => 'test',
    chat: async () => { calls.push('chat'); return { text: 'hello', brain: 'stub' }; },
    externalBlocked: (query) => query === 'blocked fixture',
    webSearch: async (query) => {
      calls.push(query);
      if (query === 'offline fixture') throw new Error('browser unavailable');
      return { results: [{ title: 'Fixture', url: 'https://example.com/' }] };
    },
  });
  const turn = (text, opts) => bridge.turn({ text, skills: [], ...opts }, false);
  assert.equal((await turn('hello')).brain, 'stub');
  assert.match((await turn('найди в сети: public fixture')).reply, /https:\/\/example\.com/);
  assert.equal((await turn('найди в сети: private fixture', { privateMode: true })).brain, 'error');
  assert.equal((await turn('найди в сети: blocked fixture')).brain, 'error');
  assert.equal((await turn('найди в сети: offline fixture')).brain, 'error');
  assert.deepStrictEqual(calls, ['chat', 'public fixture', 'offline fixture']);
});

test('bridge: her moves for the phone, once drawn; none yet, the phone keeps its ragdoll', async () => {
  let pack = null;
  const bridge = new PhoneBridge({ token: () => 'k', sprites: () => pack });
  const port = await bridge.start(0, '127.0.0.1');
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}${p.includes('?') ? '&' : '?'}token=k`);
  try {
    assert.deepStrictEqual(await (await get('/sprites')).json(), { pack: 'capri_pc', version: '', poses: [] });
    assert.strictEqual((await get('/sprites/pack.zip')).status, 404);
    pack = { pack: 'capri_pc', version: 'abcdef012345', poses: [{ id: 'pack:capri_pc/stand', frames: 20, fps: 12 }], zip: Buffer.from('PK-zip') };
    assert.strictEqual((await (await get('/ping')).json()).sprites, 'abcdef012345');
    assert.deepStrictEqual((await (await get('/sprites')).json()).poses, pack.poses);
    const zip = await get('/sprites/pack.zip');
    assert.strictEqual(zip.headers.get('content-type'), 'application/zip');
    assert.strictEqual(Buffer.from(await zip.arrayBuffer()).toString(), 'PK-zip');
  } finally {
    await bridge.stop();
  }
});

test('bridge: "переключись на ролевую" switches her model; a phrase naming no model is a message; each exchange logged', async () => {
  const logged = [];
  let asked = 0;
  const bridge = new PhoneBridge({
    token: () => 'k',
    persona: () => 'Ты Капри.',
    chat: async () => { asked++; return { text: 'ок', brain: 'qwen3:8b' }; },
    speak: async () => null,
    switchModel: async (wanted) => (wanted === 'ролевую' ? { ok: true, model: 'faun' } : { ok: false, error: 'нет' }),
    log: (entry) => logged.push(entry),
  });
  const port = await bridge.start(0, '127.0.0.1');
  const post = (body) => fetch(`http://127.0.0.1:${port}/chat`, { method: 'POST', headers: { 'x-capri-token': 'k' }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    const sw = await post({ text: 'переключись на ролевую' });
    assert.strictEqual(sw.reply, 'Переключилась на faun.');
    assert.strictEqual(asked, 0);
    const music = await post({ text: 'включи музыку' });
    assert.strictEqual(music.reply, 'ок');
    assert.strictEqual(asked, 1);
    assert.deepStrictEqual(logged, [
      { said: 'переключись на ролевую', answer: 'Переключилась на faun.' },
      { said: 'включи музыку', answer: 'ок' },
    ]);
  } finally {
    await bridge.stop();
  }
});

test('parseModelCommand: the model asked for, or null', () => {
  assert.strictEqual(parseModelCommand('Переключись на ролевую.'), 'ролевую');
  assert.strictEqual(parseModelCommand('смени модель на основную модель'), 'основную');
  assert.strictEqual(parseModelCommand('как дела'), null);
});

test('bridge: /agents endpoints (list, sessions, create, send, stop, quota, artifact)', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-artifact-test-'));
  const dummyFile = path.join(tmpDir, 'test.png');
  fs.writeFileSync(dummyFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const bridge = new PhoneBridge({
    token: () => 'agent-key',
    agentsList: async () => ({
      sessions: [{ id: 's1', agent: 'gemini', title: 'Test Session', active: false }],
      models: { gemini: ['gemini-2.5-pro'] },
    }),
    agentSessions: async (agent) => [{ id: 's1', agent: agent || 'gemini', title: 'Test Session' }],
    agentCreate: async (agent) => `s-new-${agent}`,
    agentHistory: async (id) => [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }],
    agentSend: async ({ id, model, text }) => ({ ok: true, text: `reply to ${text}` }),
    agentStop: async (id) => true,
    agentQuota: async ({ agent, model, refresh }) => ({ group: 'agy-argon', windows: [{ usedPercent: 12 }] }),
    agentArtifact: async ({ id, run, name }) => (name === 'test.png' ? dummyFile : null),
  });

  const port = await bridge.start(0, '127.0.0.1');
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const get = (p) => fetch(url(p), { headers: { 'x-capri-token': 'agent-key' } });
  const post = (p, body) => fetch(url(p), { method: 'POST', headers: { 'x-capri-token': 'agent-key' }, body: JSON.stringify(body) });

  try {
    const listRes = await get('/agents');
    assert.strictEqual(listRes.status, 200);
    const listData = await listRes.json();
    assert.strictEqual(listData.sessions.length, 1);
    assert.strictEqual(listData.sessions[0].id, 's1');

    const sessionsRes = await get('/agents/sessions?agent=gemini');
    assert.strictEqual(sessionsRes.status, 200);
    const sessions = await sessionsRes.json();
    assert.strictEqual(sessions[0].agent, 'gemini');

    const createRes = await post('/agents/sessions', { agent: 'claude' });
    assert.strictEqual(createRes.status, 200);
    const created = await createRes.json();
    assert.strictEqual(created.id, 's-new-claude');

    const histRes = await get('/agents/session?id=s1');
    assert.strictEqual(histRes.status, 200);
    const hist = await histRes.json();
    assert.strictEqual(hist.messages.length, 2);

    const sendRes = await post('/agents/send', { id: 's1', model: 'm', text: 'ping' });
    assert.strictEqual(sendRes.status, 200);
    const sendData = await sendRes.json();
    assert.strictEqual(sendData.text, 'reply to ping');
    const files = [{ name: 'photo.png', data: Buffer.alloc(128 * 1024).toString('base64') }];
    assert.strictEqual((await post('/agents/send', { id: 's1', text: 'photo', files })).status, 200);
    assert.strictEqual((await post('/control', { files })).status, 413);

    const stopRes = await post('/agents/stop', { id: 's1' });
    assert.strictEqual(stopRes.status, 200);
    const stopData = await stopRes.json();
    assert.strictEqual(stopData.ok, true);

    const quotaRes = await get('/agents/quota?agent=gemini&model=gemini-2.5-pro');
    assert.strictEqual(quotaRes.status, 200);
    const quotaData = await quotaRes.json();
    assert.strictEqual(quotaData.group, 'agy-argon');

    const artRes = await get('/agents/artifact?id=s1&run=r1&name=test.png');
    assert.strictEqual(artRes.status, 200);
    assert.strictEqual(artRes.headers.get('content-type'), 'image/png');
    const artBytes = await artRes.arrayBuffer();
    assert.strictEqual(artBytes.byteLength, 4);

    const missingArtRes = await get('/agents/artifact?id=s1&run=r1&name=missing.png');
    assert.strictEqual(missingArtRes.status, 404);
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('bridge: chatRequests evicts finished entries past 64 and returns 503 only when 64 are active', async (t) => {
  let block = false;
  let gate = Promise.withResolvers();
  const bridge = new PhoneBridge({
    token: () => 'k',
    persona: () => 'Персона.',
    chat: async () => {
      if (block) await gate.promise;
      return { text: 'ок', brain: 'e4b' };
    },
  });
  const port = await bridge.start(0, '127.0.0.1');
  t.after(async () => {
    gate.resolve();
    await bridge.stop();
  });
  const api = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
    headers: { 'x-capri-token': 'k' },
    ...(body && { method: 'POST', body: JSON.stringify(body) }),
  });

  const finishedIds = [];
  for (let i = 0; i < 64; i++) {
    const requestId = randomUUID();
    finishedIds.push(requestId);
    assert.strictEqual((await api('/chat', { text: `done-${i}`, ephemeral: true, requestId })).status, 200);
  }
  const extraId = randomUUID();
  assert.strictEqual((await api('/chat', { text: 'done-65', ephemeral: true, requestId: extraId })).status, 200);
  assert.strictEqual((await api(`/chat/status?requestId=${finishedIds[0]}`)).status, 404);
  assert.strictEqual((await api(`/chat/status?requestId=${extraId}`)).status, 200);

  block = true;
  const active = [];
  for (let i = 0; i < 64; i++) {
    const requestId = randomUUID();
    active.push(api('/chat', { text: `active-${i}`, ephemeral: true, requestId }));
  }
  while (bridge.chatRequests.size < 64 || [...bridge.chatRequests.values()].some((e) => e.state !== 'queued' && e.state !== 'running')) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const rejected = await api('/chat', { text: 'overflow', ephemeral: true, requestId: randomUUID() });
  assert.strictEqual(rejected.status, 503);
  const stopRejected = await api('/chat/stop', { requestId: randomUUID() });
  assert.strictEqual(stopRejected.status, 503);

  gate.resolve();
  const settled = await Promise.all(active);
  for (const res of settled) assert.strictEqual(res.status, 200);
});

test('bridge: private + ephemeral reads Vault boundary without writing or logging', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const notes = require('../src/main/notes');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-priv-eph-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const common = path.join(dir, 'Common');
  const vault = path.join(dir, 'Private');
  fs.mkdirSync(common);
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'Секрет.md'), 'Токен приватвременный42 в закрытом Vault.');

  let seenOpts = null;
  let recalled = [];
  const bridge = new PhoneBridge({
    token: () => 'k',
    persona: () => 'Персона.',
    log: () => assert.fail('private+ephemeral must not write shared log'),
    savePrivateChat: () => assert.fail('private+ephemeral must not save transcript'),
    chat: async (messages, _signal, opts) => {
      seenOpts = opts;
      if (opts.source === 'vault') {
        recalled = notes.searchPrivateVault(vault, common, messages.at(-1).content);
      }
      return { text: 'ответ из vault', brain: 'e4b' };
    },
  });
  const port = await bridge.start(0, '127.0.0.1');
  t.after(() => bridge.stop());
  const post = (body) => fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'x-capri-token': 'k' },
    body: JSON.stringify(body),
  });

  const res = await post({ text: 'Что знаешь про приватвременный42?', mode: 'private', ephemeral: true, useVault: false });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.reply, 'ответ из vault');
  assert.strictEqual(body.vaultSaved, undefined);
  assert.strictEqual(seenOpts.source, 'vault');
  assert.strictEqual(seenOpts.ephemeral, true);
  assert.strictEqual(seenOpts.localOnly, true);
  assert.deepStrictEqual(recalled.map((n) => n.title), ['Секрет']);
  assert.deepStrictEqual(bridge.turns, []);
  assert.strictEqual(fs.readdirSync(vault).filter((f) => f.endsWith('.json')).length, 0);
});

test('suggestions: 3 x 10 x 5 pool rotates sets without repeats and keeps private Vault pool isolated', async () => {
  const { DEFAULT_SUGGESTIONS } = require('../src/main/phone');
  const modes = ['chat', 'task', 'cloud', 'private', 'nsfw'];
  for (const mode of modes) {
    assert.strictEqual(DEFAULT_SUGGESTIONS[mode].length, 10, `expected 10 sets for ${mode}`);
    for (const set of DEFAULT_SUGGESTIONS[mode]) {
      assert.strictEqual(set.length, 3, `expected 3 items per set for ${mode}`);
      for (const item of set) {
        assert.ok(item.title && item.prompt);
      }
    }
  }

  const chatCalls = [];
  const bridge = new PhoneBridge({
    token: () => 'k',
    persona: () => 'Персона.',
    chat: async (_messages, _signal, opts) => {
      chatCalls.push(opts);
      return { text: 'not json', brain: 'e4b' };
    },
  });

  const firstChat = await bridge.getSuggestions('chat');
  const secondChat = await bridge.getSuggestions('chat');
  assert.strictEqual(firstChat.setIndex, 0);
  assert.strictEqual(secondChat.setIndex, 1);
  assert.notDeepStrictEqual(firstChat.items, secondChat.items);

  const firstPrivate = await bridge.getSuggestions('private');
  const secondPrivate = await bridge.getSuggestions('private');
  assert.strictEqual(firstPrivate.setIndex, 0);
  assert.strictEqual(secondPrivate.setIndex, 1);
  assert.notDeepStrictEqual(firstPrivate.items, secondPrivate.items);
  assert.notDeepStrictEqual(firstPrivate.items, firstChat.items);
  assert.strictEqual(chatCalls.at(-1).localOnly, true);
  assert.strictEqual(chatCalls.at(-1).ephemeral, true);
  assert.strictEqual(chatCalls.at(-1).source, 'vault');
});

test('bridge: /agents/send propagates useVault and blocks Tor/secrets/private/ephemeral/nsfw', async () => {
  const seen = [];
  const bridge = new PhoneBridge({
    token: () => 'agent-key',
    externalBlocked: (q) => /\btor\b|SECRET_123/i.test(String(q || '')),
    agentSend: async (body) => {
      seen.push({ text: body.text, useVault: body.useVault });
      return { ok: true, text: 'ok' };
    },
  });
  const port = await bridge.start(0, '127.0.0.1');
  const post = (body) => fetch(`http://127.0.0.1:${port}/agents/send`, {
    method: 'POST',
    headers: { 'x-capri-token': 'agent-key' },
    body: JSON.stringify(body),
  });

  try {
    assert.strictEqual((await post({ id: 's1', model: 'm', text: 'HZ-1' })).status, 200);
    assert.strictEqual((await post({ id: 's1', model: 'm', text: 'HZ-1', useVault: false })).status, 200);
    assert.deepStrictEqual(seen, [
      { text: 'HZ-1', useVault: true },
      { text: 'HZ-1', useVault: false },
    ]);

    assert.strictEqual((await post({ id: 's1', model: 'm', text: 'HZ-1', useVault: 'no' })).status, 400);
    assert.strictEqual((await post({ id: 's1', model: 'm', text: 'HZ-1 через tor' })).status, 403);
    assert.strictEqual((await post({ id: 's1', model: 'm', text: 'HZ-1 SECRET_123' })).status, 403);
    assert.strictEqual((await post({ id: 's1', model: 'm', text: 'HZ-1', mode: 'private' })).status, 403);
    assert.strictEqual((await post({ id: 's1', model: 'm', text: 'HZ-1', ephemeral: true })).status, 403);
    assert.strictEqual((await post({ id: 's1', model: 'm', text: 'HZ-1', mode: 'nsfw' })).status, 403);
  } finally {
    await bridge.stop();
  }
});

test('bridge: /ping, /agents, /chat and /agents/send expose contextLimits and adaptive context stats', async () => {
  const { buildContextStats } = require('../src/main/context-stats');
  let seenContextParts = null;
  const bridge = new PhoneBridge({
    token: () => 'ctx-key',
    persona: () => 'Ты Альта.',
    contextLimits: () => ({ e4b: 24576, 'gpt-6.2-sol': 500000 }),
    agentsList: async () => ({ sessions: [], models: { codex: [['gpt-6.2-sol', 'Sol']] } }),
    chat: async (messages, _signal, opts) => {
      seenContextParts = opts.contextParts;
      const reply = 'Ответ с фактическими токенами.';
      return {
        text: reply,
        brain: 'capri-e4b-stage9-v2:latest',
        context: buildContextStats({
          model: 'capri-e4b-stage9-v2:latest',
          provider: 'ollama',
          maxTokens: 32768,
          systemPrompt: opts.contextParts.systemPrompt,
          skillsText: opts.contextParts.skillsText,
          memoryText: 'Заметка Obsidian по HZ-1',
          toolsText: '',
          messages: [...messages.filter((m) => m.role !== 'system'), { role: 'assistant', content: reply }],
          actualPromptTokens: 640,
          actualEvalTokens: 60,
        }),
      };
    },
    agentSend: async () => ({
      ok: true,
      text: 'Облачный ответ',
      provider: 'codex',
      model: 'gpt-6.2-sol',
      actualModel: 'gpt-6.2-sol',
      context: buildContextStats({
        model: 'gpt-6.2-sol',
        provider: 'codex',
        systemPrompt: 'Инструкция агента',
        memoryText: 'Фрагмент Obsidian',
        toolsText: 'Your working folder is D:\\Capri.',
        messages: [{ role: 'user', content: 'Запрос' }, { role: 'assistant', content: 'Облачный ответ' }],
        actualPromptTokens: 1500,
        actualEvalTokens: 500,
      }),
    }),
  });
  const port = await bridge.start(0, '127.0.0.1');
  const get = (route) => fetch(`http://127.0.0.1:${port}${route}`, { headers: { 'x-capri-token': 'ctx-key' } });
  const post = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'x-capri-token': 'ctx-key' },
    body: JSON.stringify(body),
  });

  try {
    const ping = await (await get('/ping')).json();
    assert.deepStrictEqual(ping.contextLimits, { e4b: 24576, 'gpt-6.2-sol': 500000 });

    const agents = await (await get('/agents')).json();
    assert.deepStrictEqual(agents.contextLimits, { e4b: 24576, 'gpt-6.2-sol': 500000 });

    const chatRes = await (await post('/chat', { text: 'Привет', skills: ['caveman'], model: 'e4b' })).json();
    assert.ok(seenContextParts.systemPrompt.includes('Ты Альта.'));
    assert.ok(seenContextParts.skillsText.includes('Режим caveman'));
    assert.strictEqual(chatRes.context.source, 'actual');
    assert.strictEqual(chatRes.context.usedTokens, 700);
    assert.strictEqual(chatRes.context.freeTokens, 32768 - 700);
    assert.strictEqual(chatRes.context.breakdown.free, 32768 - 700);
    assert.ok(chatRes.context.breakdown.skills > 0);
    assert.ok(chatRes.context.breakdown.memory > 0);

    const agentRes = await (await post('/agents/send', { id: 's1', model: 'gpt-6.2-sol', text: 'Запрос' })).json();
    assert.strictEqual(agentRes.ok, true);
    assert.strictEqual(agentRes.context.source, 'actual');
    assert.strictEqual(agentRes.context.maxTokens, 500000);
    assert.strictEqual(agentRes.context.usedTokens, 2000);
    assert.strictEqual(agentRes.context.freeTokens, 498000);
    assert.ok(agentRes.context.breakdown.memory > 0);
  } finally {
    await bridge.stop();
  }
});
