#!/usr/bin/env node
'use strict';

// 2.8b: Antigravity CLI's status line. A short hidden `agy` start (quota-agy.js) passes this script as its
// status line for that one session (--settings, never saved): agy pipes a JSON with its quota pools, we keep
// only remaining fractions and reset times in ~/.capri/quota/agy-statusline.json.
// Pools: gemini-5h / gemini-weekly (Carbon, Neon, Hydrogen, Argon, Flash),
// 3p-5h / 3p-weekly (Claude Opus/Sonnet and GPT inside Antigravity).

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.homedir(), '.capri', 'quota', 'agy-statusline.json');
const KEYS = ['gemini-5h', 'gemini-weekly', 'gemini-argon-wtu-weekly', '3p-5h', '3p-weekly'];

function snapshot(input) {
  const quota = input?.quota;
  if (!quota || typeof quota !== 'object') return null;
  const pools = {};
  for (const key of KEYS) {
    const e = quota[key];
    const fraction = e?.remaining_fraction;
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
    // reset_time is ISO ("2026-11-23T18:08:19Z"); reset_in_seconds is the fallback
    let resetTime = Date.parse(String(e?.reset_time || ''));
    if (!Number.isFinite(resetTime) && Number.isFinite(e.reset_in_seconds) && e.reset_in_seconds >= 0) resetTime = Date.now() + e.reset_in_seconds * 1000;
    pools[key] = { remainingFraction: fraction, resetTime: Number.isFinite(resetTime) ? resetTime : null, disabled: e?.disabled === true };
  }
  return Object.keys(pools).length ? { checkedAt: Date.now(), pools } : null;
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
        fs.writeFileSync(`${OUT}.tmp`, JSON.stringify(snap), 'utf8');
        fs.renameSync(`${OUT}.tmp`, OUT);
      } catch {}
    }
    const g = snap?.pools?.['gemini-5h'];
    process.stdout.write(g ? `agy ${Math.round(g.remainingFraction * 100)}%` : '');
  });
}

module.exports = { snapshot, OUT, KEYS };
