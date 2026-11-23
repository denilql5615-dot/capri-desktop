'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BUILTIN_COMMANDS,
  SlashCommandEngine,
  parseSlashInput,
  compactHistory,
  parseSkillFrontmatter,
} = require('../src/main/slash-commands');
const { PhoneBridge } = require('../src/main/phone');
const chats = require('../src/main/chats');
const { AgentSessions } = require('../src/main/agent-sessions');

function makeTempSkillRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-skills-test-'));
  const geminiRoot = path.join(base, 'gemini');
  const codexRoot = path.join(base, 'codex');
  fs.mkdirSync(path.join(geminiRoot, 'second-brain'), { recursive: true });
  fs.mkdirSync(path.join(geminiRoot, 'caveman'), { recursive: true });
  fs.mkdirSync(path.join(codexRoot, 'caveman'), { recursive: true });
  fs.mkdirSync(path.join(codexRoot, 'custom-codex'), { recursive: true });

  fs.writeFileSync(
    path.join(geminiRoot, 'second-brain', 'SKILL.md'),
    '---\nname: "second-brain"\ndescription: "Оценка идей по логике и фактам"\n---\n# Второй мозг\nБез поддакивания.\n',
  );
  fs.writeFileSync(
    path.join(geminiRoot, 'caveman', 'SKILL.md'),
    '---\nname: caveman\ndescription: >\n  Terse caveman voice:\n  answer first, fluff gone.\n---\n# caveman\nDrop fluff.\n',
  );
  // Duplicate in codex should be deduplicated in favor of first root (geminiRoot)
  fs.writeFileSync(
    path.join(codexRoot, 'caveman', 'SKILL.md'),
    '---\nname: caveman\ndescription: Duplicate\n---\n',
  );
  fs.writeFileSync(
    path.join(codexRoot, 'custom-codex', 'SKILL.md'),
    '---\nname: custom-codex\ndescription: Codex only skill\n---\nBody here.\n',
  );
  return { base, roots: [geminiRoot, codexRoot] };
}

test('registry contains all 66 built-in commands with required aliases and sections', () => {
  assert.equal(BUILTIN_COMMANDS.length, 66);
  const ids = new Set(BUILTIN_COMMANDS.map((c) => c.id));
  assert.equal(ids.size, 66);

  const byId = new Map(BUILTIN_COMMANDS.map((c) => [c.id, c]));
  assert.ok(byId.get('new').aliases.includes('clear'));
  assert.ok(byId.get('usage').aliases.includes('quota'));
  assert.ok(byId.get('help').aliases.includes('find'));
  assert.equal(byId.get('genesis-techlead-reviewer').section, 'skills');
  assert.equal(byId.get('genesis-techlead-reviewer').kind, 'skill');
  assert.equal(byId.get('delete').confirmRequired, true);
  for (const item of BUILTIN_COMMANDS) {
    for (const field of ['id', 'name', 'slash', 'aliases', 'section', 'kind', 'icon', 'description', 'badge', 'active', 'chainable', 'confirmRequired', 'cloudOnly', 'argsHint']) {
      assert.ok(Object.hasOwn(item, field), `Missing field ${field} on ${item.id}`);
    }
  }
});

test('dynamic skill scanner parses YAML frontmatter, caches in memory, and refreshes on /reload-skills', async () => {
  const { base, roots } = makeTempSkillRoots();
  try {
    const engine = new SlashCommandEngine({ skillRoots: roots });
    const list1 = engine.listCommands({ mode: 'chat', contextPct: 62.4 });
    assert.deepEqual(list1.sections.map((s) => s.id), ['commands', 'skills', 'plugins', 'connectors', 'styles']);
    assert.equal(list1.sections[2].stage, '2.3');
    assert.equal(list1.sections[3].stage, '2.4');
    assert.equal(list1.sections[4].stage, '2.7');

    const compactItem = list1.sections[0].items.find((i) => i.id === 'compact');
    assert.equal(compactItem.badge, '62%');

    const skillIds = list1.sections[1].items.map((i) => i.id);
    assert.ok(skillIds.includes('genesis-techlead-reviewer'));
    assert.ok(skillIds.includes('second-brain'));
    assert.ok(skillIds.includes('caveman'));
    assert.ok(skillIds.includes('custom-codex'));
    assert.equal(skillIds.filter((x) => x === 'caveman').length, 1);

    // Add a new skill on disk and verify cache holds until reload-skills
    fs.mkdirSync(path.join(roots[0], 'fresh-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(roots[0], 'fresh-skill', 'SKILL.md'),
      '---\nname: fresh-skill\ndescription: Новый динамический навык\n---\n',
    );
    assert.ok(!engine.listCommands().sections[1].items.some((i) => i.id === 'fresh-skill'));

    const reloadRes = await engine.run({ text: '/reload-skills' });
    assert.equal(reloadRes.handled, true);
    assert.equal(reloadRes.instant, true);
    assert.ok(engine.listCommands().sections[1].items.some((i) => i.id === 'fresh-skill'));

    const fm = parseSkillFrontmatter('---\nname: test\ndescription: >\n  line one\n  line two\n---\nBody');
    assert.equal(fm.description, 'line one line two');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('mode filtering hides cloudOnly commands in private, nsfw, tor, and ephemeral and rejects manual runs', async () => {
  const engine = new SlashCommandEngine({ skillRoots: [] });
  for (const ctx of [{ mode: 'private' }, { mode: 'nsfw' }, { mode: 'tor' }, { mode: 'chat', ephemeral: true }]) {
    const listed = engine.listCommands(ctx);
    const cmdIds = new Set(listed.sections[0].items.map((i) => i.id));
    for (const cloudId of ['deep', 'council', 'web', 'agents', 'harness', 'ultrareview']) {
      assert.ok(!cmdIds.has(cloudId), `${cloudId} must be hidden in ${JSON.stringify(ctx)}`);
    }
    assert.ok(cmdIds.has('compact'));
    assert.ok(cmdIds.has('tor'));

    const res = await engine.run({ text: '/deep квантовая криптография', ...ctx });
    assert.equal(res.handled, true);
    assert.ok(res.error);
  }
});

test('parseSlashInput handles skill and prompt chaining and /btw', () => {
  const { base, roots } = makeTempSkillRoots();
  try {
    const engine = new SlashCommandEngine({ skillRoots: roots });
    const reg = engine.registry();

    const chained = parseSlashInput('/caveman /second-brain /grill-me разбери план', reg);
    assert.equal(chained.isSlash, true);
    assert.deepEqual(chained.chain.map((c) => c.id), ['caveman', 'second-brain', 'grill-me']);
    assert.equal(chained.remainder, 'разбери план');
    assert.equal(chained.primary.id, 'caveman');
    assert.equal(chained.instant, false);
    assert.equal(chained.btw, false);

    const btwParsed = parseSlashInput('/btw как работает кэш?', reg);
    assert.equal(btwParsed.btw, true);
    assert.equal(btwParsed.remainder, 'как работает кэш?');

    const nonChain = parseSlashInput('/remember /path/to/secret/note', reg);
    assert.deepEqual(nonChain.chain.map((c) => c.id), ['remember']);
    assert.equal(nonChain.remainder, '/path/to/secret/note');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('session state persists to config and /delete requires confirm', async () => {
  let storedConfig = {};
  const engine = new SlashCommandEngine({
    skillRoots: [],
    getConfig: () => storedConfig,
    saveConfig: (patch) => { storedConfig = { ...storedConfig, ...patch }; },
  });

  const s0 = engine.getState();
  assert.equal(s0.autocompact, true);
  assert.equal(s0.autocompactThreshold, 80);
  assert.equal(s0.effort, 'medium');
  assert.equal(s0.outputStyle, 'default');
  assert.equal(s0.pet, true);

  await engine.run({ text: '/plan-mode on' });
  await engine.run({ text: '/focus on' });
  await engine.run({ text: '/effort xhigh' });
  await engine.run({ text: '/output-style technical' });
  await engine.run({ text: '/autocompact 75' });
  await engine.run({ text: '/advisor claude-opus-5-5' });
  await engine.run({ text: '/pet off' });

  assert.equal(storedConfig.slashState.planMode, true);
  assert.equal(storedConfig.slashState.focus, true);
  assert.equal(storedConfig.slashState.effort, 'xhigh');
  assert.equal(storedConfig.slashState.outputStyle, 'technical');
  assert.equal(storedConfig.slashState.autocompactThreshold, 75);
  assert.equal(storedConfig.slashState.advisor, 'claude-opus-5-5');
  assert.equal(storedConfig.slashState.pet, false);

  let deleted = false;
  engine.deps.deleteSession = () => { deleted = true; };
  const unconfirmed = await engine.run({ text: '/delete' });
  assert.equal(unconfirmed.confirmRequired, true);
  assert.equal(deleted, false);

  const confirmed = await engine.run({ text: '/delete', confirm: true });
  assert.equal(confirmed.deleted, true);
  assert.equal(deleted, true);
});

test('compactHistory keeps last 4-6 turns intact and uses extractive fallback on summarizer failure', async () => {
  const history = [];
  for (let i = 1; i <= 10; i++) {
    history.push({ role: 'user', content: `Вопрос ${i}: обсуждаем архитектуру модуля ${i}` });
    history.push({ role: 'assistant', content: `Ответ ${i}: зафиксировали решение по модулю ${i}` });
  }

  const fallbackRes = await compactHistory({
    history,
    focus: 'модулю 3',
    mode: 'private',
    ephemeral: true,
    summarizer: async () => { throw new Error('offline'); },
  });
  assert.equal(fallbackRes.ok, true);
  assert.ok(fallbackRes.summary.startsWith('[Конспект предыдущей части разговора'));
  assert.ok(fallbackRes.keptCount >= 4 && fallbackRes.keptCount <= 6);
  assert.equal(fallbackRes.droppedCount + fallbackRes.keptCount, 20);
  assert.equal(fallbackRes.history[0].content, fallbackRes.summary);
  assert.equal(fallbackRes.history.at(-1).content, history.at(-1).content);
  assert.ok(fallbackRes.context.maxTokens > 0);
});

test('chats.js adds rename, setPinned, setArchived, fork, and exposes metadata in list', () => {
  let store = { chats: [] };
  store = chats.add(store, { role: 'user', content: 'Первый вопрос' }, 1000);
  store = chats.add(store, { role: 'assistant', content: 'Первый ответ' }, 2000);
  const id = store.chats[0].id;

  chats.rename(store, id, 'Важный разговор');
  chats.setPinned(store, id, true);
  chats.setArchived(store, id, true);
  const forked = chats.fork(store, id, 3000);
  assert.ok(forked && forked.id !== id);
  assert.equal(forked.messages.length, 2);
  assert.equal(forked.customTitle, 'Важный разговор (копия)');

  const listed = chats.list(store, 4000);
  const orig = listed.chats.find((c) => c.id === id);
  assert.equal(orig.title, 'Важный разговор');
  assert.equal(orig.customTitle, 'Важный разговор');
  assert.equal(orig.pinned, true);
  assert.equal(orig.archived, true);
});

test('AgentSessions supports compact, fork, rename, setPinned, setArchived, remove, and btw send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-agent-slash-'));
  const file = path.join(dir, 'sessions.json');
  try {
    const hub = new AgentSessions(file, async (_agent, _model, messages) => {
      return `reply:${messages.length}:${messages.at(-1).content}`;
    }, () => {});
    const id = hub.create('codex');
    for (let i = 1; i <= 5; i++) {
      await hub.send(id, 'gpt-6.2-sol', `task ${i}`, false, false, true);
    }
    assert.equal(hub.history(id).length, 10);

    const btwRes = await hub.send(id, 'gpt-6.2-sol', 'side question', false, false, true, { btw: true });
    assert.equal(btwRes.ok, true);
    assert.equal(btwRes.btw, true);
    assert.match(btwRes.text, /reply:11:side question/);
    assert.equal(hub.history(id).length, 10);

    hub.rename(id, 'Релиз');
    hub.setPinned(id, true);
    hub.setArchived(id, true);
    const sum = hub.summaries().find((s) => s.id === id);
    assert.equal(sum.title, 'Релиз');
    assert.equal(sum.pinned, true);
    assert.equal(sum.archived, true);

    const forked = hub.fork(id);
    assert.ok(forked.ok && forked.id !== id);
    assert.equal(hub.history(forked.id).length, 10);

    const compacted = await hub.compact(id, { focus: 'task 2', useModel: false });
    assert.equal(compacted.ok, true);
    assert.ok(compacted.summary.includes('[Конспект предыдущей части разговора'));
    assert.ok(compacted.keptCount >= 4 && compacted.keptCount <= 6);
    assert.equal(hub.history(id).length, compacted.keptCount + 1);

    hub.remove(forked.id);
    assert.ok(!hub.list().some((s) => s.id === forked.id));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PhoneBridge exposes /ping slashCommands, /commands, non-blocking /commands/run, /chat/compact, /agents/compact, chaining and /btw', async () => {
  const { base, roots } = makeTempSkillRoots();
  let releaseChat;
  const chatInFlight = new Promise((resolve) => { releaseChat = resolve; });
  let chatStarted;
  const startedPromise = new Promise((resolve) => { chatStarted = resolve; });
  const logged = [];
  const chatCalls = [];
  const agentCalls = [];
  let compactedAgent = null;

  const engine = new SlashCommandEngine({
    skillRoots: roots,
    deps: {
      statusText: async () => 'ОЗУ 12 / 32 ГБ',
    },
  });

  const bridge = new PhoneBridge({
    token: () => 'tok',
    persona: () => 'Персона.',
    slashEngine: engine,
    log: (row) => logged.push(row),
    chat: async (messages, _signal, opts) => {
      chatCalls.push({ messages, opts });
      if (messages.at(-1).content === 'долгий запрос') {
        chatStarted();
        await chatInFlight;
        return { text: 'долгий ответ', brain: 'e4b' };
      }
      if (opts?.fastLocal) {
        return { text: '[Конспект предыдущей части разговора]\n- Итог от локального мозга.', brain: 'e4b' };
      }
      return { text: `ответ:${messages.at(-1).content}`, brain: 'e4b' };
    },
    agentSend: async (payload) => {
      agentCalls.push(payload);
      return { ok: true, text: `agent:${payload.text}`, btw: payload.btw === true };
    },
    agentCompact: async ({ id, focus }) => {
      compactedAgent = { id, focus };
      return {
        ok: true,
        summary: '[Конспект предыдущей части разговора]\n- Агент',
        history: [{ role: 'assistant', content: '[Конспект предыдущей части разговора]\n- Агент' }],
        droppedCount: 4,
        keptCount: 4,
        context: { percent: 12 },
      };
    },
  });
  engine.deps = { ...bridge.buildSlashDeps(), ...engine.deps };

  const port = await bridge.start(0, '127.0.0.1');
  const api = (urlPath, body) => fetch(`http://127.0.0.1:${port}${urlPath}`, {
    headers: { 'x-capri-token': 'tok' },
    ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
  });

  try {
    const ping = await (await api('/ping')).json();
    assert.equal(ping.slashCommands, true);

    const cmdsPublic = await (await api('/commands?mode=chat&pct=44')).json();
    assert.equal(cmdsPublic.sections[0].items.find((i) => i.id === 'compact').badge, '44%');
    assert.ok(cmdsPublic.sections[0].items.some((i) => i.id === 'deep'));

    const cmdsPrivate = await (await api('/commands?mode=private')).json();
    assert.ok(!cmdsPrivate.sections[0].items.some((i) => i.id === 'deep'));

    const blockedRun = await api('/commands/run', { text: '/council тест', mode: 'tor' });
    assert.equal(blockedRun.status, 403);

    // Start a blocking /chat request and verify instant /commands/run completes WITHOUT waiting!
    const pendingChat = api('/chat', { text: 'долгий запрос' });
    await startedPromise;
    const instantRes = await (await api('/commands/run', { text: '/status', mode: 'chat' })).json();
    assert.equal(instantRes.handled, true);
    assert.equal(instantRes.instant, true);
    assert.equal(instantRes.reply, 'ОЗУ 12 / 32 ГБ');
    releaseChat();
    await pendingChat;

    // /btw in POST /chat must NOT push to bridge.turns or call log()
    const turnsBefore = bridge.turns.length;
    const loggedBefore = logged.length;
    const btwChat = await (await api('/chat', { text: '/btw что это было?' })).json();
    assert.equal(btwChat.btw, true);
    assert.equal(btwChat.reply, 'ответ:что это было?');
    assert.equal(bridge.turns.length, turnsBefore);
    assert.equal(logged.length, loggedBefore);

    // Chained skills in POST /chat
    const chainedChat = await (await api('/chat', { text: '/caveman /second-brain проверь план' })).json();
    assert.equal(chainedChat.reply, 'ответ:проверь план');
    assert.ok(chatCalls.at(-1).opts.skills.includes('caveman'));
    assert.ok(chatCalls.at(-1).opts.skills.includes('second-brain'));

    // Chained skills and /btw in POST /agents/send
    const chainedAgent = await (await api('/agents/send', { id: 's1', text: '/caveman /review проверь код' })).json();
    assert.equal(chainedAgent.ok, true);
    assert.match(agentCalls.at(-1).text, /проверь код/);

    const btwAgent = await (await api('/agents/send', { id: 's1', text: '/btw статус?' })).json();
    assert.equal(btwAgent.btw, true);
    assert.equal(agentCalls.at(-1).btw, true);

    // POST /chat/compact
    const longHistory = Array.from({ length: 10 }, (_, idx) => ({
      role: idx % 2 === 0 ? 'user' : 'assistant',
      content: `msg ${idx}`,
    }));
    const chatCompacted = await (await api('/chat/compact', { mode: 'private', ephemeral: true, history: longHistory })).json();
    assert.equal(chatCompacted.ok, true);
    assert.ok(chatCompacted.summary.startsWith('[Конспект предыдущей части разговора]'));
    assert.ok(chatCalls.at(-1).opts.localOnly === true);

    // POST /agents/compact
    const agentCompacted = await (await api('/agents/compact', { id: 'sess-9', focus: 'auth' })).json();
    assert.equal(agentCompacted.ok, true);
    assert.deepEqual(compactedAgent, { id: 'sess-9', focus: 'auth' });
  } finally {
    await bridge.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('preload.js and main.js expose and register slash command and chat management contracts', () => {
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  for (const key of ['commandsList', 'commandsRun', 'chatCompact', 'agentsCompact', 'chatsRename', 'chatsPin', 'chatsArchive', 'chatsFork']) {
    assert.ok(preloadSrc.includes(`${key}:`), `preload.js missing ${key}`);
  }
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  for (const ch of ['commands:list', 'commands:run', 'chat:compact', 'agents:compact', 'chats:rename', 'chats:pin', 'chats:archive', 'chats:fork']) {
    assert.ok(mainSrc.includes(`'${ch}'`), `main.js missing IPC handler ${ch}`);
  }
});
