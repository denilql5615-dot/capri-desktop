'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const policy = require('./policy');

const DEFAULT_CWD = 'D:\\Capri';
const DEFAULT_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_SEC = 120;
const MAX_COMMAND_LEN = 2000;
const STREAM_HEAD_BYTES = 6 * 1024;
const STREAM_TAIL_BYTES = 6 * 1024;

const SECRET_ENV_RE = /TOKEN|KEY|SECRET|PASS|CRED|COOKIE|AUTH/i;
const SECRET_TARGET_RE = /(?:^|[\\/.\s"'])(?:\.ssh|\.dpapi|\.capri|private-vault|\.env\b|id_rsa|id_ed25519|cookies\.sqlite|logins\.json|key4\.db)(?:$|[\\/.\s"'])|\b(?:cmdkey|Get-StoredCredential|ConvertFrom-SecureString|printenv)\b|\benv:|(?:\$env:)/i;
const DANGEROUS_CONSTRUCT_RE = /\b(?:iex|Invoke-Expression|Add-Type)\b|\s-(?:enc|EncodedCommand)\b|\[ScriptBlock\]|&\s*\$|\bStart-Process\b[^\n]*-Verb\s+RunAs/i;
const REDIRECT_CMDLET_RE = /\b(?:Out-File|Set-Content|Add-Content|Tee-Object)\b/i;
// Call operator on a computed name (`&('Re'+'move-Item')`, `. $cmd`) and aliasing hide what really runs.
const INDIRECT_CALL_RE = /(?:^|[\s;|({])[&.]\s*[($]|\b(?:Set-Alias|New-Alias|sal|nal)\b/i;
// Full access stays full: these are only the red lines (delete, install/system, send out) that must
// still ask even when hidden inside an interpreter (`powershell -c "..."`, `node -e "..."`) or `$(...)`.
const INLINE_DELETE_RE = /\b(?:Remove-Item|Remove-ItemProperty|rm|del|rmdir|rd|erase|ri|Clear-Content|clc|Clear-RecycleBin|Format-Volume|diskpart|rmSync|rmdirSync|unlinkSync|unlink|rmtree|removedirs)\b|\bos\.(?:remove|rmdir)\b|(?:\.|::)(?:Delete|Remove|Unlink)\w*\s*\(|\bgit\s+(?:clean|reset\s+--hard|restore|checkout\s+--|stash\s+(?:drop|clear)|push\s+(?:-f|--force))/i;
const INLINE_SYSTEM_RE = /\b(?:winget|choco|scoop|msiexec|bcdedit|shutdown|Stop-Computer|Restart-Computer|Set-ExecutionPolicy|schtasks|netsh|reg\s+(?:add|delete|import)|(?:npm|pnpm|yarn|pip3?)\s+(?:install|i|add|uninstall|remove|publish))\b/i;
const INLINE_SEND_RE = /\b(?:ssh|scp|sftp|Send-MailMessage|git\s+push|gh)\b/i;
const WRAPPER_HEADS = new Set([
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'cmd', 'cmd.exe', 'start-process', 'saps', 'start',
  'invoke-command', 'icm', 'start-job', 'sajb', 'foreach-object', '%',
  'node', 'node.exe', 'deno', 'bun', 'py', 'py.exe', 'python', 'python.exe', 'python3', 'pythonw',
  'bash', 'bash.exe', 'sh', 'wsl', 'wsl.exe', 'perl', 'ruby',
]);
const NETWORK_READ_RE = /\b(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|curl\.exe|wget)\b/i;
const INSTALL_OR_SYSTEM_CMDS = new Set([
  'winget', 'winget.exe', 'choco', 'scoop', 'msiexec', 'msiexec.exe',
  'reg', 'reg.exe', 'bcdedit', 'shutdown', 'restart-computer', 'stop-computer',
  'set-executionpolicy', 'sc', 'sc.exe', 'schtasks', 'netsh',
]);

const READ_ONLY_CMDS = new Set([
  'get-childitem', 'ls', 'dir', 'gci',
  'get-content', 'cat', 'type', 'gc',
  'select-string', 'sls',
  'get-item', 'gi', 'test-path', 'resolve-path', 'split-path', 'join-path',
  'get-process', 'ps', 'gps', 'get-service', 'gsv',
  'get-date', 'get-command', 'gcm', 'get-ciminstance', 'get-psdrive',
  'get-netipaddress', 'ipconfig', 'nvidia-smi', 'where.exe', 'hostname', 'whoami', 'systeminfo',
  'pwd', 'get-location', 'gl', 'echo', 'write-output',
  'format-table', 'ft', 'format-list', 'fl', 'select-object', 'select',
  'sort-object', 'sort', 'where-object', '?', 'measure-object', 'measure',
  'head', 'tail', 'more', 'findstr', 'tree',
]);

const DELETE_CMDS = new Set([
  'remove-item', 'rm', 'del', 'rmdir', 'rd', 'erase', 'ri',
  'clear-content', 'clc', 'format', 'diskpart',
]);

const NETWORK_SEND_CMDS = new Set([
  'ssh', 'scp', 'sftp', 'send-mailmessage', 'gh',
  'invoke-webrequest', 'iwr', 'curl', 'wget', 'invoke-restmethod', 'irm',
]);

const CLASS_RANK = {
  READ_ONLY: 0,
  FILE_WRITE: 1,
  TERMINAL_EXEC: 2,
  NETWORK_SEND: 3,
  DELETE: 4,
  CREDENTIAL_ACCESS: 5,
};

function scrubEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined || SECRET_ENV_RE.test(k)) continue;
    out[k] = v;
  }
  // Prepend real Python directory ahead of WindowsApps Store stubs so `python` / `python3` / `markitdown` work natively.
  const localAppData = env?.LOCALAPPDATA || path.join(env?.USERPROFILE || 'C:\\Users\\user', 'AppData', 'Local');
  const pyDir = path.join(localAppData, 'Programs', 'Python', 'Python313');
  const pyScripts = path.join(pyDir, 'Scripts');
  const extraPaths = [pyDir, pyScripts].filter((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  if (extraPaths.length) {
    const pathKey = Object.keys(out).find((k) => k.toLowerCase() === 'path') || 'Path';
    out[pathKey] = [...extraPaths, out[pathKey] || ''].filter(Boolean).join(path.delimiter);
  }
  out.PYTHONIOENCODING = 'utf-8';
  return out;
}

/**
 * Splits a PowerShell command string by ;, |, &&, ||, or newlines outside quotes.
 */
function splitSubcommands(command) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote) {
      cur += ch;
      if (ch === quote && command[i - 1] !== '`') quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '\n' || ch === '\r' || ch === ';' || ch === '|') {
      if (ch === '|' && next === '|') i += 1;
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      continue;
    }
    if (ch === '&' && next === '&') {
      i += 1;
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * Strips quoted string literals so keywords inside quotes (e.g. `Select-String "rm"`)
 * are not misread as shell redirects or operators.
 */
function stripQuotedStrings(s) {
  let out = '';
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === quote && s[i - 1] !== '`') quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function hasUnsafeRedirect(sub) {
  const unquoted = stripQuotedStrings(sub);
  if (REDIRECT_CMDLET_RE.test(unquoted)) return true;
  // Allow only `> $null`, `2>$null`, `2>&1`
  const cleaned = unquoted
    .replace(/\b2>&1\b/g, '')
    .replace(/\b[12]?\s*>{1,2}\s*\$null\b/gi, '');
  return /(?:^|[^<])>{1,2}/.test(cleaned);
}

function tokenizeSimple(sub) {
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < sub.length; i += 1) {
    const ch = sub[i];
    if (quote) {
      if (ch === quote && sub[i - 1] !== '`') quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** Bodies of every `$( ... )` subexpression, quoted or not (PowerShell expands them inside "..."). */
function subexpressions(s) {
  const out = [];
  for (let i = s.indexOf('$('); i !== -1; i = s.indexOf('$(', i + 2)) {
    let depth = 0;
    let j = i + 1;
    for (; j < s.length; j += 1) {
      if (s[j] === '(') depth += 1;
      else if (s[j] === ')') { depth -= 1; if (depth === 0) break; }
    }
    out.push(s.slice(i + 2, j));
  }
  return out;
}

/** Red lines in text we cannot parse (interpreter code, wrapped commands), quotes included. */
function inlineRedLine(text) {
  if (INLINE_DELETE_RE.test(text)) return { cls: 'DELETE', ask: true, reason: 'Удаление внутри вложенной команды' };
  if (INLINE_SEND_RE.test(text)) return { cls: 'NETWORK_SEND', ask: true, reason: 'Отправка в сеть внутри вложенной команды' };
  if (INLINE_SYSTEM_RE.test(text)) return { cls: 'TERMINAL_EXEC', ask: true, reason: 'Установка ПО или системная команда внутри вложенной команды' };
  return null;
}

function classifySingleSubcommand(sub) {
  if (SECRET_TARGET_RE.test(sub)) {
    return { cls: 'CREDENTIAL_ACCESS', ask: true, reason: 'Обращение к секретам или переменным окружения' };
  }
  const tokens = tokenizeSimple(sub);
  if (!tokens.length) return { cls: 'READ_ONLY', ask: false, reason: 'Пусто' };

  let head = tokens[0].toLowerCase();
  if (head === '&' && tokens[1]) {
    tokens.shift();
    head = tokens[0].toLowerCase();
  }
  head = head.replace(/^.*[/\\]/, '');
  const args = tokens.slice(1);
  const lowArgs = args.map((a) => a.toLowerCase());

  if (WRAPPER_HEADS.has(head)) {
    const hit = inlineRedLine(sub);
    if (hit) return { ...hit, reason: `${hit.reason} (${head})` };
  }

  if (DELETE_CMDS.has(head) || /^(?:remove|clear|uninstall)-/.test(head)) {
    return { cls: 'DELETE', ask: true, reason: `Удаление (${head})` };
  }
  if (/\b(?:remove-item|rm|del|rmdir|rd|erase|ri|clear-content|format|diskpart)\b/i.test(stripQuotedStrings(sub))) {
    return { cls: 'DELETE', ask: true, reason: `Удаление внутри выражения (${head})` };
  }
  if (INSTALL_OR_SYSTEM_CMDS.has(head)) {
    return { cls: 'TERMINAL_EXEC', ask: true, reason: `Установка ПО или системная команда (${head})` };
  }
  if (NETWORK_SEND_CMDS.has(head)) {
    if (['invoke-webrequest', 'iwr', 'curl', 'curl.exe', 'wget', 'invoke-restmethod', 'irm'].includes(head)) {
      const hasMutatingHttp = lowArgs.some((a) => ['post', 'put', 'delete', 'patch', '-body', '-infile', '-d', '--data'].includes(a));
      if (!hasMutatingHttp) {
        return { cls: 'READ_ONLY', ask: false, reason: `HTTP чтение (${head})` };
      }
    }
    return { cls: 'NETWORK_SEND', ask: true, reason: `Сетевая отправка (${head})` };
  }
  if (head === 'set' && args.length === 0) {
    return { cls: 'CREDENTIAL_ACCESS', ask: true, reason: 'Чтение переменных окружения' };
  }
  if (head === 'git') {
    const subCmd = lowArgs.find((a) => !a.startsWith('-')) || '';
    if (subCmd === 'clean' || (subCmd === 'reset' && lowArgs.includes('--hard')) ||
        (subCmd === 'rebase') || (subCmd === 'branch' && lowArgs.includes('-d')) ||
        (subCmd === 'checkout' && lowArgs.includes('--')) ||
        (subCmd === 'restore' && !lowArgs.includes('--staged')) ||
        (subCmd === 'stash' && ['drop', 'clear'].includes(lowArgs[lowArgs.indexOf('stash') + 1]))) {
      return { cls: 'DELETE', ask: true, reason: `Изменение/сброс git (${subCmd})` };
    }
    if (subCmd === 'push') {
      const force = lowArgs.some((a) => a === '-f' || a === '--force' || a === '--force-with-lease');
      return { cls: force ? 'DELETE' : 'NETWORK_SEND', ask: true, reason: 'git push' };
    }
    const roGit = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'blame', 'ls-files', 'describe', 'shortlog']);
    if (roGit.has(subCmd)) return { cls: 'READ_ONLY', ask: false, reason: `git ${subCmd}` };
    return { cls: 'TERMINAL_EXEC', ask: false, reason: `git ${subCmd || 'команда'}` };
  }
  if (head === 'docker' || head === 'docker.exe') {
    const subCmd = lowArgs[0] || '';
    if (['rm', 'rmi', 'prune'].includes(subCmd) || (subCmd === 'system' && lowArgs[1] === 'prune') || (subCmd === 'volume' && lowArgs[1] === 'rm')) {
      return { cls: 'DELETE', ask: true, reason: `docker ${subCmd}` };
    }
    if (['ps', 'images', 'logs', 'inspect', 'version', 'info'].includes(subCmd) ||
        (subCmd === 'stats' && lowArgs.includes('--no-stream'))) {
      return { cls: 'READ_ONLY', ask: false, reason: `docker ${subCmd}` };
    }
    return { cls: 'TERMINAL_EXEC', ask: false, reason: `docker ${subCmd || 'команда'}` };
  }
  if (head === 'ollama' || head === 'ollama.exe') {
    const subCmd = lowArgs[0] || '';
    if (['list', 'ls', 'ps', '--version', '-v'].includes(subCmd)) {
      return { cls: 'READ_ONLY', ask: false, reason: `ollama ${subCmd}` };
    }
    return { cls: 'TERMINAL_EXEC', ask: true, reason: `Изменение Ollama требует подтверждения (${subCmd})` };
  }
  if (head === 'npm' || head === 'npm.cmd' || head === 'pnpm' || head === 'yarn') {
    const subCmd = lowArgs[0] || '';
    if (['install', 'i', 'ci', 'uninstall', 'remove', 'add', 'publish', 'link'].includes(subCmd)) {
      return { cls: subCmd === 'publish' ? 'NETWORK_SEND' : 'TERMINAL_EXEC', ask: true, reason: `Установка/публикация пакетов (${head} ${subCmd})` };
    }
    if (['ls', 'list', 'outdated', 'view', '--version', '-v'].includes(subCmd)) {
      return { cls: 'READ_ONLY', ask: false, reason: `npm ${subCmd}` };
    }
    return { cls: 'TERMINAL_EXEC', ask: false, reason: `${head} ${subCmd}` };
  }
  if (head === 'pip' || head === 'pip3' || head === 'pip.exe' || ((head === 'py' || head === 'python' || head === 'python.exe') && lowArgs[0] === '-m' && lowArgs[1] === 'pip')) {
    const joined = lowArgs.join(' ');
    if (/\b(?:install|uninstall)\b/.test(joined)) {
      return { cls: 'TERMINAL_EXEC', ask: true, reason: 'pip install/uninstall требует подтверждения' };
    }
  }
  if (hasUnsafeRedirect(sub)) {
    return { cls: 'FILE_WRITE', ask: false, reason: 'Запись вывода в файл' };
  }
  if (READ_ONLY_CMDS.has(head)) {
    return { cls: 'READ_ONLY', ask: false, reason: `Чтение (${head})` };
  }
  return { cls: 'TERMINAL_EXEC', ask: false, reason: `Рабочая команда (${head})` };
}

function classifyCommand(command, { cwd } = {}) {
  const raw = String(command ?? '').trim();
  if (!raw) return { cls: 'TERMINAL_EXEC', ask: true, reason: 'Пустая команда', subcommands: [] };
  if (raw.length > MAX_COMMAND_LEN) {
    return { cls: 'TERMINAL_EXEC', ask: true, reason: `Команда длиннее ${MAX_COMMAND_LEN} симв.`, subcommands: [] };
  }
  if (SECRET_TARGET_RE.test(raw)) {
    return { cls: 'CREDENTIAL_ACCESS', ask: true, reason: 'Упомянут путь с секретами или окружение', subcommands: [raw] };
  }
  // A backtick inside a word is ignored by PowerShell (`Re`move-Item` runs Remove-Item): judge the command without them.
  const plain = raw.replace(/`(?=[A-Za-z-])/g, '');
  if (DANGEROUS_CONSTRUCT_RE.test(plain) || INDIRECT_CALL_RE.test(stripQuotedStrings(plain))) {
    return { cls: 'TERMINAL_EXEC', ask: true, reason: 'Скрытый вызов PowerShell (iex, -enc, Add-Type, &(...), алиас)', subcommands: [raw] };
  }

  const subcommands = splitSubcommands(plain);
  let worst = { cls: 'READ_ONLY', ask: false, reason: 'Чтение' };
  const consider = (res) => {
    if (CLASS_RANK[res.cls] > CLASS_RANK[worst.cls] || (res.cls === worst.cls && res.ask && !worst.ask)) {
      worst = res;
    }
  };
  for (const sub of subcommands) consider(classifySingleSubcommand(sub));
  for (const inner of subexpressions(plain)) {
    const res = classifyCommand(inner, { cwd });
    if (res.ask || res.cls !== 'READ_ONLY') consider({ ...res, reason: `${res.reason} внутри $(...)` });
  }
  return { ...worst, subcommands };
}

/** The command pulls text from the network (its output is untrusted, like a web page). */
function readsNetwork(command) {
  return NETWORK_READ_RE.test(String(command ?? ''));
}

function createBoundedStream() {
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let totalBytes = 0;
  let lines = 0;
  let lastByte = 0;

  return {
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (!buf.length) return;
      for (let i = 0; i < buf.length; i += 1) {
        if (buf[i] === 10) lines += 1;
      }
      lastByte = buf[buf.length - 1];
      totalBytes += buf.length;
      if (head.length < STREAM_HEAD_BYTES) {
        const take = Math.min(buf.length, STREAM_HEAD_BYTES - head.length);
        head = Buffer.concat([head, buf.subarray(0, take)]);
        const rest = buf.subarray(take);
        if (rest.length) {
          tail = Buffer.concat([tail, rest]).subarray(-STREAM_TAIL_BYTES);
        }
      } else {
        tail = Buffer.concat([tail, buf]).subarray(-STREAM_TAIL_BYTES);
      }
    },
    text() {
      if (totalBytes <= STREAM_HEAD_BYTES) return head.toString('utf8').trimEnd();
      const headStr = head.toString('utf8');
      const tailStr = tail.toString('utf8');
      const omitted = Math.max(0, totalBytes - head.length - tail.length);
      return `${headStr}\n...[обрезано ${omitted} байт]...\n${tailStr}`.trimEnd();
    },
    lineCount() {
      if (totalBytes === 0) return 0;
      return lastByte === 10 ? lines : lines + 1;
    },
  };
}

function killProcessTree(pid, child, execFileImpl = execFile) {
  if (process.platform === 'win32' && pid) {
    try {
      execFileImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 4000 }, () => {});
      return;
    } catch {}
  }
  try { child.kill('SIGKILL'); } catch {}
}

function runCommand(
  { command, cwd = DEFAULT_CWD, timeoutSec = DEFAULT_TIMEOUT_SEC, signal = null } = {},
  { spawnImpl = spawn, execFileImpl = execFile, env = process.env } = {},
) {
  const cleanCmd = String(command ?? '').trim();
  if (!cleanCmd) {
    return Promise.resolve({ ok: false, exitCode: 1, wallSec: 0, lines: 0, output: 'Пустая команда.', error: 'Empty command' });
  }
  const resolvedCwd = path.resolve(String(cwd || DEFAULT_CWD));
  if (!fs.existsSync(resolvedCwd)) {
    return Promise.resolve({ ok: false, exitCode: 1, wallSec: 0, lines: 0, output: `Рабочая папка не найдена: ${resolvedCwd}`, error: 'CWD not found' });
  }
  const sec = Math.min(MAX_TIMEOUT_SEC, Math.max(1, Number(timeoutSec) || DEFAULT_TIMEOUT_SEC));
  const startedAt = Date.now();
  const stdoutCap = createBoundedStream();
  const stderrCap = createBoundedStream();

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], {
      cwd: resolvedCwd,
      windowsHide: true,
      env: scrubEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (code, errMsg = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const wallSec = Number(((Date.now() - startedAt) / 1000).toFixed(2));
      const outText = stdoutCap.text();
      const errText = stderrCap.text();
      const totalLines = stdoutCap.lineCount() + stderrCap.lineCount();
      const bodyParts = [];
      if (outText) bodyParts.push(outText);
      if (errText) bodyParts.push(`[stderr]\n${errText}`);
      if (timedOut) bodyParts.push(`Таймаут: превышено ${sec} с, дерево процессов завершено.`);
      if (aborted) bodyParts.push('Остановлено пользователем.');
      if (errMsg && !timedOut && !aborted) bodyParts.push(errMsg);
      const exitCode = Number.isInteger(code) ? code : 1;
      const formatted = [
        `Exit code: ${exitCode}`,
        `Wall time: ${wallSec} s`,
        `Total output lines: ${totalLines}`,
        'Output:',
        bodyParts.join('\n') || '(пустой вывод)',
      ].join('\n');
      resolve({
        ok: exitCode === 0 && !timedOut && !aborted && !errMsg,
        exitCode,
        wallSec,
        lines: totalLines,
        timedOut,
        output: formatted,
        ...(timedOut ? { error: `Timeout ${sec}s` } : aborted ? { error: 'Aborted' } : errMsg ? { error: errMsg } : {}),
      });
    };

    const onAbort = () => {
      aborted = true;
      killProcessTree(child.pid, child, execFileImpl);
    };
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, child, execFileImpl);
      setTimeout(() => finish(124), 150);
    }, sec * 1000);

    child.stdout?.on('data', (chunk) => stdoutCap.push(chunk));
    child.stderr?.on('data', (chunk) => stderrCap.push(chunk));
    child.on('error', (err) => finish(1, String(err?.message || err)));
    child.on('close', (code) => finish(code));

    try {
      const prefix = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';\n";
      child.stdin?.write(prefix + cleanCmd + '\n');
      child.stdin?.end();
    } catch (err) {
      finish(1, String(err?.message || err));
    }
  });
}

function createTerminalTool({ torState = null, spawnImpl, execFileImpl } = {}) {
  return {
    isAvailable(ctx = {}) {
      if (ctx.isolated) return false;
      if (torState?.isQuarantined?.()) return false;
      return true;
    },
    gate(args = {}, ctx = {}) {
      if (ctx.isolated || torState?.isQuarantined?.()) {
        return { decision: 'deny', cls: 'TERMINAL_EXEC', line: '', why: 'Терминал отключён в изолированном или Tor-режиме.' };
      }
      const cwd = args.cwd || DEFAULT_CWD;
      const classified = classifyCommand(args.command, { cwd });
      // Full agentic workspace access (like Claude Code / Codex), the same from the PC and the phone (Danyal 2026-11-25):
      // READ_ONLY, FILE_WRITE and dev/exec commands run at once; red lines (DELETE, CREDENTIAL_ACCESS,
      // NETWORK_SEND, installs, hidden calls) ask. The phone asks on the phone (the harness picks the asker).
      let decision = 'allow';
      let why = `${classified.reason} (${classified.cls})`;
      if (classified.ask || ['DELETE', 'CREDENTIAL_ACCESS', 'NETWORK_SEND'].includes(classified.cls)) {
        decision = 'confirm';
      } else if (ctx.untrusted && classified.cls !== 'READ_ONLY') {
        // This turn already read text from the web, RSS, mail or the phone: a page could have written this command.
        decision = 'confirm';
        why = `В этом ходе читался текст из сети — изменяющая команда только с подтверждением. ${why}`;
      }
      return {
        decision,
        cls: classified.cls,
        line: `Выполнить в PowerShell: ${String(args.command || '').slice(0, 140)}`,
        why,
      };
    },
    async run(args = {}, signal = null) {
      const res = await runCommand(
        { command: args.command, cwd: args.cwd || DEFAULT_CWD, timeoutSec: args.timeout_sec, signal },
        { spawnImpl, execFileImpl },
      );
      return res;
    },
  };
}

module.exports = {
  DEFAULT_CWD,
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
  scrubEnv,
  splitSubcommands,
  classifyCommand,
  readsNetwork,
  runCommand,
  createTerminalTool,
};
