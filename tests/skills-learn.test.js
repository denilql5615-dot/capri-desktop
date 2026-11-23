'use strict';

// 2.7b: /learn makes own skills, own skills are picked by description, stacked skills share one budget,
// and a skill carries its attached files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SkillsEngine, parseLearned, latinSlug, MAX_LOCAL_SKILL_CHARS } = require('../src/main/skills-engine');
const { SlashCommandEngine } = require('../src/main/slash-commands');

function setup(initial = {}) {
  let cfg = { ...initial };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-learn-'));
  const builtinRoot = path.join(base, 'builtin');
  fs.mkdirSync(builtinRoot, { recursive: true });
  const engine = new SkillsEngine({
    userDataDir: base,
    skillRoots: [builtinRoot],
    packDefs: [],
    includeBuiltInMemos: false,
    getConfig: () => cfg,
    saveConfig: (patch) => { cfg = { ...cfg, ...patch }; },
  });
  return { base, builtinRoot, engine };
}

function ownSkill(engine, { slug, name, description, body = 'Делай так.', source = '' }) {
  const res = engine.createSkill({ name, slug, description, body, source });
  assert.equal(res.ok, true, res.error);
  return res;
}

const RECIPE = JSON.stringify({
  name: 'Сверка выписки',
  slug: 'bank-reconcile',
  description: 'Сверяет банковскую выписку с таблицей расходов и находит расхождения.',
  when: ['есть выписка CSV и таблица расходов'],
  steps: ['Привести даты к одному формату', 'Сопоставить суммы', 'Вывести расхождения таблицей'],
  pitfalls: ['Выписка в cp1251 — сначала перекодировать'],
  check: ['Сумма расхождений сходится с разницей итогов'],
});

const HISTORY = [
  { role: 'user', content: 'Сверь выписку с таблицей' },
  { role: 'assistant', content: 'Перекодировала cp1251, сопоставила суммы, вот три расхождения.' },
  { role: 'user', content: 'Отлично, всё сошлось' },
];

test('parseLearned reads JSON wrapped in prose and refuses a recipe without steps', () => {
  const r = parseLearned(`Вот навык:\n\`\`\`json\n${RECIPE}\n\`\`\``);
  assert.equal(r.name, 'Сверка выписки');
  assert.equal(r.slug, 'bank-reconcile');
  assert.equal(r.steps.length, 3);
  assert.equal(parseLearned('{"name":"x","steps":[]}'), null);
  assert.equal(parseLearned('нет json'), null);
  assert.equal(latinSlug('Сверка выписки'), 'sverka-vypiski');
});

test('/learn turns the chat into an own skill through the local model and never overwrites', async () => {
  const { engine } = setup();
  ownSkill(engine, { slug: 'bank-reconcile', name: 'bank-reconcile', description: 'старый' });
  let sent = null;
  const res = await engine.learnFromHistory({ history: HISTORY, hint: 'сверку', chat: async (m) => { sent = m; return RECIPE; } });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.id, 'bank-reconcile-2');
  assert.match(sent[1].content, /Что именно закрепить: сверку/);
  assert.match(sent[1].content, /Пользователь: Сверь выписку/);
  const md = fs.readFileSync(res.path, 'utf8');
  assert.match(md, /source: "learned"/);
  assert.match(md, /## Шаги\n1\. Привести даты/);
  assert.match(md, /## Подводные камни\n- Выписка в cp1251/);
  const item = engine.listSkills().items.find((i) => i.id === 'bank-reconcile-2');
  assert.equal(item.learned, true);
  assert.equal(item.stageNote, 'Выучен');
  assert.equal(item.name, 'Сверка выписки');
});

test('/learn refuses isolated modes, an empty chat and a broken model reply', async () => {
  const { engine } = setup();
  const chat = async () => RECIPE;
  for (const opts of [{ mode: 'tor' }, { mode: 'private' }, { ephemeral: true }]) {
    const res = await engine.learnFromHistory({ history: HISTORY, chat, ...opts });
    assert.equal(res.ok, false);
    assert.match(res.error, /изолированном/);
  }
  assert.match((await engine.learnFromHistory({ history: [], chat })).error, /пуст/);
  assert.match((await engine.learnFromHistory({ history: HISTORY, chat: async () => 'не знаю' })).error, /не собрала/);
  assert.equal(engine.listSkills().items.length, 0);
});

test('a custom skill with a Cyrillic name keeps its folder id', () => {
  const { engine } = setup();
  ownSkill(engine, { slug: 'my-report', name: 'Мой отчёт', description: 'Еженедельный отчёт' });
  assert.ok(engine.listSkills().items.find((i) => i.id === 'my-report'));
});

test('own skills are picked by description; built-in ones and unrelated requests are not', () => {
  const { engine, builtinRoot } = setup();
  ownSkill(engine, { slug: 'bank-reconcile', name: 'Сверка выписки', description: 'Сверяет банковскую выписку с таблицей расходов', body: 'РЕЦЕПТ-СВЕРКИ' });
  fs.mkdirSync(path.join(builtinRoot, 'expenses'), { recursive: true });
  fs.writeFileSync(path.join(builtinRoot, 'expenses', 'SKILL.md'), '---\nname: expenses\ndescription: Таблица расходов и банковская выписка\n---\nВСТРОЕННЫЙ', 'utf8');
  engine.reload();

  const hit = engine.buildPromptContext({ userText: 'сверь мою банковскую выписку с расходами' });
  assert.deepEqual(hit.autoSkillIds, ['bank-reconcile']);
  assert.match(hit.text, /Подобранные навыки[\s\S]*РЕЦЕПТ-СВЕРКИ/);
  assert.doesNotMatch(hit.text, /ВСТРОЕННЫЙ/);

  assert.deepEqual(engine.buildPromptContext({ userText: 'какая погода завтра в городе' }).autoSkillIds, []);
  // A skill called by hand switches the auto-pick off for that turn.
  assert.deepEqual(engine.buildPromptContext({ userText: 'сверь банковскую выписку', explicitSkills: ['expenses'] }).autoSkillIds, []);
  // A disabled skill and the config switch both stop it.
  engine.toggleSkill({ id: 'bank-reconcile', enabled: false });
  assert.deepEqual(engine.buildPromptContext({ userText: 'сверь банковскую выписку с расходами' }).autoSkillIds, []);
  const off = setup({ skillsAutoPick: false });
  ownSkill(off.engine, { slug: 'bank-reconcile', name: 'Сверка выписки', description: 'Сверяет банковскую выписку с таблицей расходов' });
  assert.deepEqual(off.engine.buildPromptContext({ userText: 'сверь банковскую выписку с расходами' }).autoSkillIds, []);
});

test('stacked skills share one budget and say which one wins', () => {
  const { engine } = setup();
  const big = 'x'.repeat(MAX_LOCAL_SKILL_CHARS);
  for (const slug of ['alpha', 'beta', 'gamma']) ownSkill(engine, { slug, name: slug, description: slug, body: big });
  const one = engine.buildPromptContext({ explicitSkills: ['alpha'] });
  const three = engine.buildPromptContext({ explicitSkills: ['alpha', 'beta', 'gamma'] });
  assert.ok(three.explicitText.length < one.explicitText.length * 1.3, `${three.explicitText.length} vs ${one.explicitText.length}`);
  assert.match(three.explicitText, /главнее тот, что вызван раньше/);
  assert.doesNotMatch(one.explicitText, /главнее/);
  assert.deepEqual(three.activeSkillIds.sort(), ['alpha', 'beta', 'gamma']);
});

test('attached files: only text, copied into references, then go into the prompt with the skill', () => {
  const { engine, base, builtinRoot } = setup();
  ownSkill(engine, { slug: 'brand', name: 'brand', description: 'тон бренда', body: 'Пиши по гайду.' });
  const src = path.join(base, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'guide.md'), 'ГАЙД-БРЕНДА', 'utf8');
  fs.writeFileSync(path.join(src, 'logo.png'), Buffer.from([1, 2, 3]));
  const res = engine.attachFiles({ id: 'brand', paths: [path.join(src, 'guide.md'), path.join(src, 'logo.png')] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.added, ['guide.md']);
  assert.match(res.skipped[0], /logo\.png/);
  const again = engine.attachFiles({ id: 'brand', paths: [path.join(src, 'guide.md')] });
  assert.deepEqual(again.added, ['guide-2.md']);

  const ctx = engine.buildPromptContext({ explicitSkills: ['brand'] });
  assert.match(ctx.explicitText, /Файлы навыка \/brand \(2\):\n--- references\/guide-2\.md ---\nГАЙД-БРЕНДА/);
  assert.equal(engine.listSkills().items.find((i) => i.id === 'brand').stageNote, 'Свой · файлов: 2');

  fs.mkdirSync(path.join(builtinRoot, 'core'), { recursive: true });
  fs.writeFileSync(path.join(builtinRoot, 'core', 'SKILL.md'), '---\nname: core\ndescription: d\n---\nb', 'utf8');
  engine.reload();
  assert.match(engine.attachFiles({ id: 'core', paths: [path.join(src, 'guide.md')] }).error, /встроенный/);
});

test('slash /learn and /навык-файлы go through their deps and refuse isolated chats', async () => {
  const { engine } = setup();
  const calls = [];
  const slash = new SlashCommandEngine({
    skillRoots: [],
    skillsEngine: engine,
    deps: {
      learnSkill: async (o) => { calls.push(o); return engine.learnFromHistory({ ...o, history: HISTORY, chat: async () => RECIPE }); },
      attachSkillFiles: async ({ id }) => ({ ok: true, added: ['a.md'], skipped: [], files: [{}], id }),
    },
  });
  const learned = await slash.run({ text: '/learn сверку выписки' });
  assert.equal(learned.action, 'skills-changed');
  assert.match(learned.reply, /Выучила навык \/bank-reconcile/);
  assert.equal(calls[0].hint, 'сверку выписки');
  assert.match((await slash.run({ text: '/learn', mode: 'tor' })).reply, /изолированном/);
  assert.match((await slash.run({ text: '/навык-файлы /bank-reconcile' })).reply, /К \/bank-reconcile приложено: a\.md/);
  assert.match((await slash.run({ text: '/навык-файлы' })).reply, /Укажи навык/);
});
