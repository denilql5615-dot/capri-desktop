'use strict';

// 2.7d: the phone's Health Connect snapshot (workouts, calories, distance, weight, HRV, SpO2) reaches the PC
// and the text the model reads.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PhoneControlEngine } = require('../src/main/phone-control-engine');
const { ConnectorsEngine } = require('../src/main/connectors-engine');

// The shape PhoneControlHub.toSyncJson() sends (0.1.73+).
const PHONE_HEALTH = {
  updatedAt: '2026-11-23T18:00:00Z',
  steps: 8421,
  sleepHours: 7.2,
  heartRate: 71,
  avgHr: 71,
  restingHr: 58,
  hrvMs: 42.5,
  spo2: 97.1,
  activeKcal: 512,
  totalKcal: 2380,
  distanceKm: 6.34,
  weightKg: 78.4,
  workouts: [
    { title: 'Бег', type: 'Бег', minutes: 35, at: '2026-11-23T07:10:00Z', kcal: 410, distanceKm: 5.2 },
    { title: 'Силовая', type: 'Силовая', minutes: 50, at: '2026-11-21T18:00:00Z' },
  ],
};

test('the phone snapshot keeps every new field and drops nonsense values', () => {
  let forwarded = null;
  const eng = new PhoneControlEngine({ onHealthSummary: (s) => { forwarded = s; } });
  eng.updateState({ deviceName: 'Xiaomi 13T Pro', healthSummary: { ...PHONE_HEALTH, spo2: 140, weightKg: -3 } });
  assert.equal(forwarded.hrvMs, 42.5);
  assert.equal(forwarded.activeKcal, 512);
  assert.equal(forwarded.totalKcal, 2380);
  assert.equal(forwarded.distanceKm, 6.34);
  assert.equal(forwarded.spo2, 100); // clamped into its range
  assert.equal(forwarded.weightKg, 20);
  assert.deepEqual(forwarded.workouts[0], { title: 'Бег', type: 'Бег', minutes: 35, kcal: 410, distanceKm: 5.2, at: '2026-11-23T07:10:00Z' });
  assert.equal(forwarded.workouts[1].kcal, null);

  // Only weight is a reading too: a snapshot with just it still counts.
  let only = null;
  new PhoneControlEngine({ onHealthSummary: (s) => { only = s; } }).updateState({ healthSummary: { weightKg: 80 } });
  assert.equal(only.weightKg, 80);
});

test('the PC stores the summary and the model reads all of it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-27d-'));
  const eng = new ConnectorsEngine({ userDataDir: dir });
  const saved = eng.saveHealthSummary(PHONE_HEALTH);
  assert.equal(saved.ok, true);
  assert.equal(saved.summary.weightKg, 78.4);
  const def = eng.findDefinition('health-connect');
  const ctx = await eng.executeReadOnlyQuery(def, 'как я восстановился');
  assert.match(ctx.text, /Шаги: 8421/);
  assert.match(ctx.text, /HRV, RMSSD\): 42\.5 мс/);
  assert.match(ctx.text, /SpO2\): 97\.1%/);
  assert.match(ctx.text, /Калории за сутки: активные 512, всего 2380 ккал/);
  assert.match(ctx.text, /Дистанция за сутки: 6\.34 км/);
  assert.match(ctx.text, /Вес \(последний замер за 30 дней\): 78\.4 кг/);
  assert.match(ctx.text, /Тренировки за 7 дней: Бег \(35 мин, 5\.2 км, 410 ккал, 2026-11-23\); Силовая \(50 мин, 2026-11-21\)/);
});
