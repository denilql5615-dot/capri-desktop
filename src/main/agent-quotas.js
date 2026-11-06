'use strict';

const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

function quotaGroup(agent, model) {
  if (agent !== 'gemini') return agent;
  if (/^gemini-4-argon(?:-|$)/.test(model)) return 'agy-argon';
  if (/^gemini-/.test(model)) return 'agy-gemini';
  return 'agy-third-party';
}

function normalizeWindow(remaining, minutes, resetsAt) {
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100 || !Number.isFinite(minutes) || minutes <= 0) return null;
  return { remaining, minutes, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

function codexWindows(result) {
  const source = result?.rateLimitsByLimitId?.codex || result?.rateLimits;
  return [source?.primary, source?.secondary].filter(Boolean)
    .filter(({ usedPercent }) => Number.isFinite(usedPercent))
    .map(({ usedPercent, windowDurationMins, resetsAt }) => normalizeWindow(100 - usedPercent, windowDurationMins, resetsAt))
    .filter(Boolean);
}

function claudeWindow(event) {
  const info = event?.type === 'rate_limit_event' ? event.rate_limit_info : null;
  if (!info) return null;
  const scope = /^seven_day_(opus|sonnet|haiku)$/.exec(info.rateLimitType)?.[1] || null;
  const minutes = info.rateLimitType === 'five_hour' ? 300 : info.rateLimitType === 'seven_day' || scope ? 10080 : 0;
  const remaining = info.status === 'rejected' ? 0 : Number.isFinite(info.utilization) ? 100 * (1 - info.utilization) : NaN;
  const window = normalizeWindow(remaining, minutes, info.resetsAt);
  return window && { ...window, scope };
}

function readCodexQuota(exe) {
  if (!exe) return Promise.resolve([]);
  return new Promise((resolve) => {
    const child = spawn(exe, ['app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (windows = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      resolve(windows);
    };
    const timer = setTimeout(finish, 8000);
    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
    child.on('error', () => finish());
    child.on('exit', () => finish());
    child.stdin.on('error', () => finish());
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        if (message.error) return finish();
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read' });
      } else if (message.id === 2) {
        finish(codexWindows(message.result));
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'capri_hub', version: '1.0' } } });
  });
}

module.exports = { quotaGroup, normalizeWindow, codexWindows, claudeWindow, readCodexQuota };
