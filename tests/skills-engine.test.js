'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SkillsEngine,
  SKILL_CATEGORIES,
  QUICK_TOGGLES,
  DISTILLED_ALWAYS_ON,
  STAGE_25_BUILTIN_SKILLS,
} = require('../src/main/skills-engine');
const {
  BUILTIN_COMMANDS,
  COMMAND_CATEGORIES,
  SlashCommandEngine,
} = require('../src/main/slash-commands');
const { PhoneBridge, parsePromptFlags } = require('../src/main/phone');
const { AgentSessions } = require('../src/main/agent-sessions');

function writeSkill(root, dirName, content) {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
}

function makeFixtureEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-skills-engine-'));
  const userDataDir = path.join(base, 'userData');
  const antigravityRoot = path.join(base, 'gemini-skills');
  const codexRoot = path.join(base, 'codex-skills');
  const packsRoot = path.join(base, 'packs');

  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(antigravityRoot, { recursive: true });
  fs.mkdirSync(codexRoot, { recursive: true });

  // Standalone curated skills across all 5 categories
  writeSkill(antigravityRoot, 'caveman', '---\nname: caveman\ndescription: Terse caveman voice\n---\n# Caveman\nAnswer first. No fluff.\n');
  writeSkill(antigravityRoot, 'i-have-adhd', '---\nname: i-have-adhd\ndescription: ADHD-friendly steps\n---\n# ADHD\nNext action first.\n');
  writeSkill(antigravityRoot, 'second-brain', '---\nname: second-brain\ndescription: Critical thinking partner\n---\n# Second Brain\nLogic and facts.\n');
  writeSkill(antigravityRoot, 'russian-editor', '---\nname: russian-editor\ndescription: Natural Russian prose\n---\n# Russian Editor\nNo AI cliches.\n');
  writeSkill(antigravityRoot, 'save', '---\nname: save\ndescription: Save note to Obsidian\n---\n# Save\nWrite to vault.\n');
  writeSkill(antigravityRoot, 'wiki-query', '---\nname: wiki-query\ndescription: Query Obsidian wiki\n---\n# Wiki Query\nRead-only vault query.\n');
  writeSkill(antigravityRoot, 'wiki-ingest', '---\nname: wiki-ingest\ndescription: Ingest source into Obsidian\n---\n# Wiki Ingest\nMutates vault.\n');
  writeSkill(antigravityRoot, 'autoresearch', '---\nname: autoresearch\ndescription: Web deep research\n---\n# Autoresearch\nUses web.\n');
  writeSkill(antigravityRoot, 'google-workspace', '---\nname: google-workspace\ndescription: Google Docs and Drive\n---\n# Google Workspace\nCloud API.\n');
  writeSkill(antigravityRoot, 'research-method', '---\nname: research-method\ndescription: Multi-source research method\n---\n# Research Method\nSynthesize sources.\n');
  writeSkill(antigravityRoot, 'computer-use', '---\nname: computer-use\ndescription: Desktop control\n---\n# Computer Use\nDesktop actions.\n');

  // Codex fallback: duplicates caveman, has excluded blender/lowpoly, and legacy deep-research
  writeSkill(codexRoot, 'caveman', '---\nname: caveman\ndescription: Duplicate fallback should be ignored\n---\nFallback body.\n');
  writeSkill(codexRoot, 'deep-research', '---\nname: deep-research\ndescription: Old alias must be skipped when research-method exists\n---\nLegacy.\n');
  writeSkill(codexRoot, 'blender-model-qa', '---\nname: blender-model-qa\ndescription: Excluded\n---\nExcluded.\n');
  writeSkill(codexRoot, 'lowpoly-character-pro', '---\nname: lowpoly-character-pro\ndescription: Excluded\n---\nExcluded.\n');
  writeSkill(codexRoot, 'docx', '---\nname: docx\ndescription: Word documents\n---\n# DOCX\nCreate Word doc.\n');

  // Custom skill overriding nothing yet, plus test of custom override
  const customRoot = path.join(userDataDir, 'skills');
  writeSkill(customRoot, 'my-custom', '---\nname: my-custom\ndescription: Custom helper\ncategory: style\n---\nKeep answers grounded in tests.\n');

  // Smart Packs
  const impDir = path.join(packsRoot, 'impeccable-ui');
  writeSkill(path.join(impDir, '.claude', 'skills'), 'impeccable', '---\nname: impeccable\ndescription: UI/UX design craft\n---\n# Impeccable\nCore UI rules.\n');
  fs.mkdirSync(path.join(impDir, '.claude', 'skills', 'impeccable', 'reference'), { recursive: true });
  fs.writeFileSync(path.join(impDir, '.claude', 'skills', 'impeccable', 'reference', 'polish.md'), '# Polish\nFinal quality pass for UI spacing, borders, and alignment.\n', 'utf8');
  fs.writeFileSync(path.join(impDir, '.claude', 'skills', 'impeccable', 'reference', 'animate.md'), '# Animate\nMotion timing, transitions, and reduced-motion rules.\n', 'utf8');

  const mktDir = path.join(packsRoot, 'marketingskills', 'skills');
  writeSkill(mktDir, 'copywriting', '---\nname: copywriting\ndescription: Conversion landing page and headline copywriting\n---\n# Copywriting\nWrite clear CTA and hero copy.\n');
  writeSkill(mktDir, 'seo-audit', '---\nname: seo-audit\ndescription: Technical SEO audit and metadata checks\n---\n# SEO Audit\nCheck crawlability and tags.\n');

  const gameDir = path.join(packsRoot, 'game-studios-reference', '.claude', 'skills');
  writeSkill(gameDir, 'balance-check', '---\nname: balance-check\ndescription: Economy progression and game balance formulas\n---\n# Balance Check\nAudit curves.\n');
  writeSkill(gameDir, 'level-design', '---\nname: level-design\ndescription: Encounter pacing and level layout\n---\n# Level Design\nBlockout flow.\n');

  let cfg = {};
  const engine = new SkillsEngine({
    userDataDir,
    skillRoots: [antigravityRoot, codexRoot],
    packRoots: {
      'impeccable-ui': path.join(packsRoot, 'impeccable-ui'),
      marketingskills: path.join(packsRoot, 'marketingskills'),
      'game-studios-reference': path.join(packsRoot, 'game-studios-reference'),
    },
    getConfig: () => cfg,
    saveConfig: (patch) => { cfg = { ...cfg, ...patch }; },
  });

  return {
    base,
    userDataDir,
    antigravityRoot,
    codexRoot,
    getCfg: () => cfg,
    engine,
  };
}

test('SkillsEngine scans priority roots, excludes blender/lowpoly, skips deep-research, loads smart packs & Stage-2.5 memos', () => {
  const fx = makeFixtureEnv();
  try {
    const listed = fx.engine.listSkills({ mode: 'chat', ephemeral: false });
    const ids = new Set(listed.items.map((i) => i.id));

    // Excluded skills & duplicate deep-research
    assert.ok(!ids.has('blender-model-qa'));
    assert.ok(!ids.has('lowpoly-character-pro'));
    assert.ok(!ids.has('deep-research'));
    assert.ok(ids.has('research-method'));

    // Priority: antigravity caveman wins over codex fallback
    const caveman = listed.items.find((i) => i.id === 'caveman');
    assert.equal(caveman.description, 'Terse caveman voice');

    // Custom skill preserves category
    const custom = listed.items.find((i) => i.id === 'my-custom');
    assert.equal(custom.isCustom, true);
    assert.equal(custom.category, 'style');
    assert.equal(custom.canPinAlways, true);

    // 3 smart packs
    const imp = listed.items.find((i) => i.id === 'impeccable-ui');
    assert.equal(imp.isPack, true);
    assert.equal(imp.subCount, 3);
    assert.equal(imp.category, 'creative');

    const mkt = listed.items.find((i) => i.id === 'marketingskills');
    assert.equal(mkt.isPack, true);
    assert.equal(mkt.subCount, 2);

    const game = listed.items.find((i) => i.id === 'game-studios-reference');
    assert.equal(game.isPack, true);
    assert.equal(game.subCount, 2);

    // 4 Stage-2.5 tool reminder skills + computer-use stageNote
    for (const memo of STAGE_25_BUILTIN_SKILLS) {
      const item = listed.items.find((i) => i.id === memo.id);
      assert.ok(item, `Missing Stage-2.5 skill ${memo.id}`);
      assert.equal(item.stageNote, 'Этап 2.5 (памятка)');
      assert.equal(item.category, 'system');
    }
    assert.equal(listed.items.find((i) => i.id === 'computer-use').stageNote, 'Требует инструмент ПК · 2.5');

    // 5 ordered semantic categories
    assert.deepEqual(listed.categories.map((c) => c.id), SKILL_CATEGORIES.map((c) => c.id));
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('SkillsEngine default toggles, distilled alwaysOn budget, and persistent toggleSkill', () => {
  const fx = makeFixtureEnv();
  try {
    const initial = fx.engine.listSkills();
    assert.deepEqual(initial.quickToggles, QUICK_TOGGLES);

    const sb = initial.items.find((i) => i.id === 'second-brain');
    const adhd = initial.items.find((i) => i.id === 'i-have-adhd');
    const caveman = initial.items.find((i) => i.id === 'caveman');
    assert.equal(sb.enabled, true);
    assert.equal(sb.alwaysOn, true);
    assert.equal(adhd.enabled, true);
    assert.equal(adhd.alwaysOn, false);
    assert.equal(caveman.enabled, true);
    assert.equal(caveman.alwaysOn, false);

    // Distilled prompts must stay compact (~180-350 tokens each)
    for (const [id, text] of Object.entries(DISTILLED_ALWAYS_ON)) {
      assert.ok(text.length >= 120 && text.length <= 1200, `Unexpected distilled length for ${id}`);
    }
    assert.ok(initial.budget.alwaysOnTokens > 0 && initial.budget.alwaysOnTokens < 500);
    assert.equal(initial.budget.overSoftLimit, false);
    assert.deepEqual(initial.budget.pinnedIds, ['second-brain']);

    // Cannot pin heavy pack skill as alwaysOn
    const badPin = fx.engine.toggleSkill({ id: 'impeccable-ui', alwaysOn: true });
    assert.equal(badPin.ok, false);

    // Toggle caveman alwaysOn=true and second-brain enabled=false
    const toggledCaveman = fx.engine.toggleSkill({ id: 'caveman', enabled: true, alwaysOn: true });
    assert.equal(toggledCaveman.ok, true);
    assert.equal(toggledCaveman.skill.alwaysOn, true);
    assert.ok(toggledCaveman.budget.pinnedIds.includes('caveman'));

    const disabledSb = fx.engine.toggleSkill({ id: 'second-brain', enabled: false });
    assert.equal(disabledSb.ok, true);
    assert.equal(disabledSb.skill.enabled, false);
    assert.equal(disabledSb.skill.alwaysOn, false);
    assert.equal(fx.getCfg().skillsState['second-brain'].enabled, false);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('Non-destructive mode auto-pause isolates cloudOnly and vaultOnly without mutating global toggles', () => {
  const fx = makeFixtureEnv();
  try {
    fx.engine.toggleSkill({ id: 'caveman', enabled: true, alwaysOn: true });
    const beforeState = JSON.stringify(fx.getCfg().skillsState);

    // Private mode: cloudOnly paused, save & wiki-ingest paused, read-only wiki-query allowed!
    const priv = fx.engine.listSkills({ mode: 'private', ephemeral: false });
    assert.equal(priv.items.find((i) => i.id === 'google-workspace').pausedInMode, true);
    assert.equal(priv.items.find((i) => i.id === 'autoresearch').pausedInMode, true);
    assert.equal(priv.items.find((i) => i.id === 'save').pausedInMode, true);
    assert.equal(priv.items.find((i) => i.id === 'wiki-ingest').pausedInMode, true);
    assert.equal(priv.items.find((i) => i.id === 'wiki-query').pausedInMode, false);

    // Ephemeral / NSFW / Tor: all vaultOnly & cloudOnly paused
    for (const ctx of [
      { mode: 'chat', ephemeral: true },
      { mode: 'nsfw', ephemeral: false },
      { mode: 'tor', ephemeral: false },
    ]) {
      const listed = fx.engine.listSkills(ctx);
      assert.equal(listed.items.find((i) => i.id === 'wiki-query').pausedInMode, true);
      assert.equal(listed.items.find((i) => i.id === 'google-workspace').pausedInMode, true);
      assert.equal(listed.items.find((i) => i.id === 'caveman').pausedInMode, false);
      assert.equal(listed.items.find((i) => i.id === 'caveman').alwaysOn, true);
    }

    // Global config state must be 100% untouched
    assert.equal(JSON.stringify(fx.getCfg().skillsState), beforeState);

    // buildPromptContext skips paused explicit skills in private/ephemeral mode
    const privPrompt = fx.engine.buildPromptContext({
      mode: 'private',
      ephemeral: false,
      explicitSkills: ['google-workspace', 'save', 'wiki-query'],
      userText: 'найди в вики',
      isCloud: false,
    });
    assert.ok(privPrompt.pausedSkillIds.includes('google-workspace'));
    assert.ok(privPrompt.pausedSkillIds.includes('save'));
    assert.ok(!privPrompt.activeSkillIds.includes('google-workspace'));
    assert.ok(!privPrompt.activeSkillIds.includes('save'));
    assert.ok(privPrompt.activeSkillIds.includes('wiki-query'));
    assert.ok(!privPrompt.indexText.includes('/google-workspace'));
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('buildPromptContext loads keyword-matched sub-skills for Smart Packs and respects char caps', () => {
  const fx = makeFixtureEnv();
  try {
    const ctxUi = fx.engine.buildPromptContext({
      mode: 'chat',
      explicitSkills: ['impeccable-ui'],
      userText: 'сделай полировку интерфейса и отступы',
      isCloud: false,
    });
    assert.ok(ctxUi.explicitText.includes('polish'));
    assert.ok(ctxUi.explicitText.length <= 5500);

    const ctxMkt = fx.engine.buildPromptContext({
      mode: 'agent',
      explicitSkills: ['marketingskills'],
      userText: 'проведи seo аудит сайта',
      isCloud: true,
    });
    assert.ok(ctxMkt.explicitText.includes('seo-audit'));
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('createSkill and 2-step installSkill validate inputs and persist UTF-8 SKILL.md', () => {
  const fx = makeFixtureEnv();
  try {
    const bad = fx.engine.createSkill({ name: 'x', slug: 'bad slug!', body: 'hi' });
    assert.equal(bad.ok, false);

    const created = fx.engine.createSkill({
      name: 'Release Guard',
      slug: 'release-guard',
      category: 'docs',
      description: 'Проверка релизов перед выкладкой',
      body: '1. Проверь тесты.\n2. Проверь git diff.',
      alwaysOn: true,
    });
    assert.equal(created.ok, true);
    assert.equal(created.skill.id, 'release-guard');
    assert.equal(created.skill.category, 'docs');
    assert.equal(created.skill.alwaysOn, true);
    assert.ok(fs.existsSync(created.path));

    // 2-step installSkill from markdown
    const md = '---\nname: prompt-audit\ndescription: Проверка промптов на утечки\n---\n# Prompt Audit\nCheck barriers.\n';
    const preview = fx.engine.installSkill({ markdown: md, category: 'system', confirm: false });
    assert.equal(preview.ok, false);
    assert.equal(preview.confirmRequired, true);
    assert.equal(preview.preview.slug, 'prompt-audit');
    assert.ok(preview.preview.tokens > 0);
    assert.ok(!fx.engine.listSkills().items.some((i) => i.id === 'prompt-audit'));

    const confirmed = fx.engine.installSkill({ markdown: md, category: 'system', confirm: true });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.skill.id, 'prompt-audit');
    assert.ok(fs.existsSync(confirmed.path));
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('All 66 BUILTIN_COMMANDS have semantic categories and SlashCommandEngine delegates skills to SkillsEngine', async () => {
  assert.equal(BUILTIN_COMMANDS.length, 66);
  assert.equal(COMMAND_CATEGORIES.length, 5);
  for (const cmd of BUILTIN_COMMANDS) {
    assert.ok(cmd.category, `Missing category on ${cmd.id}`);
    assert.ok(cmd.categoryTitle, `Missing categoryTitle on ${cmd.id}`);
  }

  const fx = makeFixtureEnv();
  try {
    const slash = new SlashCommandEngine({ skillsEngine: fx.engine });
    const list = slash.listCommands({ mode: 'private', ephemeral: false });
    assert.equal(list.sections[0].categories.length, 5);
    assert.ok(list.sections[1].categories.length >= 4);
    assert.ok(list.sections[1].budget);
    assert.deepEqual(list.sections[1].quickToggles, QUICK_TOGGLES);

    const gw = list.sections[1].items.find((i) => i.id === 'google-workspace');
    assert.equal(gw.pausedInMode, true);
    assert.equal(gw.pauseReason, 'Пауза в изолированном режиме');

    // Running paused vault write skill in private mode is blocked
    const blocked = await slash.run({ text: '/wiki-ingest тест', mode: 'private' });
    assert.equal(blocked.handled, true);
    assert.ok(blocked.error);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('PhoneBridge exposes /ping skillsEngine, /skills endpoints, generic [SKILL:slug] tags, and prompt injection', async () => {
  const fx = makeFixtureEnv();
  const slash = new SlashCommandEngine({ skillsEngine: fx.engine });
  let lastChatCall = null;
  const bridge = new PhoneBridge({
    token: () => 'tok',
    persona: () => 'Персона.',
    skillsEngine: fx.engine,
    slashEngine: slash,
    chat: async (messages, _sig, opts) => {
      lastChatCall = { messages, opts };
      return { text: 'Ок.', brain: 'e4b' };
    },
  });
  const port = await bridge.start(0, '127.0.0.1');
  const get = (u) => fetch(`http://127.0.0.1:${port}${u}`, { headers: { 'x-capri-token': 'tok' } });
  const post = (u, b) => fetch(`http://127.0.0.1:${port}${u}`, {
    method: 'POST',
    headers: { 'x-capri-token': 'tok' },
    body: JSON.stringify(b),
  });

  try {
    const ping = await (await get('/ping')).json();
    assert.equal(ping.skillsEngine, true);

    const skillsRes = await (await get('/skills?mode=private&ephemeral=0')).json();
    assert.equal(skillsRes.categories.length, 5);
    assert.equal(skillsRes.items.find((i) => i.id === 'save').pausedInMode, true);

    const toggled = await (await post('/skills/toggle', { id: 'caveman', enabled: true, alwaysOn: true })).json();
    assert.equal(toggled.ok, true);
    assert.equal(toggled.skill.alwaysOn, true);

    const created = await (await post('/skills/create', {
      name: 'Mobile Helper',
      slug: 'mobile-helper',
      category: 'style',
      description: 'Short mobile rule',
      body: 'Reply in 2 bullets.',
    })).json();
    assert.equal(created.ok, true);
    assert.equal(created.skill.id, 'mobile-helper');

    const instPreview = await (await post('/skills/install', {
      markdown: '---\nname: api-check\ndescription: API checker\n---\nCheck status codes.\n',
      confirm: false,
    })).json();
    assert.equal(instPreview.confirmRequired, true);

    const instOk = await (await post('/skills/install', {
      markdown: '---\nname: api-check\ndescription: API checker\n---\nCheck status codes.\n',
      confirm: true,
    })).json();
    assert.equal(instOk.ok, true);
    assert.equal(instOk.skill.id, 'api-check');

    const reloaded = await (await post('/skills/reload', {})).json();
    assert.ok(reloaded.items.some((i) => i.id === 'api-check'));

    // parsePromptFlags handles [SKILL:second-brain] & generic [SKILL:<slug>]
    const parsed = parsePromptFlags('[SKILL:second-brain] [SKILL:impeccable-ui] отполируй экран', { mode: 'chat' });
    assert.deepEqual(parsed.skills, ['second-brain', 'impeccable-ui']);
    assert.equal(parsed.text, 'отполируй экран');

    // /chat injects active alwaysOn + matched pack sub-skill into system & contextParts.skillsText
    await (await post('/chat', {
      text: '[SKILL:impeccable-ui] сделай полировку интерфейса',
      mode: 'chat',
    })).json();
    assert.ok(lastChatCall.opts.contextParts.skillsText.includes('Навык caveman (активен постоянно)'));
    assert.ok(lastChatCall.opts.contextParts.skillsText.includes('polish'));
  } finally {
    await bridge.stop();
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('AgentSessions, preload.js, and main.js wire skillsEngine and IPC contracts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-agent-skills-'));
  const file = path.join(dir, 'sessions.json');
  const fx = makeFixtureEnv();
  let seenMeta = null;
  try {
    const hub = new AgentSessions(file, async (_agent, _model, _messages, _sig, _delta, meta) => {
      seenMeta = meta;
      return 'ok';
    }, () => {}, { skillsEngine: fx.engine });
    const id = hub.create('codex');
    await hub.send(id, 'gpt-6.2-sol', '[SKILL:second-brain] проверь план', false, false, true);
    assert.ok(seenMeta.skills.includes('second-brain'));
    assert.equal(seenMeta.skillsEngine, fx.engine);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fx.base, { recursive: true, force: true });
  }

  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  for (const key of ['skillsList', 'skillsToggle', 'skillsCreate', 'skillsInstall', 'skillsReload']) {
    assert.ok(preloadSrc.includes(`${key}:`), `preload.js missing ${key}`);
  }
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  for (const ch of ['skills:list', 'skills:toggle', 'skills:create', 'skills:install', 'skills:reload']) {
    assert.ok(mainSrc.includes(`'${ch}'`), `main.js missing IPC ${ch}`);
  }
});

test('Real PC roots smoke check: Antigravity skills, Capri_Tools smart packs, exclusions & Stage-2.5 memos', () => {
  const antigravityDir = path.join(os.homedir(), '.gemini', 'config', 'skills');
  if (!fs.existsSync(antigravityDir)) return;
  const engine = new SkillsEngine();
  const listed = engine.listSkills({ mode: 'chat', ephemeral: false });
  const ids = new Set(listed.items.map((i) => i.id));
  assert.ok(!ids.has('blender-model-qa'));
  assert.ok(!ids.has('lowpoly-character-pro'));
  assert.ok(!ids.has('deep-research'));
  assert.ok(ids.has('research-method'));
  assert.ok(ids.has('second-brain'));
  assert.ok(ids.has('caveman'));
  assert.ok(ids.has('i-have-adhd'));
  if (fs.existsSync('C:\\Capri_Tools\\impeccable-ui')) {
    const imp = listed.items.find((i) => i.id === 'impeccable-ui');
    assert.equal(imp.isPack, true);
    assert.ok(imp.subCount > 10, `Expected impeccable-ui subCount > 10, got ${imp.subCount}`);
  }
  if (fs.existsSync('C:\\Capri_Tools\\marketingskills')) {
    const mkt = listed.items.find((i) => i.id === 'marketingskills');
    assert.equal(mkt.isPack, true);
    assert.ok(mkt.subCount >= 50);
  }
  if (fs.existsSync('C:\\Capri_Tools\\game-studios-reference')) {
    const game = listed.items.find((i) => i.id === 'game-studios-reference');
    assert.equal(game.isPack, true);
    assert.ok(game.subCount >= 70);
  }
});
