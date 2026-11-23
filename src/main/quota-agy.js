'use strict';

// 2.8b: live Antigravity limits. `agy` hands its quota pools to its status line command when an interactive
// session starts — no request to a model. We start it for a few seconds in a hidden console of its own (a
// real console, so it runs interactively), with our status line for that one session only (--settings is
// never saved), wait for scripts/agy-statusline.js to write its snapshot, then stop that process tree.

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { OUT } = require('../../scripts/agy-statusline');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'agy-statusline.js');

/** The status line snapshot as hub windows per Antigravity group. A disabled pool window is left out. */
function poolsToGroups(snap) {
  const p = snap?.pools || {};
  const win = (key, minutes) => {
    const e = p[key];
    if (!e || e.disabled) return null;
    return { remaining: Math.round(e.remainingFraction * 1000) / 10, minutes, resetsAt: e.resetTime ?? null };
  };
  const out = {
    'agy-gemini': [win('gemini-5h', 300), win('gemini-weekly', 10080)].filter(Boolean),
    'agy-third-party': [win('3p-5h', 300), win('3p-weekly', 10080)].filter(Boolean),
  };
  const checkedAt = Number(snap?.checkedAt) || null;
  return { ...out, checkedAt: { 'agy-gemini': checkedAt, 'agy-third-party': checkedAt } };
}

function readSnapshot(file = OUT) {
  try {
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isFinite(snap?.checkedAt) && snap.checkedAt > 0 ? snap : null;
  } catch { return null; }
}

/**
 * One hidden `agy` start; resolves hub groups or null. Never two at a time.
 * opts: exe, workDir (a folder of Capri's own), node (the node to run the status line script), timeoutMs.
 */
let running = null;
function readAgyLive({ exe, workDir, node = 'node', timeoutMs = 25000, spawnImpl = spawn, killImpl, out = OUT, now = () => Date.now() } = {}) {
  if (!exe || !workDir) return Promise.resolve(null);
  if (running) return running;
  workDir = path.resolve(workDir);
  running = new Promise((resolve) => {
    const started = now();
    fs.mkdirSync(workDir, { recursive: true });
    const settings = path.join(workDir, 'agy-quota-settings.json');
    // Read through Electron's ASAR support and give AGY a bare script name in its working directory.
    fs.writeFileSync(path.join(workDir, 'agy-statusline.js'), fs.readFileSync(SCRIPT));
    const command = `${node} agy-statusline.js`;
    fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command } }), 'utf8');
    // agy runs interactively only with a real console: a node child with piped / ignored stdio has none.
    // Start-Process -WindowStyle Hidden gives it a console of its own that nobody sees; we get its PID back.
    let pid = null;
    let poll = null;
    let timer = null;
    let done = false;
    const kill = () => {
      if (!pid) return;
      if (typeof killImpl === 'function') return killImpl(pid);
      execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => {});
    };
    const finish = (value) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      kill();
      resolve(value);
    };
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const ps = `$p = Start-Process -FilePath ${q(exe)} -ArgumentList @('--settings', ${q('"' + settings + '"')}) -WorkingDirectory ${q(workDir)} -WindowStyle Hidden -PassThru; $p.Id`;
    try {
      const starter = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let outText = '';
      starter.stdout?.on('data', (c) => { outText += c; });
      starter.on?.('close', () => {
        pid = Number(String(outText).trim()) || null;
        if (!pid) finish(null);
        else if (done) kill(); // finished (timeout) before the PID came back
      });
      starter.on?.('error', () => finish(null));
    } catch {
      finish(null);
      return;
    }
    poll = setInterval(() => {
      const snap = readSnapshot(out);
      if (snap && Number(snap.checkedAt) >= started) finish(poolsToGroups(snap));
    }, 400);
    timer = setTimeout(() => finish(null), timeoutMs);
  }).finally(() => { running = null; });
  return running;
}

module.exports = { readAgyLive, poolsToGroups, readSnapshot };
