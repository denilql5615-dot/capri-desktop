'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PhoneBridge, tokenMatches, controlPatch } = require('../src/main/phone');

test('tokenMatches: only the right key, never an empty one', () => {
  assert.strictEqual(tokenMatches('abc', 'abc'), true);
  assert.strictEqual(tokenMatches('abd', 'abc'), false);
  assert.strictEqual(tokenMatches('', ''), false);
});

test('controlPatch: the remote may switch its few settings, nothing else', () => {
  assert.deepStrictEqual(controlPatch({ voice: false }), { voice: false });
  assert.strictEqual(controlPatch({ voice: 'yes' }), null);
  assert.strictEqual(controlPatch({ claudeMode: 'acceptEdits' }), null);
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
