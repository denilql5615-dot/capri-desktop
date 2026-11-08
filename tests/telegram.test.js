'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TelegramBot, eventNotice, hubNotice, LONG_MS, LONG_ACTIONS } = require('../src/main/telegram');

test('Telegram links only from a private /start and sends no incoming commands', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1);
    calls.push({ method, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, result: method === 'getUpdates' ? [
      { message: { text: '/status', chat: { id: 1, type: 'private' } } },
      { message: { text: '/start', chat: { id: 42, type: 'private' } } },
    ] : { message_id: 7 } }) };
  };
  let saved = '';
  const bot = new TelegramBot({ token: `123456:${'a'.repeat(30)}`, saveChatId: (id) => { saved = id; }, fetchImpl });
  assert.equal(await bot.link(), true);
  assert.equal(saved, '42');
  assert.equal(await bot.send('готово'), true);
  assert.deepEqual(calls.map((c) => c.method), ['getUpdates', 'sendMessage']);
  assert.deepEqual(calls[1].body, { chat_id: '42', text: 'готово' });
});

test('Telegram notices only when input is needed or a long task is done', () => {
  const sessions = new Map();
  const base = { session_id: 'codex:1', cwd: 'D:/Capri/capri-desktop' };
  assert.equal(eventNotice(sessions, { ...base, hook_event_name: 'UserPromptSubmit' }, 1000), '');
  assert.match(eventNotice(sessions, { ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Разрешить тест?' }, 2000), /Codex ждёт[\s\S]*Разрешить тест/);
  assert.equal(eventNotice(sessions, { ...base, hook_event_name: 'Stop' }, 1000 + LONG_MS - 1), '');

  eventNotice(sessions, { ...base, hook_event_name: 'UserPromptSubmit' }, 3000);
  for (let i = 0; i < LONG_ACTIONS; i += 1) eventNotice(sessions, { ...base, hook_event_name: 'PreToolUse' }, 3001 + i);
  assert.match(eventNotice(sessions, { ...base, hook_event_name: 'Stop', last_assistant_message: 'Всё готово.' }, 4000), /закончил долгую задачу[\s\S]*Всё готово/);

  const notice = hubNotice({
    agent: 'Claude Code',
    model: 'claude-sonnet-4-6',
    task: 'Собери GDD в PDF',
    text: 'Документ собран и проверен.',
    artifacts: [{ name: 'GDD.pdf' }],
  });
  assert.match(notice, /✅ \[HUB · Claude Code · claude-sonnet-4-6\] Собери GDD в PDF/);
  assert.match(notice, /📎 Файлы: GDD\.pdf/);
});

test('TelegramBot.pollCommands processes only messages from linked private chatId', async () => {
  const sent = [];
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1);
    const body = JSON.parse(options.body);
    if (method === 'getUpdates') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: [
            { update_id: 10, message: { text: '/status', chat: { id: 999, type: 'private' } } },
            { update_id: 11, message: { text: '/alta', chat: { id: 42, type: 'private' } } },
          ],
        }),
      };
    }
    sent.push(body);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const bot = new TelegramBot({ token: `123456:${'a'.repeat(30)}`, chatId: '42', fetchImpl });
  const count = await bot.pollCommands(async (text) => `Ответ на ${text}`);
  assert.equal(count, 1);
  assert.deepEqual(sent, [{ chat_id: '42', text: 'Ответ на /alta' }]);
});
