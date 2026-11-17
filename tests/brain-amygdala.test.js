'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { salience, verdictOf } = require('../src/main/brain/amygdala');

test('salience urgency: detects genuine urgency and damps anti-urgent, past/theory, polite fast, and abbreviations', () => {
  // Project examples 1 and 3
  assert.deepEqual(
    salience('Слушай, у меня всё упало прямо сейчас, сборка крашится, срочно помоги!'),
    { urgency: 1, contradiction: 0, novelty: 0, uncertainty: 0 },
  );
  assert.deepEqual(
    salience('Почему вчера упала программа? Можешь объяснить простым языком, не срочно.'),
    { urgency: 0, contradiction: 0, novelty: 0, uncertainty: 0 },
  );

  // Positive RU/EN cases
  assert.equal(salience('Дедлайн через 10 мин, всё зависло!!').urgency, 1);
  assert.equal(salience('Urgent: service crashed and is down right now').urgency, 1);
  assert.equal(salience('Останови!!').urgency, 1);
  assert.equal(salience('ВСЁ УПАЛО И НЕ РАБОТАЕТ ПОМОГИ').urgency, 1);

  // Negative & damped cases
  assert.equal(salience('Быстро подскажи, пожалуйста').urgency, 0);
  assert.equal(salience('Упало, но не срочно!! Посмотри потом, когда будет время').urgency, 0);
  assert.equal(salience('Что такое deadline в Go и как работает аварийная остановка?').urgency, 0);
  assert.equal(salience('Yesterday the build crashed, explain in theory, no rush').urgency, 0);
  assert.equal(salience('Проверь API CPU GPU RAM IPC URL MCP UTC SSD SQL').urgency, 0);
});

test('salience contradiction: detects direct corrections and damps polite transitions and ordinary negations', () => {
  // Project example 2
  assert.deepEqual(
    salience('Нет, ты ошиблась, это совсем не то, что я просил — перечитай условие.'),
    { urgency: 0, contradiction: 1, novelty: 0, uncertainty: 0 },
  );

  // Positive RU/EN cases
  assert.equal(salience('Неверно, тут другая формула.').contradiction, 1);
  assert.equal(salience('Не так: ты перепутала имена файлов.').contradiction, 1);
  assert.equal(salience('Ожидал список файлов, но в ответе это не сходится.').contradiction, 1);
  assert.equal(salience('That is incorrect and contradicts the config.').contradiction, 1);
  assert.equal(salience("No, you're wrong, it doesn't match what I asked.").contradiction, 1);

  // Damping and non-contradiction cases
  assert.equal(salience('Нет, спасибо, теперь открой почту').contradiction, 0);
  assert.equal(salience('No thanks, never mind').contradiction, 0);
  assert.equal(salience('Не надо, всё хорошо').contradiction, 0);
  assert.equal(salience('Почему нет звука?').contradiction, 0);
  assert.equal(salience('Почему код не запускается?').contradiction, 0);
  assert.equal(salience('Как настроить сеть?').contradiction, 0);
});

test('salience strips fenced/inline code blocks, URLs, and ignores tail past 1500 chars', () => {
  const codeText = 'Посмотри:\n```js\nif (deadline) abort(); // urgent crashed ты ошиблась\n```\nВсё хорошо.';
  assert.deepEqual(salience(codeText), { urgency: 0, contradiction: 0, novelty: 0, uncertainty: 0 });

  const inlineAndUrl = 'Глянь `that\'s wrong` и https://example.com/urgent/crashed/error?stop=1 или www.test.invalid/deadline';
  assert.deepEqual(salience(inlineAndUrl), { urgency: 0, contradiction: 0, novelty: 0, uncertainty: 0 });

  const longText = `${'обычный текст '.repeat(120)}срочно упало!! нет, ты ошиблась!`;
  assert.ok(longText.length > 1500);
  assert.deepEqual(salience(longText), { urgency: 0, contradiction: 0, novelty: 0, uncertainty: 0 });
});

test('verdictOf classifies strict short verdicts, rejects praise, questions, and long phrases', () => {
  for (const pos of ['верно', 'правильно!', 'сработало', 'помогло.', 'работает', 'именно то', 'да, верно', 'correct', 'it worked!', 'that worked']) {
    assert.equal(verdictOf(pos), 1, pos);
  }
  for (const neg of ['неверно', 'неправильно!', 'не сработало', 'не помогло', 'не то', 'ты ошиблась', 'сломано', 'нет, не то', 'нет, ошибка', 'wrong', "didn't work", 'not it']) {
    assert.equal(verdictOf(neg), -1, neg);
  }
  for (const neutral of [
    '',
    '   ',
    'спасибо',
    'спасибо!',
    'молодец',
    'отлично',
    'да',
    'нет',
    'ошибка',
    'верно?',
    'не сработало?',
    'верно, но теперь открой пожалуйста почту и проверь письма за прошлую неделю',
    'верно всё было сделано вчера вечером когда мы тестировали новый модуль целиком',
  ]) {
    assert.equal(verdictOf(neutral), null, neutral);
  }
});

test('a leading "нет" inside an ordinary question is not a correction', () => {
  const { salience } = require('../src/main/brain/amygdala');
  for (const t of ['Нет звука, почему?', 'нет интернета на ноуте', 'Нет ли у тебя идей?']) assert.equal(salience(t).contradiction, 0, t);
  for (const t of ['нет, это неправильно', 'Нет!', 'нет. не то', 'не так, я просил другое']) assert.equal(salience(t).contradiction, 1, t);
});
