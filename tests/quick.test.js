'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  isQuick, isQuickMail, isQuickReminders, isQuickMusic, isQuickPcStatus, isQuickAgentsStatus,
  scheduleAnswer, remindersAnswer, mailAnswer, musicNowAnswer, pcStatusAnswer, agentsStatusAnswer,
} = require('../src/main/quick');
const { videoGraph } = require('../src/main/comfy');

test('isQuick: plain questions about the schedule', () => {
  for (const q of ['что у меня завтра?', 'Что у меня сегодня', 'какие планы на неделю', 'а какие у меня встречи в пятницу?',
    'расписание на завтра', 'я свободен в субботу?', 'Капри, что у меня послезавтра?', 'покажи мои планы']) {
    assert.ok(isQuick(q), q);
  }
});

test('isQuick: anything more goes to her model', () => {
  for (const q of ['перенеси встречу на завтра', 'что у меня завтра и почему так много', 'добавь встречу в пятницу',
    'какие планы на неделю, посоветуй что убрать', 'что у меня завтра? напомни в 9', 'как дела?', 'what do I have tomorrow',
    'что у меня с настроением, сама не пойму, но вот вчера было так плохо и я не знаю что делать дальше вообще']) {
    assert.ok(!isQuick(q), q);
  }
});

const day = (d, h, m = 0) => new Date(2026, 10, d, h, m);

test('scheduleAnswer: one day, in time order, calendar and planner together', () => {
  const now = day(4, 9);
  const out = scheduleAnswer({
    now, from: day(5, 0), to: day(6, 0),
    events: [{ start: day(5, 15).toISOString(), title: 'Созвон с Лёшей', location: 'Zoom' }],
    plans: [{ kind: 'task', title: 'Сдать отчёт', due: day(5, 10).getTime(), status: 'open' },
      { kind: 'note', title: 'не показывать', createdAt: day(5, 11).getTime() }],
  });
  assert.match(out, /^Завтра у тебя 2 дела:/);
  assert.ok(out.indexOf('Сдать отчёт') < out.indexOf('Созвон с Лёшей'));
  assert.match(out, /10:00 — задача: Сдать отчёт/);
  assert.match(out, /15:00 — Созвон с Лёшей \(Zoom\)/);
  assert.ok(!out.includes('не показывать'));
});

test('scheduleAnswer: nothing there, said plainly; a week names the days', () => {
  assert.strictEqual(scheduleAnswer({ now: day(4, 9), from: day(4, 0), to: day(5, 0) }), 'Сегодня у тебя ничего не запланировано. Свободен.');
  const week = scheduleAnswer({ now: day(4, 9), from: day(4, 0), to: day(11, 0),
    plans: [{ kind: 'reminder', title: 'Позвонить маме', at: day(7, 18).getTime(), status: 'open' }] });
  assert.match(week, /^На ближайшей неделе у тебя одно дело:/);
  assert.match(week, /напоминание: Позвонить маме/);
});

test('scheduleAnswer: a long list is cut, the rest counted', () => {
  const plans = Array.from({ length: 11 }, (_, i) => ({ kind: 'task', title: `дело ${i}`, due: day(5, 8 + i).getTime(), status: 'open' }));
  const out = scheduleAnswer({ now: day(4, 9), from: day(5, 0), to: day(6, 0), plans });
  assert.match(out, /^Завтра у тебя 11 дел:/);
  assert.match(out, /…и ещё 3\.$/);
});

test('isQuickMail and mailAnswer: instant unread/recent email summary without LLM', () => {
  for (const q of ['что пришло на почту?', 'что там в почте', 'есть новые письма?', 'проверь почту', 'покажи последние письма']) {
    assert.ok(isQuickMail(q), q);
  }
  assert.ok(!isQuickMail('напиши письмо и отправь на почту'));
  assert.match(mailAnswer([]), /пусто/);
  const unread = mailAnswer([
    { from: '"Proton Team" <no-reply@proton.me>', subject: 'Счёт оплачен', unread: true },
    { from: 'old@example.com', subject: 'Старое письмо', unread: false },
  ]);
  assert.match(unread, /Непрочитанных писем: 1/);
  assert.match(unread, /Proton Team — Счёт оплачен/);
  assert.ok(!unread.includes('Старое письмо'));
});

test('isQuickReminders and remindersAnswer: active reminders from config and planner', () => {
  assert.ok(isQuickReminders('какие у меня напоминания?'));
  assert.ok(isQuick('покажи напоминания'));
  assert.strictEqual(remindersAnswer({ reminders: [], plans: [] }), 'Активных напоминаний сейчас нет.');
  const out = remindersAnswer({
    reminders: [{ id: 'r1', text: 'Позвонить', at: day(5, 14).getTime() }],
    plans: [{ id: 'p2', kind: 'reminder', title: 'Второе', at: day(5, 16).getTime(), status: 'open' }],
  });
  assert.match(out, /^У тебя 2 напоминания:/);
  assert.match(out, /Позвонить/);
  assert.match(out, /Второе/);
});

test('isQuickMusic, musicNowAnswer, and fast Wan 2.1 FP8 videoGraph', () => {
  for (const q of ['что сейчас играет?', 'какой трек играет?', 'какая песня играет', 'что поёт?']) {
    assert.ok(isQuickMusic(q), q);
  }
  assert.strictEqual(musicNowAnswer(null), 'Сейчас ни один плеер (Riff, AIMP, Spotify) не запущен.');
  assert.strictEqual(musicNowAnswer({ player: 'AIMP', track: 'Perturbator — Future Club', playing: true }), 'Сейчас в AIMP играет: Perturbator — Future Club.');
  assert.strictEqual(musicNowAnswer({ player: 'Spotify', track: null, playing: false }), 'Spotify открыт, но сейчас на паузе.');

  const g = videoGraph({ prompt: 'waving', image: 'test.png' });
  assert.strictEqual(g[1].inputs.weight_dtype, 'fp8_e4m3fn_fast');
  assert.strictEqual(g[9].inputs.steps, 20);
  assert.strictEqual(g[12].inputs.crf, 18);
});

test('isQuickPcStatus, pcStatusAnswer, isQuickAgentsStatus, and agentsStatusAnswer', () => {
  for (const q of ['сколько места на диске?', 'сколько оперативки занято', 'какой у меня ip?', 'статус пк', 'состояние системы']) {
    assert.ok(isQuickPcStatus(q), q);
  }
  const pc = pcStatusAnswer({
    disks: [{ drive: 'C:', free: 80 * (1024 ** 3), total: 200 * (1024 ** 3) }],
    ram: { used: 16 * (1024 ** 3), total: 32 * (1024 ** 3) },
    battery: { percent: 95, charging: true },
    ip: '192.168.1.50',
  });
  assert.match(pc, /C: свободно 80 ГБ из 200 ГБ/);
  assert.match(pc, /ОЗУ: занято 16 из 32 ГБ \(50%\)/);
  assert.match(pc, /Батарея: 95% \(на зарядке\)/);
  assert.match(pc, /Локальный IP: 192\.168\.1\.50/);

  for (const q of ['что там в хабе?', 'кто сейчас работает в хабе?', 'какие задачи в работе?', 'статус агентов']) {
    assert.ok(isQuickAgentsStatus(q), q);
  }
  assert.match(agentsStatusAnswer([{ agent: 'codex', title: 'Сборка APK', busy: true, queued: false }]), /В работе \(codex\): Сборка APK/);
  assert.match(agentsStatusAnswer([{ agent: 'claude', title: 'Прошлый чат', busy: false, queued: false }]), /активных задач нет/);
});
