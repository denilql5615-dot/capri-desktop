'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LOCAL_CONTEXT_DEFAULTS,
  CONTEXT_LIMITS,
  estimateTokens,
  resolveContextLimit,
  getContextLimits,
  buildContextStats,
} = require('../src/main/context-stats');
const { FAST, MAIN } = require('../src/main/brains');
const ollama = require('../src/main/ollama');

test('CONTEXT_LIMITS exposes exact verified limits for local and cloud models', () => {
  assert.equal(LOCAL_CONTEXT_DEFAULTS.fast, 32768);
  assert.equal(LOCAL_CONTEXT_DEFAULTS.main, 32768);
  assert.equal(LOCAL_CONTEXT_DEFAULTS.qwen36, 32768);
  assert.equal(LOCAL_CONTEXT_DEFAULTS.aux, 16384);

  assert.equal(CONTEXT_LIMITS.e4b, 32768);
  assert.equal(CONTEXT_LIMITS['26b'], 32768);
  assert.equal(CONTEXT_LIMITS[FAST], 32768);
  assert.equal(CONTEXT_LIMITS[MAIN], 32768);
  assert.equal(CONTEXT_LIMITS.qwen36, 32768);
  assert.equal(CONTEXT_LIMITS.qwen38, 16384);
  assert.equal(CONTEXT_LIMITS['capri-qwen36-heretic:latest'], 32768);
  assert.equal(CONTEXT_LIMITS['capri-qwen38-heretic:latest'], 16384);

  // Codex (~/.codex/models_cache.json)
  assert.equal(CONTEXT_LIMITS['gpt-6.2-sol'], 500000);
  assert.equal(CONTEXT_LIMITS['gpt-6.2-astra'], 272000);
  assert.equal(CONTEXT_LIMITS['gpt-6.1-terra'], 500000);

  // Claude 5.5 CLI (native 1M in claude.exe 2.1.321)
  assert.equal(CONTEXT_LIMITS.opus, 1000000);
  assert.equal(CONTEXT_LIMITS.sonnet, 1000000);
  assert.equal(CONTEXT_LIMITS.haiku, 1000000);
  assert.equal(CONTEXT_LIMITS['claude-opus-5-5'], 1000000);
  assert.equal(CONTEXT_LIMITS['claude-sonnet-5-5'], 1000000);
  assert.equal(CONTEXT_LIMITS['claude-haiku-5-5'], 1000000);

  // Antigravity & Gemini Web
  assert.equal(CONTEXT_LIMITS['gemini-4-carbon-low'], 1048576);
  assert.equal(CONTEXT_LIMITS['gemini-4-carbon-medium'], 1048576);
  assert.equal(CONTEXT_LIMITS['gemini-4-carbon-high'], 1048576);
  assert.equal(CONTEXT_LIMITS['gemini-4-neon-high'], 1048576);
  assert.equal(CONTEXT_LIMITS['gemini-4-argon-high'], 1048576);
  assert.equal(CONTEXT_LIMITS['gemini-4-hydrogen-xhigh'], 1048576);
  assert.equal(CONTEXT_LIMITS['gemini-3.8-flash-high'], 1048576);
  assert.equal(CONTEXT_LIMITS['gemini-pro-orchestrator-neon'], 1048576);
  assert.equal(CONTEXT_LIMITS['gemini-pro-orchestrator-g1-pro'], 1048576);
  assert.equal(CONTEXT_LIMITS['claude-opus-5-5-medium'], 1000000);
  assert.equal(CONTEXT_LIMITS['claude-sonnet-5-5-medium'], 1000000);
  assert.equal(CONTEXT_LIMITS['orchestrator-claude-opus'], 1000000);
  assert.equal(CONTEXT_LIMITS['gemini-web-neon'], 1048576);
  assert.equal(CONTEXT_LIMITS['gemini-web-hydrogen'], 1048576);
});

test('resolveContextLimit and getContextLimits honor live ollama.ctxFor overrides', (t) => {
  const prevFast = ollama.ctxFor(FAST);
  const prevMain = ollama.ctxFor(MAIN);
  ollama.setContextFor(FAST, 24576);
  ollama.setContextFor(MAIN, 20480);
  t.after(() => {
    ollama.setContextFor(FAST, prevFast);
    ollama.setContextFor(MAIN, prevMain);
  });

  assert.equal(resolveContextLimit('e4b', 'ollama'), 24576);
  assert.equal(resolveContextLimit(FAST, 'ollama'), 24576);
  assert.equal(resolveContextLimit('26b', 'ollama'), 20480);
  assert.equal(resolveContextLimit(MAIN, 'ollama'), 20480);
  assert.equal(resolveContextLimit('hf.co/llmfan46/Qwen3.6-35B-A3B-uncensored-heretic-GGUF', 'ollama'), 32768);

  const liveMap = getContextLimits();
  assert.equal(liveMap.e4b, 24576);
  assert.equal(liveMap.auto, 24576);
  assert.equal(liveMap[FAST], 24576);
  assert.equal(liveMap['26b'], 20480);
  assert.equal(liveMap[MAIN], 20480);
  assert.equal(liveMap.qwen36, 32768);
  assert.equal(liveMap.qwen38, 16384);
});

test('estimateTokens differentiates Cyrillic (~3.2 chars/tok), Latin (~4 chars/tok), and code density', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);

  const cyrillic = 'а'.repeat(320);
  assert.equal(estimateTokens(cyrillic), 100);

  const latin = 'a'.repeat(400);
  assert.equal(estimateTokens(latin), 100);

  const code = 'const fn = (a, b) => ({ sum: a + b, ok: [1, 2, 3] });'.repeat(4);
  const plainLatin = 'a'.repeat(code.length);
  assert.ok(estimateTokens(code) > estimateTokens(plainLatin));
});

test('buildContextStats returns estimated breakdown when no actual usage is supplied', () => {
  const stats = buildContextStats({
    model: 'gpt-6.2-astra',
    provider: 'codex',
    systemPrompt: 'Ты ассистент ALTAI:RE.',
    skillsText: 'Режим caveman: кратко.',
    memoryText: 'Заметка из Obsidian по проекту HZ-1.',
    toolsText: 'Your working folder is D:\\Capri.',
    messages: [
      { role: 'user', content: 'Разбери план Блока 1.5' },
      { role: 'assistant', content: 'Готово: расчёт контекста готов.' },
    ],
  });

  assert.equal(stats.model, 'gpt-6.2-astra');
  assert.equal(stats.provider, 'codex');
  assert.equal(stats.maxTokens, 272000);
  assert.equal(stats.source, 'estimated');
  const sum = stats.breakdown.messages + stats.breakdown.systemPrompt + stats.breakdown.skills + stats.breakdown.memory + stats.breakdown.tools;
  assert.equal(stats.usedTokens, sum);
  assert.equal(stats.freeTokens, 272000 - stats.usedTokens);
  assert.equal(stats.breakdown.free, stats.freeTokens);
  assert.ok(stats.breakdown.messages > 0);
  assert.ok(stats.breakdown.systemPrompt > 0);
  assert.ok(stats.breakdown.skills > 0);
  assert.ok(stats.breakdown.memory > 0);
  assert.ok(stats.breakdown.tools > 0);
});

test('buildContextStats scales proportionally to actual prompt + eval tokens with exact integer sum', () => {
  const stats = buildContextStats({
    model: 'e4b',
    provider: 'ollama',
    maxTokens: 32768,
    systemPrompt: 'Системная инструкция '.repeat(20),
    skillsText: 'Скилл caveman '.repeat(10),
    memoryText: 'Контекст Obsidian '.repeat(15),
    toolsText: 'Инструмент PIM '.repeat(5),
    messages: [
      { role: 'user', content: 'Сообщение пользователя '.repeat(30) },
      { role: 'assistant', content: 'Ответ модели '.repeat(20) },
    ],
    actualPromptTokens: 4200,
    actualEvalTokens: 800,
  });

  assert.equal(stats.source, 'actual');
  assert.equal(stats.usedTokens, 5000);
  assert.equal(stats.freeTokens, 32768 - 5000);
  assert.equal(stats.breakdown.free, 27768);
  assert.equal(stats.percent, 15.3);
  const sum = stats.breakdown.messages + stats.breakdown.systemPrompt + stats.breakdown.skills + stats.breakdown.memory + stats.breakdown.tools;
  assert.equal(sum, 5000);
  assert.ok(stats.breakdown.messages > stats.breakdown.systemPrompt);
  assert.ok(stats.breakdown.systemPrompt > stats.breakdown.tools);
});

test('buildContextStats clamps freeTokens at 0 and percent at 100 when usage exceeds maxTokens', () => {
  const stats = buildContextStats({
    model: 'qwen36',
    provider: 'ollama',
    maxTokens: 16384,
    actualPromptTokens: 18000,
    actualEvalTokens: 1000,
  });
  assert.equal(stats.source, 'actual');
  assert.equal(stats.usedTokens, 19000);
  assert.equal(stats.freeTokens, 0);
  assert.equal(stats.breakdown.free, 0);
  assert.equal(stats.breakdown.messages, 19000);
  assert.equal(stats.percent, 100);
});
