'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');
const { promisify } = require('util');

const run = promisify(execFile);
const PERIODS = new Map([['Current session', 300], ['Current week (all models)', 10080]]);
const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');

function resetTime(line, now) {
  const match = /^Resets?\s+(?:([a-z]{3})\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?(?:\s*\(([^)]+)\))?$/i.exec(line);
  if (!match) return null;
  const [, month, day, hour, minute = '0', meridiem, zone] = match;
  if (zone && zone !== Intl.DateTimeFormat().resolvedOptions().timeZone) return null;
  const hours = meridiem ? Number(hour) % 12 + (/pm/i.test(meridiem) ? 12 : 0) : Number(hour);
  if (hours > 23 || Number(minute) > 59) return null;
  const date = new Date(now);
  date.setHours(hours, Number(minute), 0, 0);
  if (month) {
    const index = MONTHS.indexOf(month.toLowerCase());
    if (index < 0) return null;
    date.setMonth(index, Number(day));
    if (date.getMonth() !== index) return null;
    if (date < now && now.getMonth() === 11 && index === 0) date.setFullYear(date.getFullYear() + 1);
  } else if (date < now) {
    date.setDate(date.getDate() + 1);
  }
  return date.getTime();
}

function parseUsage(text, now = new Date()) {
  let period = null;
  const windows = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('Current ')) {
      period = PERIODS.get(line.trim());
    } else if (period) {
      const used = /\b(\d{1,3})% used\b/i.exec(line);
      if (used && Number(used[1]) <= 100) {
        windows.set(period, { minutes: period, remaining: 100 - Number(used[1]), resetsAt: null, checkedAt: now.getTime() });
      } else if (windows.has(period) && /^Resets?\b/i.test(line)) {
        windows.get(period).resetsAt = resetTime(line, now);
      }
    }
  }
  return [...windows.values()];
}

function mergeClaudeWindows(windows) {
  const newest = new Map();
  for (const window of windows) {
    if (!Array.from(PERIODS.values()).includes(window.minutes) || !Number.isFinite(window.remaining) || !(window.checkedAt > 0)) continue;
    if (!(newest.get(window.minutes)?.checkedAt > window.checkedAt)) newest.set(window.minutes, window);
  }
  if (!newest.size) return null;
  const kept = [...newest.values()];
  return { windows: kept, checkedAt: Math.min(...kept.map((window) => window.checkedAt)) };
}

function trustedWorkDir(preferred) {
  try {
    const file = process.env.CLAUDE_CONFIG_DIR
      ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
      : path.join(os.homedir(), '.claude.json');
    const { projects } = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = Object.entries(projects || {}).filter(([dir, project]) =>
      path.isAbsolute(dir) && project?.hasTrustDialogAccepted === true && fs.existsSync(dir));
    const preferredPaths = preferred.filter(Boolean).map((dir) => path.resolve(dir).toLowerCase());
    return entries.find(([dir]) => preferredPaths.includes(path.resolve(dir).toLowerCase()))?.[0]
      || entries.find(([dir]) => /^(genesis-src|capri-desktop)$/i.test(path.basename(dir)))?.[0];
  } catch { return null; }
}

async function readClaudeUsage({ exe, workDir, preferred }) {
  if (process.platform !== 'win32' || !exe) return [];
  const cwd = trustedWorkDir(preferred);
  if (!cwd) return [];
  const nonce = randomUUID();
  const script = path.join(workDir, 'claude-usage.ps1');
  const out = path.join(workDir, 'claude-usage.txt');
  const shell = 'powershell.exe';
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'claude-usage.ps1')));
    const args = ['-NoProfile', '-NonInteractive', '-File', script, '-Exe', exe, '-WorkDir', cwd, '-Output', out, '-Nonce', nonce];
    const argumentList = args.map((arg) => quote(`"${arg}"`)).join(', ');
    await run(shell, ['-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath ${quote(shell)} -ArgumentList @(${argumentList}) -WindowStyle Hidden -Wait`],
    { windowsHide: true, timeout: 28000 });
    const [id, ...data] = fs.readFileSync(out, 'utf8').trim().split(/\r?\n/);
    return id === nonce ? parseUsage(data.join('\n')) : [];
  } catch { return []; }
}

module.exports = { readClaudeUsage, parseUsage, mergeClaudeWindows };
