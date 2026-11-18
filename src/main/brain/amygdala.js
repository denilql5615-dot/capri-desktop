'use strict';

// Pure, stateless salience and explicit-verdict classifier for local chat shadow turns.
// Operates on a bounded slice (<= 1500 chars) after stripping code blocks and URLs. No I/O or memory.

const MAX_SALIENCE_CHARS = 1500;
const MAX_VERDICT_CHARS = 60;
const URGENCY_THRESHOLD = 0.60;
const CONTRADICTION_THRESHOLD = 0.60;
const UNCERTAINTY_THRESHOLD = 0.60;
const NOVELTY_THRESHOLD = 0.60;

const TECH_ABBREVS = new Set([
  'API', 'CPU', 'GPU', 'RAM', 'IPC', 'URL', 'MCP', 'UTC', 'SSD', 'SQL', 'PDF',
  'HTTP', 'HTTPS', 'JSON', 'HTML', 'REST', 'LLM', 'VRAM', 'CLI', 'GUI', 'PID',
  'RSS', 'RPE', 'DNS', 'TLS', 'VPN', 'DOM', 'EOF', 'UTF', 'USB',
]);

// Strip fenced/inline code and URLs before lexical scanning so technical tokens never trigger rules.
function stripCodeAndUrls(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .slice(0, MAX_SALIENCE_CHARS)
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ');
}

const w = (body) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, 'iu');

const RE_URGENT = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?<!(?<![\\p{L}\\p{N}_])(?:не|not)\\s+)(?:срочно|немедленно|прямо\\s+сейчас|бегом|горит|дедлайн|через\\s+\\d+\\s+мин(?:\\.|ут[ауы]?)?|до\\s+\\d{1,2}:\\d{2}|urgent|asap|right\\s+now|immediately|deadline|emergency)(?![\\p{L}\\p{N}_])`,
  'iu',
);
const RE_FAILURE_NOW = w('упал[аои]?|падает|сломал(?:ось|ась|ся)|сломано|не\\s+работает|краш(?:ится|нулось|нулся)?|авария|зависл[аои]?|crashed|down|failing|broken');
const RE_STOP = w('останови|стой|прекрати|отмена|abort|stop');
const RE_ANTI_URGENT = w('не\\s+срочно|без\\s+спешки|не\\s+торопись|когда\\s+будет\\s+время|потом|на\\s+завтра|not\\s+urgent|no\\s+rush|whenever|later');
const RE_PAST_THEORY = w('вчера|на\\s+прошлой\\s+неделе|что\\s+такое|как\\s+работает|объясни|в\\s+теории|yesterday|last\\s+week|what\\s+is|in\\s+theory');

// A bare leading "нет" counts only as a standalone reply ("нет, …", "нет!"), not "нет звука, почему?".
const RE_CORRECTION_START = /^\s*(?:нет(?=\s*(?:$|[,!.:—–-]))|(?:не\s+так|не\s+то|неверно|неправильно|опять\s+не)(?=$|[,!.:\s]))/iu;
const RE_CORRECTION_BODY = w("ты\\s+ошибл(?:ась|ся)|ты\\s+перепутал[аи]?|в\\s+прошлый\\s+раз\\s+ты\\s+говорил[аи]?|не\\s+работает\\s+то,\\s*что\\s+ты\\s+дал[аи]?|противоречит|не\\s+сходится|that's\\s+wrong|that\\s+is\\s+wrong|incorrect|you're\\s+wrong|you\\s+are\\s+wrong|contradicts|not\\s+what\\s+i\\s+asked|doesn't\\s+match|does\\s+not\\s+match");
const RE_EXPECTATION_MISMATCH = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:ожидал[аи]?\\s+[^\\n]{1,120}\\s+но|должно\\s+быть\\s+[^\\n]{1,120}\\s+но|раньше\\s+[^\\n]{1,120}\\s+а\\s+сейчас|expected\\s+[^\\n]{1,120}\\s+but|should\\s+be\\s+[^\\n]{1,120}\\s+but)(?![\\p{L}\\p{N}_])`,
  'iu',
);
const RE_POLITE_TRANSITION = w('нет,\\s*спасибо|не\\s+надо|не\\s+важно|неважно|нет\\s+проблем|да,\\s*но\\s+теперь|ок,\\s*а|no\\s+thanks|never\\s*mind|no\\s+problem|got\\s+it,\\s*now');

const UNCERTAINTY_PATTERNS = [
  w('не\\s+уверен[аы]?|сомневаюсь|точно\\s+ли|насколько\\s+это\\s+точно'),
  w('(?:приведи|укажи|дай|проверь|подтверди)\\s+источник(?:ом|и|ами)?'),
  w('откуда\\s+(?:эт[оа]\\s+)?информация|откуда\\s+это|докажи'),
  w('not\\s+sure|uncertain|verify\\s+source|cite\\s+source|citation|double-?check|is\\s+that\\s+accurate'),
];
const UNCERTAINTY_DAMPEN_PATTERNS = [
  w('не\\s+срочно|простым\\s+языком|перечитай\\s+условие|напомни|вчера\\s+обсуждали|как\\s+обычно|просто\\s+расскажи'),
  w('no\\s+rush|in\\s+simple\\s+terms|re-?read\\s+the\\s+prompt|as\\s+usual'),
];
const NOVELTY_PATTERNS = [
  w('впервые|с\\s+нуля|нов(?:ый|ая|ое)\\s+(?:проект|стек|задач[аи])|раньше\\s+не\\s+(?:делал|пользовал(?:ся|ась)|настраивал)|никогда\\s+не\\s+пробовал[аи]?|переходим\\s+на|незнаком(?:ая|ый|ое)\\s+технологи(?:я|и)'),
  w('first\\s+time|from\\s+scratch|brand\\s+new|never\\s+used|migrating\\s+to|unfamiliar\\s+with'),
];

function scoreUncertainty(cleaned) {
  let matched = false;
  for (const re of UNCERTAINTY_PATTERNS) {
    if (re.test(cleaned)) {
      matched = true;
      break;
    }
  }
  if (!matched) return 0;
  let damp = 0;
  for (const re of UNCERTAINTY_DAMPEN_PATTERNS) {
    if (re.test(cleaned)) {
      damp = 0.55;
      break;
    }
  }
  return clip01(0.75 - damp);
}

function scoreNovelty(cleaned) {
  for (const re of NOVELTY_PATTERNS) {
    if (re.test(cleaned)) return 0.75;
  }
  return 0;
}

const RE_POSITIVE_VERDICT = /^(?:(?:да|ок|yes)[,.\s]+)?(?:всё\s+)?(?:верно|правильно|сработало|помогло|работает|именно\s+то|correct|it\s+worked|that\s+worked)[!.\s]*$/iu;
const RE_NEGATIVE_VERDICT = /^(?:(?:нет|no)[,.\s]+)?(?:нет[,.\s]+ошибка|неверно|неправильно|не\s+сработало|не\s+помогло|не\s+то|ты\s+ошиблась|сломано|wrong|didn't\s+work|did\s+not\s+work|not\s+it)[!.\s]*$/iu;

function hasBurstSignal(cleaned) {
  if (/!!+/.test(cleaned)) return 1;
  const words = (cleaned.match(/\p{L}{3,}/gu) || []).filter((tok) => !TECH_ABBREVS.has(tok.toUpperCase()));
  if (words.length < 3) return 0;
  let caps = 0;
  for (const tok of words) {
    if (tok === tok.toLocaleUpperCase('ru') && tok !== tok.toLocaleLowerCase('ru')) caps++;
  }
  return caps / words.length >= 0.5 ? 1 : 0;
}

const clip01 = (x) => Math.max(0, Math.min(1, x));

function salience(text) {
  const cleaned = stripCodeAndUrls(text);
  if (!cleaned) return { urgency: 0, contradiction: 0, novelty: 0, uncertainty: 0 };

  const hasUrgentWord = Number(RE_URGENT.test(cleaned));
  const hasFailureNow = Number(RE_FAILURE_NOW.test(cleaned));
  const hasStop = Number(RE_STOP.test(cleaned));
  const hasBurst = hasBurstSignal(cleaned);
  const hasAntiUrgent = Number(RE_ANTI_URGENT.test(cleaned));
  const isPastOrTheory = Number(RE_PAST_THEORY.test(cleaned));
  const sUrg = clip01(
    0.65 * hasUrgentWord + 0.45 * hasFailureNow + 0.50 * hasStop + 0.25 * hasBurst
    - 0.55 * hasAntiUrgent - 0.45 * isPastOrTheory,
  );

  const hasDirectCorrection = Number(RE_CORRECTION_START.test(cleaned) || RE_CORRECTION_BODY.test(cleaned));
  const hasExpectationMismatch = Number(RE_EXPECTATION_MISMATCH.test(cleaned));
  const hasPoliteOrTransition = Number(RE_POLITE_TRANSITION.test(cleaned));
  const sCon = clip01(0.70 * hasDirectCorrection + 0.50 * hasExpectationMismatch - 0.60 * hasPoliteOrTransition);
  const sUnc = scoreUncertainty(cleaned);
  const sNov = scoreNovelty(cleaned);

  return {
    urgency: sUrg >= URGENCY_THRESHOLD ? 1 : 0,
    contradiction: sCon >= CONTRADICTION_THRESHOLD ? 1 : 0,
    novelty: sNov >= NOVELTY_THRESHOLD ? 1 : 0,
    uncertainty: sUnc >= UNCERTAINTY_THRESHOLD ? 1 : 0,
  };
}

function verdictOf(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_VERDICT_CHARS || trimmed.includes('?')) return null;
  if (RE_POSITIVE_VERDICT.test(trimmed)) return 1;
  if (RE_NEGATIVE_VERDICT.test(trimmed)) return -1;
  return null;
}

module.exports = { salience, verdictOf, stripCodeAndUrls };
