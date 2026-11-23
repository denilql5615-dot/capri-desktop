#!/usr/bin/env node
'use strict';

// 2.8: Claude Code's status line. Claude Code pipes a JSON with its plan limits (rate_limits) to this script
// after each turn; we keep only the numbers for Capri's limit bars and print a short line for the terminal.
// Written to ~/.capri/quota/claude-statusline.json (the home folder, not %APPDATA%: Claude's desktop app sees
// a redirected copy of %APPDATA%). Only percentages and reset times are stored — no prompts, no paths, no ids.

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.homedir(), '.capri', 'quota', 'claude-statusline.json');

function pick(limit) {
  if (!limit || typeof limit !== 'object') return null;
  const used = Number(limit.used_percentage);
  if (!Number.isFinite(used)) return null;
  const resetsAt = Number(limit.resets_at);
  return { used: Math.max(0, Math.min(100, used)), resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

function snapshot(input) {
  const rl = input?.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const windows = {};
  for (const [key, val] of Object.entries(rl)) {
    if (!/^(?:five_hour|seven_day(?:_[a-z_]+)?)$/.test(key)) continue;
    const w = pick(val);
    if (w) windows[key] = w;
  }
  return Object.keys(windows).length ? { checkedAt: Date.now(), windows } : null;
}

function line(snap) {
  if (!snap) return '';
  const f = snap.windows.five_hour;
  const w = snap.windows.seven_day;
  return [f ? `5ч ${Math.round(100 - f.used)}%` : '', w ? `нед ${Math.round(100 - w.used)}%` : ''].filter(Boolean).join(' · ');
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let snap = null;
    try { snap = snapshot(JSON.parse(raw)); } catch {}
    if (snap) {
      try {
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        const tmp = `${OUT}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(snap), 'utf8');
        fs.renameSync(tmp, OUT);
      } catch {}
    }
    process.stdout.write(line(snap));
  });
}

module.exports = { snapshot, line, OUT };
