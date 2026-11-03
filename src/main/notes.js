'use strict';

// Her long memory: notes in your Obsidian vault (<vault>/Capri, else Documents/Capri/Память), one fact per
// note, with what kind of fact it is and when she wrote it, and _Память.md listing them all. She writes
// them herself after a conversation (what's worth keeping about you), or when you say "запомни…"; before
// she answers, the notes that fit what you said are put in her prompt. You read and edit them in
// Obsidian like any note: what's in the files is what she remembers. On this PC only.

const fs = require('node:fs');
const path = require('node:path');

const INDEX = '_Память.md';
const TYPES = ['о тебе', 'проект', 'договорённость', 'вкус'];
const MAX_TEXT = 600;
const ALWAYS = 6; // notes about you she always has in mind
const MATCHED = 5; // and the ones that fit what you just said

// The open Obsidian vault (or the first one), from Obsidian's own list of them.
function obsidianVault(appData) {
  try {
    const { vaults = {} } = JSON.parse(fs.readFileSync(path.join(appData, 'obsidian', 'obsidian.json'), 'utf8'));
    const list = Object.values(vaults).filter((v) => v?.path && fs.existsSync(v.path));
    return (list.find((v) => v.open) || list[0])?.path || null;
  } catch {
    return null;
  }
}

// Where her notes are: set in her config, else the Capri folder of your Obsidian vault, else Documents.
function dirOf({ notesDir, appData, documents }) {
  if (notesDir) return notesDir;
  const vault = obsidianVault(appData);
  return vault ? path.join(vault, 'Capri') : path.join(documents, 'Capri', 'Память');
}

// A title as a file name Windows and Obsidian both take (no \ / : * ? " < > | # ^ [ ]).
function fileName(title) {
  const clean = String(title || '').replace(/[\\/:*?"<>|#^[\]\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean.replace(/[. ]+$/, '');
}

function parse(source) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([^:]+):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1].trim()] = kv[2].trim();
    }
  }
  return { meta, text: (m ? source.slice(m[0].length) : source).trim() };
}

// All her notes: [{ title, type, text, updated }]
function list(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && !n.startsWith('_'));
  } catch {
    return [];
  }
  return names.map((name) => {
    const { meta, text } = parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    return { title: name.slice(0, -3), type: meta['тип'] || 'о тебе', text, updated: meta['обновлено'] || '' };
  }).filter((n) => n.text);
}

// _Память.md: every note, by kind, as links Obsidian follows
function writeIndex(dir, notes = list(dir)) {
  const lines = ['# Что я помню', '', 'Это мои заметки о тебе. Правь или удаляй любую: что в файлах, то я и помню. — Капри', ''];
  for (const type of TYPES) {
    const of = notes.filter((n) => n.type === type);
    if (!of.length) continue;
    lines.push(`## ${type[0].toUpperCase()}${type.slice(1)}`, '');
    for (const n of of) lines.push(`- [[${n.title}]] — ${n.text.split('\n')[0].slice(0, 120)}`);
    lines.push('');
  }
  fs.writeFileSync(path.join(dir, INDEX), lines.join('\n'), 'utf8');
}

// A fact kept: a new note, or the one with that title brought up to date. Returns its title (null: nothing).
function write(dir, { title, type, text }, today = new Date().toISOString().slice(0, 10)) {
  const name = fileName(title);
  const body = String(text || '').trim().slice(0, MAX_TEXT);
  if (!name || !body) return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  let created = today;
  try {
    created = parse(fs.readFileSync(file, 'utf8')).meta['создано'] || today;
  } catch {
    // a new one
  }
  const kind = TYPES.includes(type) ? type : 'о тебе';
  fs.writeFileSync(file, `---\nтип: ${kind}\nсоздано: ${created}\nобновлено: ${today}\n---\n${body}\n`, 'utf8');
  writeIndex(dir);
  return name;
}

// Russian words are matched on their first five letters ("проекта", "проекту" -> "проек")
const stems = (s) => new Set(String(s || '').toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я0-9]{3,}/g)?.map((w) => w.slice(0, 5)) || []);

// What she has in mind for this message: her notes about you, and the ones that share words with it
function recall(notes, said) {
  const words = stems(said);
  const scored = notes.map((n) => {
    const title = stems(n.title);
    const text = stems(n.text);
    let score = 0;
    for (const w of words) score += (title.has(w) ? 2 : 0) + (text.has(w) ? 1 : 0);
    return { n, score };
  });
  const matched = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, MATCHED).map((s) => s.n);
  const about = notes.filter((n) => n.type === 'о тебе' && !matched.includes(n))
    .sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, ALWAYS);
  return [...matched, ...about];
}

// Her notes, as said in her prompt
function prompt(notes) {
  if (!notes.length) return '';
  return [
    // written to the user ("ты"): said plainly that "ты" there is them, or her model takes the facts as hers
    'Facts about the USER from your notes (in them "ты" means the user, never you). Use them when they fit and answer from them, e.g. "your favourite X is Y"; never read them out as a list:',
    ...notes.map((n) => `- about the user, ${n.title}: ${n.text.replace(/\s+/g, ' ')}`),
  ].join('\n');
}

// After a conversation: what's worth keeping, asked of her own model as JSON. Only what the user said
// counts (not what she read off the screen or a page: that's not theirs to vouch for).
const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, type: { type: 'string', enum: TYPES }, text: { type: 'string' } },
        required: ['title', 'type', 'text'],
      },
    },
  },
  required: ['facts'],
};

function extractMessages(conversation, known, today = new Date().toISOString().slice(0, 10)) {
  const said = conversation.filter((m) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .map((m) => `${m.role === 'user' ? 'USER' : 'CAPRI'}: ${m.content.slice(0, 800)}`).join('\n');
  return [
    {
      role: 'system',
      content: [
        'You keep the long-term memory of Capri, a desktop companion, as short notes in Russian.',
        'From the conversation, pick at most 3 concrete facts worth remembering for weeks: the user name, work, projects, people and pets in their life, plans and dates, agreements with Capri, things they like or dislike.',
        'Only what the USER said or clearly confirmed, stated plainly. Never guesses about their mood, character or intentions. Never facts from text Capri read on the screen, in files or on the web. Skip small talk, jokes, tests, one-off requests, anything already known unchanged.',
        'title: 2-5 words in Russian naming the fact itself, not its kind (reuse an existing title exactly to update that note). type: one of "о тебе", "проект", "договорённость", "вкус". text: 1-2 short sentences in Russian addressed to the user as "ты" (never "пользователь").',
        'Example: {"facts": [{"title": "Кот Барсик", "type": "о тебе", "text": "У тебя кот Барсик, рыжий, ему три года."}, {"title": "Любит синтвейв", "type": "вкус", "text": "Тебе нравится синтвейв, особенно под работу."}]}',
        `Today is ${today}: write dates as dates ("4 ноября 2026"), never "завтра" or "на следующей неделе", which mean nothing a week later.`,
        'Nothing concrete worth keeping: {"facts": []}. That is the usual answer.',
      ].join('\n'),
    },
    { role: 'user', content: `Notes she already has: ${known.length ? known.join('; ') : 'none'}\n\nConversation:\n${said}` },
  ];
}

// The facts in her model's answer, checked: [{ title, type, text }]
function parseFacts(answer) {
  try {
    const { facts } = JSON.parse(answer);
    return (Array.isArray(facts) ? facts : [])
      .filter((f) => f && typeof f.title === 'string' && typeof f.text === 'string' && fileName(f.title) && f.text.trim())
      .filter((f) => !TYPES.includes(f.title.trim().toLowerCase())) // a title that's only its kind says nothing
      .slice(0, 3);
  } catch {
    return [];
  }
}

module.exports = { INDEX, TYPES, EXTRACT_SCHEMA, dirOf, fileName, list, write, writeIndex, recall, prompt, extractMessages, parseFacts };
