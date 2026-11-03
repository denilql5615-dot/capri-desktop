'use strict';

// Claude and Codex as her workers: named in what you say ("Клод, разбери…", "спроси кодекс…"), the
// message goes to that one instead of her chat model, and its answer comes back as hers. Claude runs as
// her Claude Code chat (llm.js, in her Claude Code folder and permission mode); Codex runs `codex exec`
// in the same folder, read-only. Both through your own subscriptions: no API keys.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

// how speech-to-text spells them too; a letter just before is another word ("телеклод")
const CLAUDE_RE = /(?<![а-яёa-z])(клод|клауд|клоуд|claude|антропик|anthropic)/i;
const CODEX_RE = /(?<![а-яёa-z])(кодекс|кодэкс|codex)/i;
const CODEX_TIMEOUT_MS = 10 * 60 * 1000;

/** 'claude', 'codex' (whichever is named first), or null: her chat model answers. */
function route(text) {
  const t = String(text || '').slice(0, 2000);
  const claude = t.search(CLAUDE_RE);
  const codex = t.search(CODEX_RE);
  if (claude < 0 && codex < 0) return null;
  return codex >= 0 && (claude < 0 || codex < claude) ? 'codex' : 'claude';
}

const exists = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
const onPath = (name) => (process.env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name));

/** Claude Code's executable (its native installer puts it in ~/.local/bin, often not on PATH), or null. */
function findClaude() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  return [
    process.env.CAPRI_CLAUDE_PATH,
    path.join(home, '.local', 'bin', exe),
    path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe),
    path.join(localAppData, 'Programs', 'claude', exe),
    ...onPath(exe),
  ].find((c) => c && exists(c)) || null;
}

/** The Codex CLI (Codex Desktop keeps one per build under %LOCALAPPDATA%\OpenAI\Codex\bin), or null. */
function findCodex() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const bin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  let builds = [];
  try {
    builds = fs.readdirSync(bin, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(bin, e.name, exe))
      .filter(exists)
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); // the newest build
  } catch {
    // no Codex Desktop here
  }
  return [
    process.env.CAPRI_CODEX_PATH,
    ...onPath(exe),
    path.join(bin, exe),
    ...builds,
    path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', exe),
    path.join(home, '.local', 'bin', exe),
  ].find((c) => c && exists(c)) || null;
}

// Codex keeps no memory of her chat: the whole task goes in one brief (her persona, the conversation, the ask).
function codexBrief(messages) {
  const persona = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  const goal = turns.at(-1)?.content || '';
  const before = turns.slice(0, -1).slice(-8).map((m) => `${m.role === 'user' ? 'User' : 'Capri'}: ${m.content}`).join('\n\n');
  return [
    persona,
    '',
    '[You are Codex, answering through Capri: the user named you. Do the task yourself and reply in her voice, in the user\'s language. You run read-only: if the task needs changes, say what you would change.]',
    before ? `Conversation so far:\n${before}` : '',
    `Task: ${goal}`,
  ].filter(Boolean).join('\n\n');
}

function askCodex(cfg, messages, onDelta, signal) {
  const exe = findCodex();
  if (!exe) return Promise.reject(new Error('Codex не найден на этом ПК: поставь Codex и войди в него.'));
  const cwd = cfg.claudeCwd && fs.existsSync(cfg.claudeCwd) ? cfg.claudeCwd : os.homedir();
  const out = path.join(os.tmpdir(), `capri-codex-${process.pid}-${Date.now()}.txt`);
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', cwd, '--output-last-message', out, '-'], {
      cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
    });
    const kill = () => (process.platform === 'win32'
      ? execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => {})
      : child.kill());
    signal.addEventListener('abort', kill, { once: true });
    const timer = setTimeout(kill, CODEX_TIMEOUT_MS);
    let errors = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { errors = (errors + d).slice(-4000); });
    child.on('error', (err) => reject(new Error(`Codex не запустился: ${err.message}`)));
    child.on('close', (code) => {
      clearTimeout(timer);
      let text = '';
      try {
        text = fs.readFileSync(out, 'utf8').trim();
      } catch {
        // no answer written
      }
      fs.rm(out, { force: true }, () => {});
      if (signal.aborted) return reject(new Error('stopped'));
      if (text) {
        onDelta(text); // the CLI gives its answer whole, at the end
        return resolve(text);
      }
      const again = /try again at ([^.\n]+)/i.exec(errors)?.[1]?.trim();
      if (/usage limit|rate.?limit|quota|\b429\b/i.test(errors)) return reject(new Error(`У Codex кончился лимит${again ? `, снова можно в ${again}` : ''}.`));
      if (/log ?in|auth|credential|not signed/i.test(errors)) return reject(new Error('Codex не вошёл в аккаунт: открой Codex и войди.'));
      reject(new Error(`Codex завершился (${code}): ${errors.trim().split('\n').at(-1)?.slice(0, 200) || 'без ответа'}`));
    });
    child.stdin.end(codexBrief(messages));
  });
}

module.exports = { route, findClaude, findCodex, askCodex, codexBrief };
