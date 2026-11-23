// Agreed remaining-quota scale (2026-11-24), shared with Android CloudQuotas.kt.
// Thresholds raise the colour at 80, 50, 30, 15 and 5; missing data is its own level.
export function quotaLevel(remaining) {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return 'unknown';
  if (remaining >= 80) return 'green';
  if (remaining >= 50) return 'blue';
  if (remaining >= 30) return 'yellow';
  if (remaining >= 15) return 'orange';
  if (remaining >= 5) return 'red';
  return 'bordeaux';
}

// Quota group / agent id → logo key in brand-logos.js. Antigravity-hosted Opus/Sonnet keep the Antigravity mark.
export function quotaBrand(id) {
  if (id === 'claude' || id === 'codex') return id;
  if (id === 'web-gemini' || id === 'gemini-web') return 'gemini';
  if (/^agy|^antigravity$|^gemini$/.test(String(id || ''))) return 'antigravity';
  return '';
}
