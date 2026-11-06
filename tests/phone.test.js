'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PhoneBridge, tokenMatches, controlPatch, parseModelCommand } = require('../src/main/phone');

test('tokenMatches: only the right key, never an empty one', () => {
  assert.strictEqual(tokenMatches('abc', 'abc'), true);
  assert.strictEqual(tokenMatches('abd', 'abc'), false);
  assert.strictEqual(tokenMatches('', ''), false);
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
    assert.deepStrictEqual(await (await fetch(url('/ping?token=k'))).json(), { ok: true, pose: '', sprites: '' });

    const chat = await (await post('/chat', { text: 'привет', voice: true })).json();
    assert.strictEqual(chat.reply, 'йо');
    assert.strictEqual(chat.brain, 'qwen3:8b');
    assert.match(seen.messages[0].content, /^Ты Капри\.\nКанал: телефон/);
    const audio = await fetch(url(`${chat.audio}?token=k`));
    assert.strictEqual(audio.headers.get('content-type'), 'audio/mpeg');
    assert.deepStrictEqual([...new Uint8Array(await audio.arrayBuffer())], [1, 2, 3]);

    await post('/chat', { text: 'а ты?' });
    assert.strictEqual(seen.messages.length, 4); // persona, the first exchange, this message

    await post('/event', { kind: 'pet' });
    await post('/event', { kind: 'rm -rf' });
    assert.deepStrictEqual(seen.events, ['pet']);

    assert.strictEqual((await post('/control', { claudeMode: 'acceptEdits' })).status, 400);
    assert.deepStrictEqual(await (await post('/control', { voice: false })).json(), { voice: false });
  } finally {
    await bridge.stop();
  }
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
