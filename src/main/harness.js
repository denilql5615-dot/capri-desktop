'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const DEFAULT_REPO = 'D:\\Capri\\capri-desktop';
const DEFAULT_SCRIPT = 'D:\\Capri\\genesis-src\\services\\Run-GeminiLeadHarness.ps1';
const DEFAULT_STATE = 'D:\\Capri\\genesis-src\\.tmp\\gemini-harness-state.md';
const DEFAULT_LOG = 'D:\\Capri\\genesis-src\\.tmp\\gemini-harness.log';
const DEFAULT_PID = 'D:\\Capri\\genesis-src\\.tmp\\gemini-harness.pid';

const HARNESS_TOOL_SPEC = {
  name: 'harness_control',
  description: 'Управление автономным харнесс-циклом GENESIS (start, status, note, stop).',
  actions: ['start', 'status', 'note', 'stop'],
};

const REPO_ALIASES = {
  'capri-desktop': 'D:\\Capri\\capri-desktop',
  desktop: 'D:\\Capri\\capri-desktop',
  pc: 'D:\\Capri\\capri-desktop',
  'пк': 'D:\\Capri\\capri-desktop',
  'capri-android-ref': 'D:\\Capri\\capri-android-ref',
  android: 'D:\\Capri\\capri-android-ref',
  'андроид': 'D:\\Capri\\capri-android-ref',
  'genesis-src': 'D:\\Capri\\genesis-src',
  genesis: 'D:\\Capri\\genesis-src',
  obsidian: 'D:\\Obsidian\\C.A.P.R.I',
  vault: 'D:\\Obsidian\\C.A.P.R.I',
};

function resolveRepo(raw) {
  const v = String(raw || '').trim();
  if (!v) return DEFAULT_REPO;
  const key = v.toLowerCase();
  if (REPO_ALIASES[key]) return REPO_ALIASES[key];
  return v;
}

function parseFlags(rest) {
  const out = {};
  const text = String(rest || '').trim();
  if (!text) return out;

  const flagRe = /(?:^|\s)(?:-(Repo|Goal|MaxWaves|Model)\s+|(repo|goal|maxWaves|model)=)/gi;
  const matches = [];
  let m;
  while ((m = flagRe.exec(text)) !== null) {
    const key = (m[1] || m[2]).toLowerCase();
    matches.push({ key, start: m.index + m[0].length, fullStart: m.index });
  }
  if (matches.length === 0) return out;

  for (let i = 0; i < matches.length; i += 1) {
    const cur = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1].fullStart : text.length;
    let val = text.slice(cur.start, end).trim();
    val = val.replace(/^["']|["']$/g, '').trim();
    out[cur.key] = val;
  }
  return out;
}

function parseHarnessCommand(input) {
  // __HARNESS_RU_STATUS__
  const _raw = String(input || '').trim().toLowerCase();
  if (/^\/?(?:harness\s+status|харнесс\s+статус)$/i.test(_raw) || (/(?:харнесс|harness)/i.test(_raw) && /(?:статус|как\s+(?:там|дела|пошл|ид[её]т)|что\s+(?:по|с|там)|прогресс|status)/i.test(_raw) && !/(?:стоп|останов|stop|запуст|старт|start|заметк|note)/i.test(_raw))) {
    return { action: 'status' };
  }
  const raw = String(input || '').trim();
  if (!raw) return null;

  const cleaned = raw.replace(/^(?:капри|capri)[,\s]+/i, '').trim();

  if (/^\/(?:harness|харнесс)(?:\s+status|\s+статус)?$/i.test(cleaned)) {
    return { action: 'status' };
  }
  let m = cleaned.match(/^\/(?:harness|харнесс)\s+start\s+([\s\S]+)$/i);
  if (m) {
    const f = parseFlags(m[1]);
    return {
      action: 'start',
      repo: f.repo || '',
      goal: f.goal || (Object.keys(f).length === 0 ? m[1].trim() : ''),
      ...(f.maxwaves ? { maxWaves: Number(f.maxwaves) } : {}),
      ...(f.model ? { model: f.model } : {}),
    };
  }
  m = cleaned.match(/^\/(?:harness|харнесс)\s+note\s+([\s\S]+)$/i);
  if (m) return { action: 'note', text: m[1].trim() };

  m = cleaned.match(/^\/(?:harness|харнесс)\s+stop(?:\s+([\s\S]+))?$/i);
  if (m) return { action: 'stop', reason: m[1] ? m[1].trim() : undefined };

  if (/^(?:harness\s+status|status\s+harness|статус\s+харнесса?|логи\s+харнесса?|что\s+(?:там\s+)?с\s+харнесс(?:ом)?\??)$/i.test(cleaned)) {
    return { action: 'status' };
  }

  m = cleaned.match(/^(?:start\s+harness|harness\s+start)\s+([\s\S]+)$/i);
  if (m) {
    const f = parseFlags(m[1]);
    return {
      action: 'start',
      repo: f.repo || '',
      goal: f.goal || (Object.keys(f).length === 0 ? m[1].trim() : ''),
      ...(f.maxwaves ? { maxWaves: Number(f.maxwaves) } : {}),
      ...(f.model ? { model: f.model } : {}),
    };
  }
  m = cleaned.match(/^запусти(?:ть)?\s+харнесс(?:\s+(?:в|для)\s+([^\s:]+))?\s*[:\-—]\s*([\s\S]+)$/i);
  if (m) {
    return { action: 'start', repo: m[1] || '', goal: m[2].trim() };
  }

  m = cleaned.match(/^(?:harness\s+note|допиши\s+в\s+харнесс|заметка\s+в\s+харнесс)\s*[:\-—]?\s+([\s\S]+)$/i);
  if (m) return { action: 'note', text: m[1].trim() };

  m = cleaned.match(/^(?:останови(?:ть)?\s+харнесс|стоп\s+харнесс|stop\s+harness)(?:\s*[:\-—]\s*|\s+)?([\s\S]*)$/i);
  if (m) {
    const reason = (m[1] || '').trim();
    return { action: 'stop', reason: reason || undefined };
  }

  return null;
}

function defaultIsPidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultKillProcess(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      childProcess.execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(Number(pid), 'SIGTERM');
    }
  } catch { /* ignore */ }
}

function parseStateSections(text) {
  text = String(text || '').replace(/^\uFEFF/, '');
  const lines = String(text || '').split(/\r?\n/);
  let harnessStatus = 'UNKNOWN';
  let repo = '';
  let goal = '';
  const doneItems = [];
  const remainingItems = [];
  const notes = [];
  let section = '';

  for (const line of lines) {
    const stMatch = line.match(/^HARNESS_STATUS:\s*(.+)$/);
    if (stMatch) { harnessStatus = stMatch[1].trim(); continue; }
    const repoMatch = line.match(/^REPO:\s*(.+)$/);
    if (repoMatch) { repo = repoMatch[1].trim(); continue; }
    const goalMatch = line.match(/^GOAL:\s*(.+)$/);
    if (goalMatch) { goal = goalMatch[1].trim(); continue; }

    if (/^##\s+Сделано/i.test(line)) { section = 'done'; continue; }
    if (/^##\s+Осталось/i.test(line)) { section = 'rem'; continue; }
    if (/^##\s+Заметки/i.test(line)) { section = 'notes'; continue; }
    if (/^##\s+/.test(line)) { section = ''; continue; }

    const item = line.match(/^\s*-\s+(.+)$/);
    if (item) {
      if (section === 'done') doneItems.push(item[1].trim());
      else if (section === 'rem') remainingItems.push(item[1].trim());
      else if (section === 'notes') notes.push(item[1].trim());
    }
  }
  return { harnessStatus, repo, goal, doneItems, remainingItems, notes };
}

function createHarnessManager(opts = {}) {
  const scriptPath = opts.scriptPath || DEFAULT_SCRIPT;
  const statePath = opts.statePath || DEFAULT_STATE;
  const logPath = opts.logPath || DEFAULT_LOG;
  const pidPath = opts.pidPath || DEFAULT_PID;
  const now = opts.now || (() => new Date());
  const isPidAlive = opts.isPidAlive || defaultIsPidAlive;
  const killProcess = opts.killProcess || defaultKillProcess;
  const spawn = opts.spawn || childProcess.spawn;

  function readPid() {
    if (!fs.existsSync(pidPath)) return null;
    const raw = fs.readFileSync(pidPath, 'utf8').trim();
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  async function start(req = {}) {
    const goal = String(req.goal || '').trim();
    if (!goal) return { ok: false, error: 'Укажите цель (-Goal) для запуска харнесса.' };
    if (!fs.existsSync(scriptPath)) return { ok: false, error: `Скрипт харнесса не найден: ${scriptPath}` };

    const existingPid = readPid();
    if (existingPid && isPidAlive(existingPid)) {
      return { ok: false, alreadyRunning: true, pid: existingPid, error: `Харнесс уже запущен (PID ${existingPid}).` };
    }

    const repo = resolveRepo(req.repo);
    const args = ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Repo', repo, '-Goal', goal];
    if (req.maxWaves) args.push('-MaxWaves', String(req.maxWaves));
    if (req.model) args.push('-Model', String(req.model));

    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    // __HARNESS_RESET_STATE__
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(statePath, [
      'HARNESS_STATUS: IN_PROGRESS',
      'REPO: ' + repo,
      'GOAL: ' + goal,
      '',
      '## Сделано',
      '- Запуск харнесса (' + now().toISOString() + ')',
      '',
      '## Осталось',
      '- ' + goal,
      ''
    ].join('\n'), 'utf8');
    fs.writeFileSync(logPath, '', 'utf8');
    let logFd = null;
    let pid = null;
    try {
      logFd = fs.openSync(logPath, 'a');
      const child = spawn('powershell.exe', args, { detached: false, stdio: ['ignore', logFd, logFd], windowsHide: true });
      if (child && typeof child.unref === 'function') child.unref();
      pid = child && child.pid ? child.pid : null;
      if (pid) fs.writeFileSync(pidPath, String(pid), 'utf8');
    } finally {
      if (logFd !== null) { try { fs.closeSync(logFd); } catch {} }
    }

    return { ok: true, action: 'start', pid, repo, goal };
  }

  async function note(req = {}) {
    const text = String(req.text || "").trim();
    if (!text) return { ok: false, error: "\u041f\u0443\u0441\u0442\u0430\u044f \u0437\u0430\u043c\u0435\u0442\u043a\u0430: \u0443\u043a\u0430\u0436\u0438\u0442\u0435 \u0442\u0435\u043a\u0441\u0442." };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const stamp = now().toISOString();
    let content = fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : "HARNESS_STATUS: IN_PROGRESS\n";
    const entry = "- [" + stamp + "] " + text;
    const headerRe = /^##\s+\u0417\u0430\u043c\u0435\u0442\u043a\u0438/m;
    const idx = content.search(headerRe);
    if (idx !== -1) {
      const nl = content.indexOf("\n", idx);
      const after = nl === -1 ? "" : content.slice(nl + 1);
      const next = after.search(/^##\s+/m);
      if (next === -1) {
        content = content.trimEnd() + "\n" + entry + "\n";
      } else {
        const pos = nl + 1 + next;
        content = content.slice(0, pos).trimEnd() + "\n" + entry + "\n\n" + content.slice(pos);
      }
    } else {
      content = content.trimEnd() + "\n\n## \u0417\u0430\u043c\u0435\u0442\u043a\u0438\n" + entry + "\n";
    }
    fs.writeFileSync(statePath, content, "utf8");
    return { ok: true, action: "note", text: entry };
  }

  async function status(req = {}) {
    const logLines = Math.max(1, Number(req.logLines) || 15);
    const pid = readPid();
    const running = Boolean(pid && isPidAlive(pid));
    const stateRaw = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
    const parsed = parseStateSections(stateRaw);
    let logTail = [];
    if (fs.existsSync(logPath)) {
      logTail = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-logLines);
    }
    return {
      ok: true,
      action: 'status',
      running,
      pid: running ? pid : null,
      ...parsed,
      logTail,
    };
  }

  async function stop(req = {}) {
    const reason = req.reason ? String(req.reason).trim() : '';
    const pid = readPid();
    const wasRunning = Boolean(pid && isPidAlive(pid));
    if (wasRunning) {
      await killProcess(pid);
    }
    if (fs.existsSync(pidPath)) {
      try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
    }
    let stateUpdated = false;
    if (fs.existsSync(statePath)) {
      let content = fs.readFileSync(statePath, 'utf8');
      content = content.replace(/^HARNESS_STATUS:.*$/m, 'HARNESS_STATUS: STOPPED');
      if (reason) {
        const stamp = now().toISOString();
        content = content.trimEnd() + `\n\n## Заметки\n- [${stamp}] Остановлен: ${reason}\n`;
      }
      fs.writeFileSync(statePath, content, 'utf8');
      stateUpdated = true;
    }
    return { ok: true, action: 'stop', wasRunning, stateUpdated, reason: reason || undefined };
  }

  async function run(req = {}) {
    const action = String(req.action || 'status').toLowerCase();
    if (action === 'start') return start(req);
    if (action === 'status') return status(req);
    if (action === 'note') return note(req);
    if (action === 'stop') return stop(req);
    return { ok: false, error: `Неизвестное действие: ${req.action}` };
  }

  return { run, start, status, note, stop };
}

function formatHarnessAnswer(res) {
  if (!res || !res.ok) return `Ошибка харнесса: ${res?.error || 'неизвестная ошибка'}`;
  if (res.action === 'start') return `Харнесс запущен (PID ${res.pid}) для ${res.repo}: ${res.goal}`;
  if (res.action === 'note') return `Заметка добавлена в харнесс: ${res.text}`;
  if (res.action === 'stop') return res.wasRunning ? 'Харнесс остановлен.' : 'Харнесс уже не запущен.';

  const parts = [
    `Статус харнесса: ${res.harnessStatus || 'UNKNOWN'} (${res.running ? `PID ${res.pid}` : 'не запущен'})`,
  ];
  if (res.doneItems?.length) parts.push(`Сделано (${res.doneItems.length}):\n- ${res.doneItems.join('\n- ')}`);
  if (res.remainingItems?.length) parts.push(`Осталось (${res.remainingItems.length}):\n- ${res.remainingItems.join('\n- ')}`);
  if (res.notes?.length) parts.push(`Заметки:\n- ${res.notes.join('\n- ')}`);
  if (res.logTail?.length) parts.push(`Лог:\n${res.logTail.join('\n')}`);
  return parts.join('\n\n');
}

module.exports = {
  DEFAULT_REPO,
  HARNESS_TOOL_SPEC,
  parseHarnessCommand,
  resolveRepo,
  createHarnessManager,
  formatHarnessAnswer,
};
