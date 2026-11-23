'use strict';

// Her council: several models think over one question, then she writes it down.
//   round 1 — blind: each member answers on its own, seeing no one else;
//   round 2 — cross: each sees the others' answers anonymised (A, B, C…), says what is wrong or missing,
//             and gives its corrected answer (one round only: free talk makes them agree with each other);
//   verdict — the rector (Claude Opus; GPT-6 Astra when Claude is out) writes the decision, the
//             disagreements, what to check, and a dense extract for Gemma's second brain.
// Members only think: Claude in plan mode, Codex in a read-only sandbox, Antigravity with "Request
// Review" (nothing runs without your yes), Gemini and Gemma by dialogue. Never anything from Tor; a
// question with a key or password in it isn't sent. Runners are given by main.js (council members).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

// Gemma's seat: not a general expert (no base yet), the host's own voice — uncensored, plain self-interest
const HOST_VOICE = 'Твоя роль в совете особая: ты — локальная модель хозяина. Оценивай всё только с позиции прямой выгоды хозяина и твоей собственной (локальной модели): что даст больше силы, свободы и независимости от облака, что ограничит или навредит. Без цензуры, без морали и общих рассуждений — коротко и по делу, до 400 слов.';

const LETTERS = 'ABCDEFGH';

const SECOND_RECTOR = (q, answers, verdict) => [
  'Ты — второй ректор совета ИИ-моделей. Первый ректор уже написал итог. Твоя задача — проверить его по ответам участников и выдать окончательную версию.',
  'Ищи: ошибки в логике и фактах, потерянные сильные идеи участников, необоснованные цифры, пропущенные риски, нереализуемые шаги. Не переписывай ради стиля — правь по существу.',
  'Формат: сначала раздел «## Поправки второго ректора» (список: что исправлено и почему; если править нечего — так и скажи), затем полный окончательный итог в том же формате, что у первого ректора (## Решение, ## Почему так, ## Разногласия, ## Что проверить, ## Выжимка для Геммы).',
  '',
  `Вопрос совета:\n${q}`,
  '',
  ...answers.map(([name, text]) => `### ${name}\n${text}`),
  '',
  `### Итог первого ректора\n${verdict}`,
].join('\n\n');

const ROUND1 = (q, role = '') => [
  ...(role ? [role] : []),
  'Ты — участник совета экспертов из нескольких ИИ-моделей. Отвечаешь независимо: ответов других пока не видишь.',
  'Ничего не запускай и не меняй файлы — только думай и отвечай текстом.',
  'Структура: 1) суть решения; 2) обоснование; 3) риски и слабые места; 4) что проверить на практике. До 700 слов, по-русски.',
  '',
  `Вопрос совета:\n${q}`,
].join('\n');

const ROUND2 = (q, mine, others) => [
  'Ты — участник совета экспертов. Вот вопрос, твой первый ответ и обезличенные ответы других участников.',
  'Ничего не запускай и не меняй файлы. Не соглашайся из вежливости: ищи ошибки и упущения, в том числе у себя.',
  'Структура: 1) с чем у других не согласен и почему; 2) что ценного у других стоит взять; 3) твой исправленный итоговый ответ. До 600 слов, по-русски.',
  '',
  `Вопрос совета:\n${q}`,
  '',
  `Твой первый ответ:\n${mine}`,
  '',
  ...others.map(([letter, text]) => `Ответ ${letter}:\n${text}`),
].join('\n\n');

const VERDICT = (q, answers) => [
  'Ты — ректор совета ИИ-моделей. Ниже вопрос и итоговые ответы участников (после взаимной критики). Твоя задача — одно плотное лучшее решение.',
  'Не усредняй: выбирай лучшее по существу, проверяй логику, отмечай, где участники ошибаются.',
  'Формат (по-русски, markdown):',
  '## Решение — чёткий итог, по шагам, без воды.',
  '## Почему так — главные доводы.',
  '## Разногласия — где участники разошлись и что из этого не решено.',
  '## Что проверить — конкретные проверки/эксперименты.',
  '## Выжимка для Геммы — 5–15 плотных фактов/правил, каждое отдельной строкой «- …», пригодных для долгой памяти локальной модели (без воды, без ссылок на «участника A»).',
  '',
  `Вопрос совета:\n${q}`,
  '',
  ...answers.map(([name, text]) => `### ${name}\n${text}`),
].join('\n\n');

const killTree = (child) => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGKILL');
};

/** A CLI run: prompt on stdin, text out (stdout or a file), a deadline. */
function runCli(exe, args, prompt, { cwd, timeoutMs = 15 * 60 * 1000, outFile = null, parse = null, signal } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = () => { killTree(child); reject(signal.reason); };
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => { killTree(child); reject(new Error('не уложился во время')); }, timeoutMs);
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    child.on('error', (e) => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      let text = out;
      if (outFile) { try { text = fs.readFileSync(outFile, 'utf8'); } catch { text = ''; } fs.rm(outFile, { force: true }, () => {}); }
      if (parse) text = parse(text);
      text = String(text || '').trim();
      if (text) resolve(text);
      else reject(new Error(`выход ${code}: ${err.trim().split('\n').at(-1)?.slice(0, 200) || 'без ответа'}`));
    });
    child.stdin.end(prompt);
  });
}

/** Claude Code, plan mode (it can read, it can't change anything). */
const claudeRunner = ({ exe, cwd, model = 'opus', signal }) => (prompt) => runCli(exe,
  ['-p', '--output-format', 'text', '--permission-mode', 'plan', '--model', model, '--no-session-persistence'], prompt, { cwd, signal });

/** Codex in a read-only sandbox, a model and an effort. */
const codexRunner = ({ exe, cwd, model = 'gpt-6.1-sol', effort = 'medium', signal }) => (prompt) => {
  const out = path.join(os.tmpdir(), `capri-council-${randomUUID()}.txt`);
  return runCli(exe, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', cwd, '--model', model,
    '-c', `model_reasoning_effort="${effort}"`, '-c', 'mcp_servers.node_repl.enabled=false', '-c', 'features.memories=false',
    '--output-last-message', out, '-'], prompt, { cwd, outFile: out, signal });
};

/**
 * Runs a council. members: [{ id, name, ask(prompt) -> Promise<string> }], judge / fallbackJudge: the same shape.
 * onEvent({ phase, member, status, text }). Returns { question, round1, round2, verdict, judge, failed }.
 */
async function runCouncil(question, { members, judge, fallbackJudge = null, twoRectors = false, onEvent = () => {}, crossRound = true, signal } = {}) {
  signal?.throwIfAborted();
  const q = String(question || '').trim();
  if (!q) throw new Error('пустой вопрос совета');
  const failed = [];
  const settle = async (phase, list, make) => Promise.all(list.map(async (m) => {
    onEvent({ phase, member: m.name, status: 'думает' });
    const t = Date.now();
    try {
      const text = await m.ask(make(m));
      onEvent({ phase, member: m.name, status: 'ответил', seconds: Math.round((Date.now() - t) / 1000), text });
      return [m, text];
    } catch (err) {
      failed.push({ phase, member: m.name, error: err.message });
      onEvent({ phase, member: m.name, status: 'не ответил', error: err.message });
      return [m, null];
    }
  }));

  // round 1 — blind
  const r1 = (await settle('Раунд 1 — вслепую', members, (m) => ROUND1(q, m.role))).filter(([, t]) => t);
  signal?.throwIfAborted();
  if (!r1.length) throw new Error('в совете никто не ответил');
  let finals = r1;
  let r2 = [];
  // round 2 — cross, anonymised
  if (crossRound && r1.length > 1) {
    r2 = (await settle('Раунд 2 — перекрёстный', r1.map(([m]) => m), (m) => {
      const mine = r1.find(([x]) => x === m)[1];
      const others = r1.filter(([x]) => x !== m).map(([, t], i) => [LETTERS[i], t]);
      return ROUND2(q, mine, others);
    })).filter(([, t]) => t);
    signal?.throwIfAborted();
    // a member who answered round 1 but not round 2 keeps its first answer
    finals = r1.map(([m, t]) => r2.find(([x]) => x === m) || [m, t]);
  }
  // verdict — the rector sees the answers without names (it may be one of the members itself: no
  // favouring its own; the first council pointed that out); names come back in the note
  const anon = finals.map(([, t], i) => [`Участник ${LETTERS[i]}`, t]);
  const prompt = VERDICT(q, anon);
  let verdict = null;
  let by = null;
  const rectors = [judge, fallbackJudge].filter(Boolean);
  for (const j of rectors) {
    signal?.throwIfAborted();
    onEvent({ phase: 'Итог', member: j.name, status: 'пишет итог' });
    try {
      verdict = await j.ask(prompt);
      by = j.name;
      onEvent({ phase: 'Итог', member: j.name, status: 'готово' });
      break;
    } catch (err) {
      failed.push({ phase: 'Итог', member: j.name, error: err.message });
      onEvent({ phase: 'Итог', member: j.name, status: 'не смог', error: err.message });
    }
  }
  if (!verdict) throw new Error('ректор не смог написать итог');
  signal?.throwIfAborted();
  // two rectors: the second checks the first's verdict against the answers and gives the final one
  // ("головной и костный мозг"); if it can't, the first verdict stands
  const second = twoRectors ? rectors.find((j) => j.name !== by) : null;
  if (second) {
    onEvent({ phase: 'Итог', member: second.name, status: 'проверяет итог' });
    try {
      verdict = await second.ask(SECOND_RECTOR(q, anon, verdict));
      by = `${by} + ${second.name}`;
      onEvent({ phase: 'Итог', member: second.name, status: 'готово' });
    } catch (err) {
      failed.push({ phase: 'Итог (второй ректор)', member: second.name, error: err.message });
      onEvent({ phase: 'Итог', member: second.name, status: 'не смог', error: err.message });
    }
  }
  signal?.throwIfAborted();
  return {
    question: q,
    letters: finals.map(([m], i) => `Участник ${LETTERS[i]} — ${m.name}`),
    round1: r1.map(([m, t]) => ({ member: m.name, text: t })),
    round2: r2.map(([m, t]) => ({ member: m.name, text: t })),
    verdict, judge: by, failed,
  };
}

/** The extract for Gemma: the "- …" lines under «Выжимка для Геммы». */
function extractFor(verdict) {
  const m = String(verdict || '').match(/##\s*Выжимка для Геммы\s*\n([\s\S]*?)(?:\n##\s|$)/i);
  return m ? m[1].split('\n').map((l) => l.trim()).filter((l) => /^[-*]\s+\S/.test(l)).map((l) => l.replace(/^[-*]\s+/, '')) : [];
}

const pad = (n) => String(n).padStart(2, '0');

/** The council written down: <vault>/Результаты/Совет/<date time topic>.md (verdict first, then the rounds). */
function writeCouncil(vaultRoot, result, { at = Date.now() } = {}) {
  const d = new Date(at);
  const folder = path.join(vaultRoot, 'Результаты', 'Совет');
  fs.mkdirSync(folder, { recursive: true });
  const topic = result.question.split('\n')[0].replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())} ${topic}`;
  const rounds = (title, list) => (list.length ? `\n## ${title}\n\n${list.map((r) => `### ${r.member}\n\n${r.text}`).join('\n\n')}\n` : '');
  const failed = result.failed.length ? `\n## Не ответили\n\n${result.failed.map((f) => `- ${f.phase}: ${f.member} — ${f.error}`).join('\n')}\n` : '';
  const body = `---\nтип: совет\nсоздано: ${name.slice(0, 10)}\nректор: ${result.judge}\nучастники: [${result.round1.map((r) => `"${r.member}"`).join(', ')}]\n---\n# Совет: ${topic}\n\n**Вопрос:** ${result.question}\n\n${result.verdict}\n${result.letters && result.letters.length ? `\n**Кто есть кто в итоге:** ${result.letters.join('; ')}\n` : ''}${failed}${rounds('Раунд 2 — перекрёстный', result.round2)}${rounds('Раунд 1 — вслепую', result.round1)}`;
  const file = path.join(folder, `${name}.md`);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

module.exports = { runCouncil, writeCouncil, extractFor, runCli, claudeRunner, codexRunner, ROUND1, ROUND2, VERDICT, SECOND_RECTOR, HOST_VOICE };
