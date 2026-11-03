'use strict';

// Claude and Codex as her workers: named in what you say ("Клод, разбери…", "спроси кодекс…"), the
// message goes to that one instead of her chat model, and its answer comes back as hers. Both work in
// one folder of their own (DocumentsCapri): they read anywhere, but write only there. Claude may make
// and edit files there (no commands: they'd need a yes nobody can give from her bubble); Codex runs in
// its workspace-write sandbox, commands included. Both through your own subscriptions: no API keys.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

// how speech-to-text spells them too; a letter just before is another word ("телеклод")
const CLAUDE_RE = /(?<![а-яёa-z])(клод|клауд|клоуд|claude|антропик|anthropic)/i;
const CODEX_RE = /(?<![а-яёa-z])(кодекс|кодэкс|codex)/i;
const TIMEOUT_MS = 10 * 60 * 1000;

/** Their folder (made if missing): where what they make for you lands. */
function workDir(cfg) {
  const dir = cfg.workDir || path.join(os.homedir(), 'Documents', 'Capri');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const killTree = (child) => (process.platform === 'win32'
  ? execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => {})
  : child.kill());

// where they work, told to them: what they make goes there, and the user hears where it is
const folderNote = (cwd) => `Your working folder is ${cwd}. You can read files anywhere, but write only there: anything you make for the user (a document, a script, notes) goes in that folder. When you made a file, say its name and that it is in that folder.`;

// The CLIs take one prompt: the last turns ride along as a transcript.
function transcript(messages, last = 8) {
  const turns = messages.filter((m) => m.role !== 'system');
  const before = turns.slice(0, -1).slice(-last).map((m) => `${m.role === 'user' ? 'User' : 'Capri'}: ${m.content}`).join('\n\n');
  return [before ? `Conversation so far:\n${before}` : '', `Task: ${turns.at(-1)?.content || ''}`].filter(Boolean).join('\n\n');
}

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
function codexBrief(messages, cwd) {
  const persona = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  return [persona, cwd && folderNote(cwd), transcript(messages)].filter(Boolean).join('\n\n');
}

// Claude: one-shot `claude -p` in her folder; edits there go through without asking (acceptEdits),
// anything needing a yes (a command) is refused, and it says so.
function askClaude(cfg, messages, onDelta, signal, find = findClaude) {
  const exe = find();
  if (!exe) return Promise.reject(new Error('Claude Code не найден на этом ПК: поставь его и войди.'));
  const cwd = workDir(cfg);
  const personaFile = path.join(os.tmpdir(), `capri-worker-${process.pid}.txt`);
  fs.writeFileSync(personaFile, [...messages.filter((m) => m.role === 'system').map((m) => m.content), folderNote(cwd)].join('\n\n'));
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
    '--append-system-prompt-file', personaFile, '--no-session-persistence'];
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = () => killTree(child);
    signal.addEventListener('abort', kill, { once: true });
    const timer = setTimeout(kill, TIMEOUT_MS);
    let buffer = '';
    let all = '';
    let result = null;
    let errors = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'assistant') {
          for (const block of msg.message?.content || []) {
            if (block.type !== 'text' || !block.text) continue;
            const piece = (all ? '\n' : '') + block.text;
            all += piece;
            onDelta(piece);
          }
        } else if (msg.type === 'result') {
          result = msg;
        }
      }
    });
    child.stderr.on('data', (d) => { errors = (errors + d).slice(-4000); });
    child.stdin.end(transcript(messages));
    child.on('error', (err) => reject(new Error(`Claude Code не запустился: ${err.message}`)));
    child.on('close', () => {
      clearTimeout(timer);
      if (signal.aborted) return reject(new Error('stopped'));
      if (result?.is_error) return reject(new Error(result.result || 'Claude Code не справился'));
      if (!result) return reject(new Error(errors.trim().slice(0, 300) || 'Claude Code ничего не ответил'));
      resolve(result.result || all);
    });
  });
}

function askCodex(cfg, messages, onDelta, signal) {
  const exe = findCodex();
  if (!exe) return Promise.reject(new Error('Codex не найден на этом ПК: поставь Codex и войди в него.'));
  const cwd = workDir(cfg);
  const out = path.join(os.tmpdir(), `capri-codex-${process.pid}-${Date.now()}.txt`);
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--cd', cwd, '--output-last-message', out, '-'], {
      cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
    });
    const kill = () => killTree(child);
    signal.addEventListener('abort', kill, { once: true });
    const timer = setTimeout(kill, TIMEOUT_MS);
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
    child.stdin.end(codexBrief(messages, cwd));
  });
}

module.exports = { route, findClaude, findCodex, askClaude, askCodex, codexBrief, transcript, workDir };
