'use strict';

// Offline / pluggable evaluator on the 70-phrase reference set for E4B verdict judge.
// Never contacts Ollama unless invoked manually with `--live` or an explicit `callModel` function.
const fs = require('node:fs');
const path = require('node:path');
const { verdictOf } = require('../src/main/brain/amygdala');
const { CLASSES, createVerdictJudge } = require('../src/main/brain/verdict-judge');

const FIXTURE_PATH = path.join(__dirname, '..', 'tests', 'fixtures', 'brain-judge-set.json');

function loadJudgeDataset(file = FIXTURE_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function createStubModel(dataset) {
  const byReply = new Map(dataset.cases.map((c) => [`<reply>${c.text.trim().slice(0, 160)}</reply>`, c.expected]));
  return async ({ messages }) => {
    const userContent = String(messages.at(-1)?.content || '');
    const v = byReply.get(userContent) || 'NONE';
    return JSON.stringify({ v });
  };
}

function emptyConfusion() {
  return Object.fromEntries(
    CLASSES.map((expected) => [expected, Object.fromEntries(CLASSES.map((actual) => [actual, 0]))]),
  );
}

async function runJudgeEval({ dataset = loadJudgeDataset(), callModel } = {}) {
  const mode = typeof callModel === 'function' ? 'injected' : 'stub';
  const modelFn = callModel || createStubModel(dataset);
  const judge = createVerdictJudge({
    callModel: modelFn,
    maxPerMinute: Infinity,
    maxMinusPer10Min: Infinity,
    maxConsecutiveErrors: Infinity,
  });

  const confusion = emptyConfusion();
  const mismatches = [];
  let correct = 0;
  let dictExplicitTotal = 0;
  let dictAgree = 0;
  let dictInversions = 0;

  for (const item of dataset.cases) {
    const dictVerdict = verdictOf(item.text);
    const res = await judge.judge(item.text, { dictVerdict });
    const actual = res.status === 'ok' && res.verdict ? res.verdict : 'NONE';
    confusion[item.expected][actual]++;
    if (actual === item.expected) correct++;
    else mismatches.push({ id: item.id, expected: item.expected, actual, dictVerdict });

    if (dictVerdict === 1 || dictVerdict === -1) {
      dictExplicitTotal++;
      if ((dictVerdict === 1 && actual === 'PLUS') || (dictVerdict === -1 && actual === 'MINUS')) {
        dictAgree++;
      } else if ((dictVerdict === 1 && actual === 'MINUS') || (dictVerdict === -1 && actual === 'PLUS')) {
        dictInversions++;
      }
    }
  }

  const total = dataset.cases.length;
  const countOf = (cls) => dataset.cases.filter((c) => c.expected === cls).length;
  const plusTotal = countOf('PLUS') || 1;
  const minusTotal = countOf('MINUS') || 1;
  const noneTotal = countOf('NONE') || 1;
  const clarifyTotal = countOf('CLARIFY') || 1;

  const round4 = (n) => Math.round(n * 10000) / 10000;
  const accuracy = round4(correct / (total || 1));
  const dictAgreementRate = dictExplicitTotal ? round4(dictAgree / dictExplicitTotal) : null;
  const falseMinusOnNone = round4(confusion.NONE.MINUS / noneTotal);
  const falseMinusOnClarify = round4(confusion.CLARIFY.MINUS / clarifyTotal);
  const clarifyRecall = round4(confusion.CLARIFY.CLARIFY / clarifyTotal);
  const falsePlusOnNone = round4(confusion.NONE.PLUS / noneTotal);

  const gates = {
    accuracy_ge_88pct: accuracy >= 0.88,
    dict_agree_ge_95pct_no_invert: (dictExplicitTotal === 0 || dictAgreementRate >= 0.95) && dictInversions === 0,
    false_minus_on_none_le_5pct: falseMinusOnNone <= 0.05,
    false_minus_on_clarify_le_5pct: falseMinusOnClarify <= 0.05,
    clarify_recall_ge_80pct: clarifyRecall >= 0.8,
    false_plus_on_none_le_5pct: falsePlusOnNone <= 0.05,
  };
  const stats = judge.stats();

  return {
    passed: Object.values(gates).every(Boolean) && stats.errors === 0,
    mode,
    note: mode === 'stub'
      ? 'stub evaluation checks parser, prompt wiring, gates and confusion matrix only; not real E4B accuracy'
      : 'evaluated via injected/live model callback',
    total,
    correct,
    accuracy,
    gates,
    metrics: {
      plus_recall: round4(confusion.PLUS.PLUS / plusTotal),
      minus_recall: round4(confusion.MINUS.MINUS / minusTotal),
      clarify_recall: clarifyRecall,
      false_minus_on_none_rate: falseMinusOnNone,
      false_minus_on_clarify_rate: falseMinusOnClarify,
      false_plus_on_none_rate: falsePlusOnNone,
      dict_explicit_total: dictExplicitTotal,
      dict_agree: dictAgree,
      dict_agreement_rate: dictAgreementRate,
      dict_inversions: dictInversions,
    },
    confusion,
    mismatches,
    stats,
  };
}

if (require.main === module) {
  const live = process.argv.includes('--live');
  let callModel;
  if (live) {
    const ollama = require('../src/main/ollama');
    const { FAST } = require('../src/main/brains');
    callModel = (req, signal) => ollama.jsonChat({ ...req, model: FAST }, signal);
  }
  runJudgeEval({ callModel })
    .then((report) => {
      console.log(JSON.stringify({ ...report, mode: live ? 'live' : report.mode }, null, 2));
      if (!report.passed) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}

module.exports = { runJudgeEval, loadJudgeDataset, createStubModel };
