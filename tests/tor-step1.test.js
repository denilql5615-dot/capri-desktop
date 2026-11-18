'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tor = require('../src/main/tor');
const {
  TOR_COOLDOWN_MS,
  TOR_MCP_DISABLED_MSG,
  createTorState,
  shouldSkipChatPersistence,
  isLocalOnlyModelAllowed,
  pickSafeFallbackModel,
  pickTorSearchModel,
  guardChatRoute,
  guardWorkerChoice,
  guardScreenCapture,
  classifyWebSearch,
  escapePromptDelimiters,
  escapeHeaderField,
} = require('../src/main/tor-guard');

test('Tor Step 1 synthetic taint (no "Tor" words): blocks persistence, cloud fallback, workers, and screen captures end-to-end', async () => {
  let clock = 1_000_000;
  const torState = createTorState({ now: () => clock });

  // Clean session initially allows everything
  assert.equal(torState.isQuarantined(), false);
  const cleanMsgs = [{ role: 'user', content: 'запомни что я люблю чай с бергамотом' }];
  assert.equal(shouldSkipChatPersistence({ torState, messages: cleanMsgs, tor }), false);
  assert.equal(guardChatRoute({ torState, text: 'сделай фото кота', tor }), false);
  assert.equal(guardWorkerChoice({ worker: 'claude', torState, messages: cleanMsgs, tor }), 'claude');
  assert.equal(guardScreenCapture({ torState }).ok, true);

  // Synthetic Tor taint WITHOUT any "Tor" or ".onion" words in subsequent messages
  torState.touch({ inChat: true });
  assert.equal(torState.isQuarantined(), true);

  // 1. Persistence skipped (quickAnswer / chat:remember / chat:log) even for ordinary non-Tor text
  assert.equal(shouldSkipChatPersistence({ torState, messages: cleanMsgs, tor }), true);
  assert.equal(shouldSkipChatPersistence({ torState, messages: [{ role: 'assistant', content: 'обычный ответ' }], tor }), true);

  // 2. Cloud providers & cloud Ollama models blocked on first attempt AND fallback
  const ollama = { isCloud: (m) => /[:-]cloud$/i.test(m || ''), models: async () => ['beam:cloud', 'gemma4:e4b'] };
  const llm = {
    isLocal: (provider, _cfg, model) => provider === 'ollama' && !ollama.isCloud(model),
  };

  assert.equal(isLocalOnlyModelAllowed({
    cfg: { provider: 'gemini', chatModel: 'gemini-2.5-pro' },
    model: 'gemini-2.5-pro',
    llm,
    ollama,
    localOnly: true,
  }), false);

  assert.equal(isLocalOnlyModelAllowed({
    cfg: { provider: 'ollama', chatModel: 'beam:cloud' },
    model: 'beam:cloud',
    llm,
    ollama,
    localOnly: true,
  }), false);

  assert.equal(isLocalOnlyModelAllowed({
    cfg: { provider: 'ollama', chatModel: 'gemma4:e4b' },
    model: 'gemma4:e4b',
    llm,
    ollama,
    localOnly: true,
  }), true);

  // Fallback with only cloud models left returns null (never falls back to beam:cloud)
  const tried = new Set(['gemma4:e4b']);
  const chatModels = ['gemma4:e4b', 'beam:cloud', 'deepseek-v3.1:cloud'];
  assert.equal(pickSafeFallbackModel({
    cfg: { provider: 'ollama', chatModel: 'gemma4:e4b' },
    chatModels,
    tried,
    ollama,
    llm,
    localOnly: true,
  }), null);
  // Outside localOnly, cloud fallback remains available when all local models fail
  assert.equal(pickSafeFallbackModel({
    cfg: { provider: 'ollama', chatModel: 'gemma4:e4b' },
    chatModels,
    tried,
    ollama,
    llm,
    localOnly: false,
  }), 'beam:cloud');

  // Preliminary chat:route & worker dispatch refuse all cloud workers (claude/codex/gemini/computer)
  assert.equal(guardChatRoute({ torState, text: 'клод напиши функцию', tor }), true);
  for (const w of ['claude', 'codex', 'gemini', 'computer']) {
    assert.equal(guardWorkerChoice({ worker: w, torState, messages: cleanMsgs, tor }), null);
  }

  // 3. Screen captures (manual & automatic Look, look:snap, look:say, screenPhotoTask) blocked under quarantine
  const cap = guardScreenCapture({ torState });
  assert.equal(cap.ok, false);
  assert.equal(cap.code, 'tor');
  assert.match(cap.error, /карантин/i);

  // Even after chats:new resets chatTainted, 10-minute cooldown keeps quarantine active
  torState.resetChat();
  assert.equal(torState.isQuarantined(), true);
  assert.equal(guardScreenCapture({ torState }).ok, false);
  assert.equal(shouldSkipChatPersistence({ torState, messages: cleanMsgs, tor }), true);

  // Once cooldown expires AND chat is reset, clean behavior resumes
  clock += TOR_COOLDOWN_MS;
  assert.equal(torState.isQuarantined(), false);
  assert.equal(shouldSkipChatPersistence({ torState, messages: cleanMsgs, tor }), false);
  assert.equal(guardChatRoute({ torState, text: 'нарисуй кота', tor }), false);
  assert.equal(guardWorkerChoice({ worker: 'claude', torState, messages: cleanMsgs, tor }), 'claude');
  assert.equal(guardScreenCapture({ torState }).ok, true);
});

test('pickTorSearchModel refuses cloud configs/models and selects only verified local Ollama models when !roles', async () => {
  const isCloud = (m) => /[:-]cloud$/i.test(m || '');
  const llm = { isLocal: (provider, _cfg, model) => provider === 'ollama' && !isCloud(model) };

  // Cloud provider (gemini) + only cloud Ollama models installed -> honest refusal (null)
  assert.equal(await pickTorSearchModel({
    cfg: { provider: 'gemini', chatModel: 'gemini-2.5-pro' },
    roles: false,
    ollama: { isCloud, models: async () => ['beam:cloud'] },
    llm,
    chatModels: ['beam:cloud'],
  }), null);

  // Ollama provider set to beam:cloud, but local gemma4:e4b is installed -> picks local gemma4:e4b
  assert.equal(await pickTorSearchModel({
    cfg: { provider: 'ollama', chatModel: 'beam:cloud' },
    roles: false,
    ollama: { isCloud, models: async () => ['beam:cloud', 'gemma4:e4b'] },
    llm,
    chatModels: ['beam:cloud', 'gemma4:e4b'],
  }), 'gemma4:e4b');

  // When provider is gemini (non-ollama), never blindly use cfg.chatModel; pick installed local Ollama model if present
  assert.equal(await pickTorSearchModel({
    cfg: { provider: 'gemini', chatModel: 'gemini-2.5-pro' },
    roles: false,
    ollama: { isCloud, models: async () => ['gemma4:e4b'] },
    llm,
    chatModels: ['gemini-2.5-pro'],
  }), 'gemma4:e4b');
});

test('classifyWebSearch does not extract embedded .onion from foreign URL in how.onion and escapes delimiters cleanly', () => {
  const embedded = 'https://evil.example/?q=http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/about';
  const plan = classifyWebSearch('', { onion: embedded }, tor);
  assert.equal(plan.torRequested, true);
  assert.equal(plan.onion, null);
  assert.equal(plan.query, embedded);

  assert.equal(escapePromptDelimiters('a<<<b>>>c'), 'a‹‹‹b›››c');
  assert.equal(escapeHeaderField('Title>>>\nFake'), 'Title››› Fake');
  assert.match(TOR_MCP_DISABLED_MSG, /MCP/);
});
