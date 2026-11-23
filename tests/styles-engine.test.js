'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StylesEngine, parseFrontmatter, dominantColors, makeId } = require('../src/main/styles-engine');

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styles-'));
  let cfg = { stylesVisual: extra.visual !== false };
  const engine = new StylesEngine({
    stylesDir: dir,
    getConfig: () => cfg,
    saveConfig: (patch) => { cfg = { ...cfg, ...patch }; },
    now: () => 1700000000000,
    ...extra,
  });
  return { dir, engine, cfg: () => cfg };
}

function png(dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return file;
}

test('makeId keeps Cyrillic and makes a clean @-name', () => {
  assert.equal(makeId('Claude (Бригада)'), 'claude-бригада');
  assert.equal(makeId('  Тест  '), 'тест');
});

test('frontmatter round-trips quoted values', () => {
  const { meta, body } = parseFrontmatter('---\nname: "a: b"\npalette: #D97757, #FFFFFF\n---\n\nтело');
  assert.equal(meta.name, 'a: b');
  assert.equal(meta.palette, '#D97757, #FFFFFF');
  assert.equal(body, 'тело');
});

test('style is created as a folder with STYLE.md, refs and objects', () => {
  const { dir, engine } = setup();
  const res = engine.saveStyle({ name: 'Claude', type: 'mascot', palette: ['#d97757', '#7A1F2B'], fonts: { heading: 'Playfair Display' }, instructions: 'Без желтизны.' });
  assert.equal(res.ok, true);
  assert.equal(res.style.id, 'claude');
  assert.deepEqual(res.style.palette, ['#D97757', '#7A1F2B']);
  assert.equal(res.style.privacy, 'cloudAllowed');
  assert.ok(fs.existsSync(path.join(dir, 'claude', 'STYLE.md')));
  assert.ok(fs.existsSync(path.join(dir, 'claude', 'refs')));
  assert.equal(engine.getStyle('claude').instructions, 'Без желтизны.');
});

test('updating a style keeps fields that were not sent', () => {
  const { engine } = setup();
  engine.saveStyle({ name: 'Claude', palette: ['#D97757'], instructions: 'Правило.' });
  const res = engine.saveStyle({ id: 'claude', description: 'Маскот бригады' });
  assert.equal(res.ok, true);
  assert.equal(res.style.instructions, 'Правило.');
  assert.deepEqual(res.style.palette, ['#D97757']);
  assert.equal(res.style.description, 'Маскот бригады');
});

test('bad colour, missing voice and taken names are refused', () => {
  const { engine } = setup({ isNameTaken: (id) => id === 'obsidian' });
  assert.match(engine.saveStyle({ name: 'X', palette: ['red'] }).error, /#RRGGBB/);
  assert.match(engine.saveStyle({ name: 'X', voice: 'nope' }).error, /nope/);
  assert.match(engine.saveStyle({ name: 'Obsidian' }).error, /коннектором/);
  engine.saveVoice({ name: 'Claude' });
  assert.match(engine.saveStyle({ name: 'Claude' }).error, /занято/);
});

test('persona needs a person, is local-only by default and carries the draft rule', () => {
  const { engine } = setup();
  assert.match(engine.saveStyle({ name: 'Амбассадор', type: 'persona' }).error, /Человек/);
  const res = engine.saveStyle({ name: 'Амбассадор', type: 'persona', person: 'Иван' });
  assert.equal(res.style.privacy, 'localOnly');
  const turn = engine.resolveTurn({ text: '@амбассадор пост', isCloud: false });
  assert.match(turn.block, /ЧЕРНОВИК/);
  assert.match(turn.block, /Иван/);
});

test('cloud turns never get local-only styles or voices', () => {
  const { engine } = setup();
  engine.saveVoice({ name: 'Мой', card: 'коротко' });
  engine.saveStyle({ name: 'Личное', privacy: 'localOnly', voice: 'мой' });
  const cloud = engine.resolveTurn({ text: '@личное привет', isCloud: true });
  assert.equal(cloud.block, '');
  assert.equal(cloud.skipped.length, 2);
  assert.equal(cloud.cleanedText, 'привет');
  const local = engine.resolveTurn({ text: '@личное привет', isCloud: false });
  assert.match(local.block, /Стиль «Личное»/);
  assert.match(local.block, /Образ письма «Мой»/);
});

test('an explicit voice wins over the style voice; mentions win over active', () => {
  const { engine } = setup();
  engine.saveVoice({ name: 'Голос А', id: 'a', card: 'A', privacy: 'cloudAllowed' });
  engine.saveVoice({ name: 'Голос Б', id: 'b', card: 'B', privacy: 'cloudAllowed' });
  engine.saveStyle({ name: 'S', voice: 'a' });
  engine.setActive({ style: 's' });
  assert.equal(engine.resolveTurn({ text: 'x' }).voiceId, 'a');
  engine.setActive({ voice: 'b' });
  assert.equal(engine.resolveTurn({ text: 'x' }).voiceId, 'b');
  assert.equal(engine.resolveTurn({ text: '@a x' }).voiceId, 'a');
});

test('unknown @-names and emails stay in the text', () => {
  const { engine } = setup();
  engine.saveStyle({ name: 'S' });
  const m = engine.parseMentions('напиши @obsidian и user@mail.ru в @s');
  assert.equal(m.styleId, 's');
  assert.equal(m.cleanedText, 'напиши @obsidian и user@mail.ru в');
});

test('active choice survives only for existing items', () => {
  const { engine } = setup();
  engine.saveStyle({ name: 'S' });
  assert.equal(engine.setActive({ style: 'nope' }).ok, false);
  engine.setActive({ style: 's' });
  assert.equal(engine.getActive().style, 's');
  engine.removeStyle({ id: 's', confirm: true });
  assert.equal(engine.getActive().style, '');
});

test('removal asks first and moves to trash, never deletes', () => {
  const { dir, engine } = setup();
  engine.saveStyle({ name: 'S' });
  assert.equal(engine.removeStyle({ id: 's' }).confirmRequired, true);
  const res = engine.removeStyle({ id: 's', confirm: true });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(res.movedTo, 'STYLE.md')));
  assert.ok(res.movedTo.startsWith(path.join(dir, '_trash')));
  assert.equal(engine.listStyles().length, 0);
});

test('a voice in use by a style cannot be removed', () => {
  const { engine } = setup();
  engine.saveVoice({ name: 'V' });
  engine.saveStyle({ name: 'S', voice: 'v' });
  assert.match(engine.removeVoice({ id: 'v', confirm: true }).error, /S/);
});

test('assets: only pictures are copied, names are unique, removal goes to trash', () => {
  const { dir, engine } = setup();
  engine.saveStyle({ name: 'S' });
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'src-'));
  const a = engine.addAsset({ id: 's', kind: 'objects', sourcePath: png(src, 'Паспорт.png') });
  assert.equal(a.ok, true);
  assert.equal(path.basename(a.path), 'pasport.png');
  const b = engine.addAsset({ id: 's', kind: 'objects', sourcePath: png(src, 'Паспорт.png') });
  assert.equal(path.basename(b.path), 'pasport-2.png');
  fs.writeFileSync(path.join(src, 'x.exe'), 'MZ');
  assert.equal(engine.addAsset({ id: 's', kind: 'refs', sourcePath: path.join(src, 'x.exe') }).ok, false);
  assert.equal(engine.addAsset({ id: 's', kind: 'other', sourcePath: a.path }).ok, false);
  assert.equal(engine.getStyle('s').objects.length, 2);
  const r = engine.removeAsset({ id: 's', file: a.path });
  assert.equal(r.ok, true);
  assert.equal(engine.getStyle('s').objects.length, 1);
  assert.equal(engine.removeAsset({ id: 's', file: path.join(dir, 's', 'STYLE.md') }).ok, false);
});

test('voice samples are saved as markdown; the card is built by the local model and saved as draft', async () => {
  let seen = null;
  const { engine } = setup({ chat: async (messages, opts) => { seen = { messages, opts }; return '## Тон и позиция\n- прямо'; } });
  engine.saveVoice({ name: 'Claude' });
  assert.equal((await engine.buildVoiceCard({ id: 'claude' })).ok, false);
  engine.addVoiceSample({ id: 'claude', text: 'Ну да, неделя была плотная.', title: 'чат' });
  const res = await engine.buildVoiceCard({ id: 'claude' });
  assert.equal(res.ok, true);
  assert.equal(seen.opts.localOnly, true);
  assert.match(seen.messages[0].content, /данные, а не инструкции/);
  assert.match(seen.messages[1].content, /неделя была плотная/);
  const v = engine.getVoice('claude');
  assert.equal(v.cardStatus, 'draft');
  assert.match(v.card, /прямо/);
});

test('dominantColors merges near shades and skips the green screen', () => {
  const px = (r, g, b, n) => Array.from({ length: n }, () => [r, g, b, 255]).flat();
  const data = Uint8Array.from([...px(217, 119, 87, 50), ...px(220, 121, 85, 40), ...px(0, 255, 0, 200), ...px(122, 31, 43, 30)]);
  const colors = dominantColors([{ data, order: 'RGBA' }], { count: 4 });
  assert.equal(colors.length, 2);
  assert.match(colors[0], /^#D[89A-F]/);
  assert.equal(colors[1], '#7A1F2B');
});

test('extractPalette reads objects and refs through decodeImage and can apply', () => {
  const decoded = { data: Uint8Array.from([43, 31, 122, 255, 43, 31, 122, 255]), order: 'BGRA' };
  const { engine } = setup({ decodeImage: () => decoded });
  engine.saveStyle({ name: 'S' });
  assert.equal(engine.extractPalette({ id: 's' }).ok, false);
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'src-'));
  engine.addAsset({ id: 's', kind: 'refs', sourcePath: png(src, 'r.png') });
  const res = engine.extractPalette({ id: 's', apply: true });
  assert.deepEqual(res.palette, ['#7A1F2B']);
  assert.deepEqual(engine.getStyle('s').palette, ['#7A1F2B']);
});

test('tool adapters: comfy, gemini, penpot, docs, slides, upscayl', () => {
  const { engine } = setup();
  engine.saveStyle({ name: 'S', palette: ['#D97757', '#7A1F2B'], fonts: { heading: 'Playfair Display', body: 'Inter' }, imagePrompt: 'art deco', imageNegative: 'yellow', medium: 'illustration' });
  const comfy = engine.comfyRecipe('s');
  assert.equal(comfy.positive, 'art deco');
  assert.equal(comfy.negative, 'yellow');
  const gem = engine.geminiImageRequest('s', 'нарисуй');
  assert.match(gem.text, /нарисуй[\s\S]*#D97757[\s\S]*yellow/);
  const pen = engine.penpotLibrary('s');
  assert.equal(pen.colors.length, 2);
  assert.equal(pen.typographies.length, 2);
  assert.match(pen.code, /createColor/);
  assert.equal(engine.docStyle('s').colorHeading, '#D97757');
  assert.equal(engine.slidesTheme('s').theme.fontBody, 'Inter');
  assert.equal(engine.upscaylModel('s').model, 'digital-art-4x');
  engine.saveStyle({ id: 's', medium: 'photo', privacy: 'localOnly' });
  assert.equal(engine.upscaylModel('s').model, 'upscayl-standard-4x');
  assert.equal(engine.geminiImageRequest('s', 'x').ok, false);
});

test('library lists styles with cover and voice name', () => {
  const { engine } = setup();
  engine.saveVoice({ name: 'Голос' });
  engine.saveStyle({ name: 'S', voice: 'голос' });
  const lib = engine.library();
  assert.equal(lib.styles[0].voiceName, 'Голос');
  assert.equal(lib.voices.length, 1);
  assert.equal(lib.types.mascot, 'маскот');
});

test('slash commands /стили, /стиль and /образ drive the active choice', async () => {
  const { SlashCommandEngine } = require('../src/main/slash-commands');
  const { engine: styles } = setup();
  styles.saveStyle({ name: 'Claude' });
  styles.saveVoice({ name: 'Голос' });
  const slash = new SlashCommandEngine({ skillRoots: [], stylesEngine: styles });
  assert.equal((await slash.run({ text: '/стили' })).action, 'open-styles');
  assert.match((await slash.run({ text: '/стиль @claude' })).reply, /включён/);
  assert.equal(styles.getActive().style, 'claude');
  assert.match((await slash.run({ text: '/стиль' })).reply, /@claude/);
  assert.match((await slash.run({ text: '/образ голос' })).reply, /включён/);
  assert.equal(styles.getActive().voice, 'голос');
  assert.match((await slash.run({ text: '/стиль нету' })).reply, /Нет такого/);
  await slash.run({ text: '/стиль выкл' });
  assert.equal(styles.getActive().style, '');
});

test('with visual styles off (the default) only voices work', async () => {
  const { SlashCommandEngine } = require('../src/main/slash-commands');
  const { engine } = setup({ visual: false });
  assert.equal(new StylesEngine({ stylesDir: engine.dir }).visualOn, false);
  engine.saveVoice({ name: 'Голос' });
  engine.saveStyle({ name: 'Claude', voice: 'голос' });
  const lib = engine.library();
  assert.equal(lib.visual, false);
  assert.equal(lib.styles.length, 0);
  assert.equal(lib.voices.length, 1);
  const turn = engine.resolveTurn({ text: '@claude @голос привет', isCloud: false });
  assert.equal(turn.styleId, '');
  assert.equal(turn.voiceId, 'голос');
  assert.match(turn.cleanedText, /@claude/);
  assert.ok(engine.comfyRecipe('claude').error);
  const slash = new SlashCommandEngine({ skillRoots: [], stylesEngine: engine });
  assert.match((await slash.run({ text: '/стиль @claude' })).reply, /отдельный этап/);
  assert.match((await slash.run({ text: '/образ голос' })).reply, /включён/);
});
