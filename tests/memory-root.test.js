'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { FAST, MAIN } = require('../src/main/brains');
const tor = require('../src/main/tor');
const { createTorState } = require('../src/main/tor-guard');
const memoryRoot = require('../src/main/memory-root');

test('chat overlay opens only the verified NOMAD source outside Tor quarantine', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('chats:open-link'");
  const end = main.indexOf("ipcMain.on('chats:close'", start);
  assert.ok(start >= 0 && end > start);

  const overlay = { webContents: {} };
  const chatsWin = { webContents: {} };
  const verifiedNomadSource = 'http://127.0.0.1:8090/content/manual/topic';
  let quarantined = false;
  let open;
  vm.runInNewContext(main.slice(start, end), {
    ipcMain: { handle: (_channel, handler) => { open = handler; } },
    overlay, chatsWin, verifiedNomadSource, URL,
    torState: { isQuarantined: () => quarantined },
    shell: { openExternal: (url) => url },
  });

  assert.equal(open({ sender: overlay.webContents }, verifiedNomadSource), verifiedNomadSource);
  assert.throws(() => open({ sender: overlay.webContents }, 'https://example.com/'));
  assert.throws(() => open({ sender: {} }, verifiedNomadSource));
  quarantined = true;
  assert.throws(() => open({ sender: overlay.webContents }, verifiedNomadSource));
  assert.equal(open({ sender: chatsWin.webContents }, 'https://example.com/'), 'https://example.com/');
});

function loadConfigDefaults() {
  const cfgPath = require.resolve('../src/main/config');
  const origLoad = Module._load;
  delete require.cache[cfgPath];
  Module._load = function patched(request) {
    if (request === 'electron') {
      return { app: { getPath: () => os.tmpdir() } };
    }
    return origLoad.apply(this, arguments);
  };
  try {
    return require('../src/main/config').DEFAULTS;
  } finally {
    Module._load = origLoad;
    delete require.cache[cfgPath];
  }
}

test('default-command questions can use a source that describes omitted arguments', () => {
  const query = 'What exact subcommand is executed by default when running git stash with no parameters?';
  const card = memoryRoot.getApprovedCards().find(({ id }) => id === 'root-001');
  assert.equal(memoryRoot.selectCandidatesCpu([card], query)[0]?.id, card.id);
  assert.equal(memoryRoot.passesAnswerTypeGate(query, 'git stash accepts options'), false);
});

function makeMockKiwix(articles = {}) {
  const catalogXml = [
    '<feed>',
    '  <entry><name>devdocs_en_git</name><title>Git Docs</title><language>eng</language><link type="text/html" href="/content/devdocs_en_git_2026-10"/></entry>',
    '  <entry><name>ifixit</name><title>iFixit</title><language>eng</language><link type="text/html" href="/content/ifixit_en_all_2025-12"/></entry>',
    '  <entry><name>gardening</name><title>Gardening SE</title><language>eng</language><link type="text/html" href="/content/gardening.stackexchange.com_en_all_2026-10"/></entry>',
    '  <entry><name>wikipedia_en</name><title>Wikipedia EN</title><language>eng</language><link type="text/html" href="/content/wikipedia_en_all_mini_2026-06"/></entry>',
    '  <entry><name>cooking</name><title>Cooking SE</title><language>eng</language><link type="text/html" href="/content/cooking.stackexchange.com_en_all_2026-10"/></entry>',
    '</feed>',
  ].join('\n');

  const fetchCalls = [];
  const fetchImpl = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    if (init.redirect !== 'error') {
      throw new Error('redirect must be error');
    }
    const u = new URL(String(url));
    if (u.pathname === '/catalog/v2/entries') {
      return { ok: true, status: 200, text: async () => catalogXml };
    }
    if (Object.hasOwn(articles, u.pathname)) {
      const body = articles[u.pathname];
      if (body === null) return { ok: false, status: 404, text: async () => 'Not found' };
      return { ok: true, status: 200, text: async () => `<html><body><article>${body}</article></body></html>` };
    }
    return { ok: false, status: 404, text: async () => 'Not found' };
  };
  return { fetchImpl, fetchCalls };
}

test('config DEFAULTS keeps memoryRootLookup off by default and loads 40 read-only NOMAD cards', () => {
  const defaults = loadConfigDefaults();
  assert.equal(defaults.memoryRootLookup, 'off');

  const cards = memoryRoot.getApprovedCards();
  assert.equal(cards.length, 40);
  assert.equal(Object.isFrozen(cards), true);
  assert.equal(Object.isFrozen(cards[0]), true);
  assert.throws(() => { cards[0].link = '/content/evil'; }, TypeError);
});

test('gate enforces default-off flag, explicit entry point, voice, Tor, worker, RP, and local provider', () => {
  const baseCfg = { memoryRootLookup: 'on', provider: 'ollama', rp: false };

  // Flag off -> blocked
  assert.deepEqual(
    memoryRoot.evaluateRootLookupGate({ cfg: { ...baseCfg, memoryRootLookup: 'off' }, said: '/nomad git stash' }),
    { allowed: false, reason: 'disabled' },
  );

  // Non-explicit normal chat -> blocked
  assert.deepEqual(
    memoryRoot.evaluateRootLookupGate({ cfg: baseCfg, said: 'Что делает команда git stash без аргументов?' }),
    { allowed: false, reason: 'not_explicit' },
  );
  assert.deepEqual(
    memoryRoot.evaluateRootLookupGate({ cfg: baseCfg, said: 'Найди в обсидиане ALTA' }),
    { allowed: false, reason: 'not_explicit' },
  );

  // Explicit commands accepted
  assert.deepEqual(
    memoryRoot.evaluateRootLookupGate({ cfg: baseCfg, said: 'Капри, найди в номаде про git stash' }),
    { allowed: true, query: 'git stash' },
  );
  assert.deepEqual(
    memoryRoot.evaluateRootLookupGate({ cfg: baseCfg, said: '/nomad дефицит у томатов при вершинной гнили' }),
    { allowed: true, query: 'дефицит у томатов при вершинной гнили' },
  );

  // Voice turn -> skipped
  assert.deepEqual(
    memoryRoot.evaluateRootLookupGate({ cfg: baseCfg, said: '/nomad git stash', voice: true }),
    { allowed: false, reason: 'voice' },
  );

  // Tor quarantine / Tor context / Tor wording -> skipped
  const torState = createTorState({ now: () => 1000 });
  torState.touch({ inChat: true });
  assert.deepEqual(
    memoryRoot.evaluateRootLookupGate({ cfg: baseCfg, said: '/nomad git stash', torState, tor }),
    { allowed: false, reason: 'tor' },
  );
  assert.deepEqual(
    memoryRoot.evaluateRootLookupGate({ cfg: baseCfg, said: '/nomad через тор git stash', tor }),
    { allowed: false, reason: 'tor' },
  );
  assert.deepEqual(
    memoryRoot.evaluateRootLookupGate({
      cfg: baseCfg,
      said: '/nomad git stash',
      messages: [{ role: 'user', content: 'поищи в даркнете' }, { role: 'user', content: '/nomad git stash' }],
      tor,
    }),
    { allowed: false, reason: 'tor' },
  );

  // Cloud / non-ollama provider, worker, RP -> skipped
  assert.deepEqual(
    memoryRoot.evaluateRootLookupGate({ cfg: { ...baseCfg, provider: 'openai' }, said: '/nomad git stash' }),
    { allowed: false, reason: 'not_local' },
  );
  assert.deepEqual(
    memoryRoot.evaluateRootLookupGate({ cfg: baseCfg, said: '/nomad git stash', ollamaUrl: 'https://example.com:11434' }),
    { allowed: false, reason: 'not_local' },
  );
  assert.deepEqual(
    memoryRoot.evaluateRootLookupGate({ cfg: baseCfg, said: '/nomad git stash', worker: 'claude' }),
    { allowed: false, reason: 'worker' },
  );
  assert.deepEqual(
    memoryRoot.evaluateRootLookupGate({ cfg: { ...baseCfg, rp: true }, said: '/nomad git stash' }),
    { allowed: false, reason: 'rp' },
  );
});

test('E4B residency/idle verifier skips explicitly for 26B, busy, cold, unavailable, and timeout without warming/swapping', async () => {
  const card = memoryRoot.getApprovedCards().find((c) => c.id === 'root-001');
  let modelCalls = 0;
  const callModel = async () => {
    modelCalls++;
    return 'SPAN: git stash push | VERDICT: YES';
  };

  // 26B resident -> skip 26b
  const r26b = await memoryRoot.verifyCandidateWithResidentE4B({
    query: 'git stash без аргументов',
    card,
    loadedModels: async () => [MAIN],
    isBusy: () => false,
    callModel,
  });
  assert.deepEqual(r26b, { status: 'skipped', reason: '26b', accepted: false });

  // Cold (nothing loaded) -> skip cold
  const rCold = await memoryRoot.verifyCandidateWithResidentE4B({
    query: 'git stash без аргументов',
    card,
    loadedModels: async () => [],
    isBusy: () => false,
    callModel,
  });
  assert.deepEqual(rCold, { status: 'skipped', reason: 'cold', accepted: false });

  // Busy -> skip busy
  const rBusy = await memoryRoot.verifyCandidateWithResidentE4B({
    query: 'git stash без аргументов',
    card,
    loadedModels: async () => [FAST],
    isBusy: () => true,
    callModel,
  });
  assert.deepEqual(rBusy, { status: 'skipped', reason: 'busy', accepted: false });

  // Unavailable -> /api/ps returns null
  const rUnavailable = await memoryRoot.verifyCandidateWithResidentE4B({
    query: 'git stash без аргументов',
    card,
    loadedModels: async () => null,
    isBusy: () => false,
    callModel,
  });
  assert.deepEqual(rUnavailable, { status: 'skipped', reason: 'unavailable', accepted: false });

  // Timeout on /api/ps
  const rPsTimeout = await memoryRoot.verifyCandidateWithResidentE4B({
    query: 'git stash без аргументов',
    card,
    psTimeoutMs: 15,
    loadedModels: (sig) => new Promise((_, reject) => {
      sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
    isBusy: () => false,
    callModel,
  });
  assert.deepEqual(rPsTimeout, { status: 'skipped', reason: 'timeout', accepted: false });

  // Timeout on E4B inference
  const rInferTimeout = await memoryRoot.verifyCandidateWithResidentE4B({
    query: 'git stash без аргументов',
    card,
    verifyTimeoutMs: 15,
    loadedModels: async () => [FAST],
    isBusy: () => false,
    callModel: (_req, sig) => new Promise((_, reject) => {
      sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  assert.deepEqual(rInferTimeout, { status: 'skipped', reason: 'timeout', accepted: false });
  assert.equal(modelCalls, 0);

  // Resident E4B & idle -> succeeds with think: false, temperature: 0
  let seenReq = null;
  const rOk = await memoryRoot.verifyCandidateWithResidentE4B({
    query: 'git stash без аргументов',
    card,
    loadedModels: async () => [FAST],
    isBusy: () => false,
    callModel: async (req) => {
      seenReq = req;
      return 'SPAN: git stash push | VERDICT: YES';
    },
  });
  assert.equal(rOk.status, 'verified');
  assert.equal(rOk.accepted, true);
  assert.equal(rOk.span, 'git stash push');
  assert.equal(seenReq.model, FAST);
  assert.equal(seenReq.think, false);
  assert.equal(seenReq.temperature, 0);
});

test('strict verdict and exact contiguous span grounding enforce Unicode token/number boundaries in claim/quote', () => {
  assert.deepEqual(memoryRoot.parseE4BVerdict('SPAN: git stash push | VERDICT: YES'), {
    verdict: 'YES',
    span: 'git stash push',
    raw: 'SPAN: git stash push | VERDICT: YES',
  });
  assert.deepEqual(memoryRoot.parseE4BVerdict('SPAN: NONE | VERDICT: NO'), {
    verdict: 'NO',
    span: 'NONE',
    raw: 'SPAN: NONE | VERDICT: NO',
  });
  // Strict rejections: extra preamble, contradictory verdicts, NONE+YES, too long
  assert.equal(memoryRoot.parseE4BVerdict('Думаю: SPAN: git stash push | VERDICT: YES').verdict, 'NO');
  assert.equal(memoryRoot.parseE4BVerdict('SPAN: git stash push | VERDICT: YES | VERDICT: NO').verdict, 'NO');
  assert.equal(memoryRoot.parseE4BVerdict('SPAN: NONE | VERDICT: YES').verdict, 'NO');
  assert.equal(memoryRoot.parseE4BVerdict(`SPAN: ${'a'.repeat(121)} | VERDICT: YES`).verdict, 'NO');
  const sentence = 'Use the first heading as a label for the disclosure widget.';
  const extracted = memoryRoot.parseE4BVerdict(`SPAN: ${sentence} | VERDICT: YES`);
  assert.equal(extracted.verdict, 'YES');
  assert.equal(memoryRoot.isSpanGroundedInCard(extracted.span, { quote: sentence }), true);

  const cards = memoryRoot.getApprovedCards();
  const screwCard = cards.find((c) => c.id === 'root-020');
  const diodeCard = cards.find((c) => c.id === 'root-017');
  const compostCard = cards.find((c) => c.id === 'root-033');
  const bakingCard = cards.find((c) => c.id === 'root-030');

  // Exact contiguous spans in claim/quote pass
  assert.equal(memoryRoot.isSpanGroundedInCard('3,6 мм', screwCard), true);
  assert.equal(memoryRoot.isSpanGroundedInCard('3.6 mm', screwCard), true);
  assert.equal(memoryRoot.isSpanGroundedInCard('150–450 мВ', diodeCard), true);
  assert.equal(memoryRoot.isSpanGroundedInCard('кислотный компонент', bakingCard), true);

  // Number/range/ratio/token boundary violations fail
  assert.equal(memoryRoot.isSpanGroundedInCard('6', screwCard), false);
  assert.equal(memoryRoot.isSpanGroundedInCard('3', screwCard), false);
  assert.equal(memoryRoot.isSpanGroundedInCard('150', diodeCard), false);
  assert.equal(memoryRoot.isSpanGroundedInCard('450', diodeCard), false);
  assert.equal(memoryRoot.isSpanGroundedInCard('20', compostCard), false);
  assert.equal(memoryRoot.isSpanGroundedInCard('5 °C', { claim: 'Температура −5 °C' }), false);
  assert.equal(memoryRoot.isSpanGroundedInCard('компонен', bakingCard), false);
  // Title-only span (not contiguous in claim or quote) fails
  const amazonCard = cards.find((c) => c.id === 'root-038');
  assert.equal(memoryRoot.isSpanGroundedInCard('Истоки Амазонки', amazonCard), false);
});

test('generic bit/driver tooling attribute gate and E4B prompt distinguish part dimension from tool size', () => {
  const cards = memoryRoot.getApprovedCards();
  // Asking for bit/driver size on iPhone 5 Pentalobe screw (3.6 mm screw length, no bit size) is blocked
  assert.deepEqual(
    memoryRoot.selectCandidatesCpu(cards, 'Какой размер биты нужен для винтов Pentalobe у iPhone 5?', 5),
    [],
  );
  assert.deepEqual(
    memoryRoot.selectCandidatesCpu(cards, 'Какой номер отвёртки подходит для винтов Pentalobe у iPhone 5?', 5),
    [],
  );

  // Asking which screwdriver or screw length still finds root-020
  const byTool = memoryRoot.selectCandidatesCpu(cards, 'Какой отвёрткой снимают винты Pentalobe у iPhone 5?', 5);
  assert.equal(byTool[0]?.id, 'root-020');
  const byPartDim = memoryRoot.selectCandidatesCpu(cards, 'Какой длины винты Pentalobe у iPhone 5?', 5);
  assert.equal(byPartDim[0]?.id, 'root-020');

  // Synthetic positive card WITH explicit tool size passes generic check
  assert.equal(
    memoryRoot.passesToolingAttributeGate('Какой размер биты нужен для винтов Pentalobe?', 'для винтов 3.6 мм используется бита p2'),
    true,
  );
  assert.equal(
    memoryRoot.passesToolingAttributeGate('Какой размер биты нужен для винтов Pentalobe?', 'используется бита 4 мм'),
    true,
  );
  assert.equal(
    memoryRoot.passesToolingAttributeGate('Какой размер биты нужен для винтов Pentalobe?', 'у iphone 5 два винта pentalobe длиной 3.6 мм снимают отверткой pentalobe'),
    false,
  );

  const prompt = memoryRoot.buildE4BPrompt('Какой размер биты нужен?', cards.find((c) => c.id === 'root-020'));
  assert.match(prompt, /part\/fastener\/object dimension.*tool\/bit\/driver size/i);
  assert.match(prompt, /Claim or Quote/i);
});

test('lookupApprovedRoot handles voice/Tor/26B/cold/busy skips cleanly without warming, swapping, or hitting Kiwix', async () => {
  const torState = createTorState({ now: () => 1000 });
  torState.touch({ inChat: true });

  // Voice skips before touching Ollama or Kiwix
  const voiceSkip = await memoryRoot.lookupApprovedRoot({
    cfg: { memoryRootLookup: 'on', provider: 'ollama', rp: false },
    said: '/nomad git stash без аргументов',
    voice: true,
    loadedModels: async () => { throw new Error('must not check ps on voice'); },
    callModel: async () => { throw new Error('must not call model on voice'); },
    fetchImpl: async () => { throw new Error('must not call kiwix on voice'); },
  });
  assert.deepEqual(voiceSkip, { handled: false, status: 'skipped', reason: 'voice' });

  // Tor skips before touching Ollama or Kiwix
  const torSkip = await memoryRoot.lookupApprovedRoot({
    cfg: { memoryRootLookup: 'on', provider: 'ollama', rp: false },
    said: '/nomad git stash без аргументов',
    torState,
    tor,
    loadedModels: async () => { throw new Error('must not check ps on tor'); },
    callModel: async () => { throw new Error('must not call model on tor'); },
    fetchImpl: async () => { throw new Error('must not call kiwix on tor'); },
  });
  assert.deepEqual(torSkip, { handled: false, status: 'skipped', reason: 'tor' });

  // 26B / cold / busy skip explicitly without calling model or Kiwix
  for (const [label, loaded, busy] of [
    ['26b', [MAIN], false],
    ['cold', [], false],
    ['busy', [FAST], true],
  ]) {
    const res = await memoryRoot.lookupApprovedRoot({
      cfg: { memoryRootLookup: 'on', provider: 'ollama', rp: false },
      said: '/nomad git stash без аргументов',
      loadedModels: async () => loaded,
      isBusy: () => busy,
      callModel: async () => { throw new Error(`must not call model on ${label}`); },
      fetchImpl: async () => { throw new Error(`must not call kiwix on ${label}`); },
    });
    assert.equal(res.handled, true);
    assert.equal(res.status, 'skipped');
    assert.equal(res.reason, label);
    assert.ok(res.text && res.text.length > 10);
  }
});

test('lookupApprovedRoot verifies Kiwix source before showing card/link and writes zero retrieval data', async () => {
  const cards = memoryRoot.getApprovedCards();
  const gitCard = cards.find((c) => c.id === 'root-001');
  const { fetchImpl } = makeMockKiwix({
    [gitCard.link]: 'Git documentation: Calling git stash without any arguments is equivalent to git stash push.',
  });

  // Successful verified hit
  const hit = await memoryRoot.lookupApprovedRoot({
    cfg: { memoryRootLookup: 'on', provider: 'ollama', rp: false, kiwixUrl: 'http://192.168.0.108:8090' },
    said: 'Капри, найди в номаде про git stash без аргументов',
    messages: [{ role: 'user', content: 'Капри, найди в номаде про git stash без аргументов' }],
    voice: false,
    loadedModels: async () => [FAST],
    isBusy: () => false,
    callModel: async () => 'SPAN: git stash push | VERDICT: YES',
    fetchImpl,
  });
  assert.equal(hit.handled, true);
  assert.equal(hit.status, 'hit');
  assert.equal(hit.card.id, 'root-001');
  assert.equal(Object.isFrozen(hit.card), true);
  assert.equal(hit.source.link, gitCard.link);
  assert.match(hit.text, /git stash push/);
  assert.match(hit.text, /http:\/\/127\.0\.0\.1:8090\/content\/devdocs_en_git_2026-10\/git-stash/);

  // Missing quote in Kiwix article -> source_unverified, never shows unverified link
  const { fetchImpl: badQuoteFetch } = makeMockKiwix({
    [gitCard.link]: 'Completely unrelated article text without the expected quote.',
  });
  const unverified = await memoryRoot.lookupApprovedRoot({
    cfg: { memoryRootLookup: 'on', provider: 'ollama', rp: false },
    said: '/nomad git stash без аргументов',
    loadedModels: async () => [FAST],
    isBusy: () => false,
    callModel: async () => 'SPAN: git stash push | VERDICT: YES',
    fetchImpl: badQuoteFetch,
  });
  assert.equal(unverified.handled, true);
  assert.equal(unverified.status, 'source_unverified');
  assert.equal(unverified.reason, 'quote_missing');
  assert.doesNotMatch(unverified.text, /\/content\/devdocs_en_git_2026-10\/git-stash/);

  // Unsafe path traversal in card link -> blocked before fetch
  const badCard = { ...gitCard, link: '/content/devdocs_en_git_2026-10/../../etc/passwd' };
  const srcUnsafe = await memoryRoot.verifyCardSource({ card: badCard, fetchImpl });
  assert.equal(srcUnsafe.ok, false);
  assert.equal(srcUnsafe.reason, 'unsafe_link');

  // Gate off -> handled: false, leaves normal chat untouched
  const gatedOff = await memoryRoot.lookupApprovedRoot({
    cfg: { memoryRootLookup: 'off', provider: 'ollama', rp: false },
    said: '/nomad git stash без аргументов',
    loadedModels: async () => { throw new Error('must not be called'); },
    callModel: async () => { throw new Error('must not be called'); },
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(gatedOff, { handled: false, status: 'skipped', reason: 'disabled' });
});
