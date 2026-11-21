'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PhoneBridge, tokenMatches, controlPatch, parseModelCommand } = require('../src/main/phone');

test('tokenMatches: only the right key, never an empty one', () => {
  assert.strictEqual(tokenMatches('abc', 'abc'), true);
  assert.strictEqual(tokenMatches('abd', 'abc'), false);
  assert.strictEqual(tokenMatches('', ''), false);
});

test('mobile chat carries model and isolated context, and retries one PC turn', async () => {
  const calls = [];
  const bridge = new PhoneBridge({
    token: () => 'k',
    persona: () => 'Персона.',
    log: () => assert.fail('client-owned chats must not fall into the legacy log'),
    chat: async (messages, _signal, options) => {
      calls.push({ messages, options });
      return { text: 'готово', brain: options.requestedModel };
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
    assert.deepStrictEqual(await Promise.all([post(input), post(input)]), [
      { reply: 'готово', brain: '26b', pose: '' }, { reply: 'готово', brain: '26b', pose: '' },
    ]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].messages.at(-2).content, 'контекст');
    await post({ text: 'тайна', history: [], model: 'e4b', ephemeral: true, useVault: false });
    assert.strictEqual(calls[1].messages.length, 2);
    assert.strictEqual(calls[1].options.localOnly, true);
    assert.strictEqual(calls[1].options.useVault, false);
    await post({ text: 'новый чат', history: [], model: 'e4b' });
    assert.strictEqual(calls[2].messages.length, 2);
    assert.strictEqual(calls[2].options.requestedModel, 'e4b');
  } finally {
    bridge.stop();
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
    assert.deepStrictEqual(await (await fetch(url('/ping?token=k'))).json(), { ok: true, pose: '', sprites: '', isolatedChat: true, modelSelection: true });

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
  const bridge = new PhoneBridge({
    agentsList: async () => ({
      models: { gemini: [['gemini-default']], codex: [['codex-default']] },
    }),
    agentCreate: async (agent) => agent,
    agentSend: async ({ id, text }) => {
      calls.push(id);
      if (id === 'gemini') return { ok: false, error: 'quota reached' };
      return { ok: true, text: text.startsWith('Тема') ? 'combined report' : 'backup report' };
    },
  });
  const first = await bridge.runDeepResearch('public question');
  assert.deepStrictEqual(first.workers, ['codex']);
  assert.equal(first.reply, 'combined report');
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
