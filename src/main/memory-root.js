'use strict';

// Approved offline NOMAD root lookup for Capri normal chat (behind default-off `memoryRootLookup`).
// Stage 1 (CPU): lexical ranking + deterministic gates (reused from the v3 pilot, read-only cards).
// Stage 2 (local resident E4B only, idle only, never warms/swaps): strict verdict + contiguous claim/quote span.
// Stage 3 (Kiwix NOMAD): verifies book, link boundary, and quote in the offline article before showing.
// Never writes to disk, Obsidian, search logs, or cloud services.

const fs = require('node:fs');
const { isIPv4 } = require('node:net');
const path = require('node:path');
const { FAST, MAIN } = require('./brains');
const kiwixDefault = require('./kiwix');
const torDefault = require('./tor');
const { hasTorSignal } = require('./tor-guard');
const { contextMentionsTor } = require('./brain/shadow-hook');

const DEFAULT_CARDS_PATH = path.join(__dirname, 'data', 'nomad-root-cards.json');
const LANG_ALIASES = Object.freeze({ en: 'eng', eng: 'eng', ru: 'rus', rus: 'rus' });

const STOPWORDS = new Set([
  'как', 'что', 'где', 'кто', 'чем', 'чего', 'кому', 'кого', 'кем', 'или', 'для', 'при', 'под', 'над', 'без', 'про',
  'за', 'на', 'по', 'из', 'от', 'до', 'об', 'со', 'во', 'ко', 'не', 'ни', 'ли', 'же', 'бы', 'да', 'но', 'то',
  'это', 'все', 'всё', 'его', 'её', 'их', 'они', 'оно', 'она', 'так', 'уже', 'еще', 'если', 'тогда', 'чтобы',
  'после', 'перед', 'между', 'через', 'около', 'почти', 'более', 'менее', 'очень', 'лишь', 'только', 'также',
  'тоже', 'либо', 'будет', 'быть', 'есть', 'было', 'были', 'является', 'являются', 'может', 'могут', 'нужно',
  'надо', 'должен', 'должна', 'должно', 'должны', 'него', 'ней', 'них', 'нем', 'одной', 'одном', 'он', 'несколько',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'where', 'which', 'how', 'who', 'why',
  'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'does', 'did', 'can', 'could', 'will', 'would',
  'should', 'into', 'onto', 'than', 'then', 'only', 'also', 'very', 'some', 'such', 'other', 'another', 'most',
  'more', 'any', 'all', 'its', 'they', 'their', 'you', 'your', 'not', 'but', 'is', 'in', 'on', 'at', 'to', 'of', 'a', 'an',
]);

const BOOK_META_TOKENS = new Set([
  'devdocs', 'en', 'ru', 'all', 'mini', 'maxi', 'nopic', 'com', 'stackexchange', 'org',
  '2025', '2026', '06', '09', '10', '11', '12',
]);

const SYNONYM_GROUPS = [
  ['параметр', 'аргумент', 'argument', 'arguments', 'param', 'parameter'],
  ['тег', 'тегов', 'элемент', 'виджет', 'tag', 'element', 'widget'],
  ['перенос', 'разрыв', 'разрывать', 'break', 'carriage'],
  ['порядок', 'последовательность', 'order', 'sequence'],
  ['подпись', 'метка', 'отметка', 'маркер', 'размечать', 'label', 'mark', 'marker'],
  ['раскрытие', 'сворачиваемый', 'раскрыть', 'disclosure', 'collapsible'],
  ['удалить', 'удалять', 'убрать', 'убирать', 'избавиться', 'избавляться', 'пропадать', 'пропадет', 'remove', 'delete', 'removing'],
  ['завершение', 'закончить', 'закончены', 'завершить', 'завершать', 'завершаться', 'done', 'finish', 'finished'],
  ['уменьшить', 'снизить', 'снижение', 'снижаться', 'сократить', 'сокращение', 'меньше', 'реже', 'reduce', 'decrease'],
  ['изменить', 'поменять', 'менять', 'изменение', 'правка', 'правки', 'перенастроить', 'change', 'modify', 'changes'],
  ['разрешать', 'разрешено', 'допускать', 'допускается', 'допустимо', 'может', 'allow', 'allows', 'permit'],
  ['возвращать', 'возврат', 'выход', 'статус', 'код', 'значение', 'return', 'status'],
  ['конвейер', 'pipeline', 'pipelines'],
  ['перенаправление', 'redirection', 'redirections'],
  ['подтягивающий', 'подтяжка', 'pullup', 'pull'],
  ['сопротивление', 'резистор', 'номинал', 'resistance', 'resistor'],
  ['напряжение', 'падение', 'voltage', 'вольт', 'милливольт'],
  ['соотношение', 'пропорция', 'баланс', 'ratio', 'ratios'],
  ['обрезка', 'срез', 'срезать', 'ветвь', 'ветка', 'побег', 'сук', 'prune', 'pruning', 'thinning', 'branch', 'shoot'],
  ['ингредиент', 'состав', 'смесь', 'компонент', 'заправка', 'mixture', 'ingredient', 'includes'],
  ['граница', 'ориентир', 'раздел', 'линия', 'boundary', 'border'],
  ['слияние', 'сливаться', 'объединение', 'соединяться', 'образовывать', 'образуют', 'возникать', 'join', 'form', 'merge'],
  ['возраст', 'история', 'лет', 'древний', 'древнейший', 'age', 'years', 'old'],
  ['отключать', 'отсоединять', 'снимать', 'выкрутить', 'disconnect', 'detach'],
  ['край', 'кончик', 'tip', 'edge'],
  ['стойка', 'stud', 'studs', 'post', 'posts'],
  ['шаг', 'расстояние', 'интервал', 'apart', 'spacing', 'distance'],
  ['влага', 'вода', 'полив', 'поливать', 'water', 'moisture'],
  ['перенести', 'переносить', 'применить', 'применять', 'отводить', 'apply', 'transfer'],
  ['основа', 'база', 'базовый', 'основной', 'главный', 'basis', 'basic'],
  ['ожидание', 'ждать', 'wait'],
  ['вызывать', 'вызвать', 'запускать', 'запустить', 'запуск', 'вызов', 'набрать', 'calling', 'call'],
  ['разбирать', 'обрабатывать', 'обрабатываться', 'обработка', 'применять', 'применяет', 'срабатывать', 'process', 'processed'],
  ['вычислять', 'вычисление', 'расчет', 'рассчитывать', 'считать', 'calculate', 'calculated'],
  ['суммарный', 'общий', 'итоговый', 'total'],
  ['обнулить', 'обнуление', 'ноль', 'нулевой', 'zero'],
  ['фиксированный', 'зафиксирован', 'жестко', 'заданы', 'fixed'],
  ['разный', 'различаться', 'отличать', 'отличие', 'одинаковый', 'одно', 'синоним', 'same', 'difference', 'contrast'],
  ['зазор', 'щель', 'crevice'],
  ['вскрытие', 'разборка', 'поддеть', 'disassembling'],
  ['дисплей', 'экран', 'lcd', 'screen'],
  ['коннектор', 'разъем', 'connector'],
  ['шлейф', 'кабель', 'ленточный', 'ribbon', 'wire'],
  ['крепеж', 'гвоздь', 'крепить', 'прибита', 'привинчивать', 'nail', 'attach', 'screwing'],
  ['опора', 'поверхность', 'плоскость', 'surface', 'mating'],
  ['лента', 'рулон', 'rolls'],
  ['всыпать', 'засыпать', 'вмешать', 'вмешивать', 'вводить', 'stir'],
  ['приготовление', 'вареный', 'варить', 'варка', 'отваривать', 'проваривать', 'готовят', 'готовки', 'cook', 'cooked'],
  ['подрумяненный', 'поджаренный', 'жарка', 'жарить', 'browned'],
  ['остаток', 'остатки', 'частица', 'частицы', 'residue'],
  ['растворять', 'dissolving', 'dissolve'],
  ['кипяток', 'кипящий', 'boiling'],
  ['химпрепараты', 'средства', 'удобрения', 'гербициды', 'fertilizers', 'herbicides'],
  ['спланированный', 'выстроенный', 'продуманный', 'грамотно', 'designed'],
  ['встроенный', 'внутренний', 'internal'],
  ['провоцировать', 'вызывать', 'спровоцированный', 'induced', 'caused'],
  ['отвертка', 'screwdriver'],
  ['миллиметр', 'мм', 'mm'],
  ['дюйм', 'дюймов', 'inch', 'inches'],
  ['микроампер', 'мка', 'µa', 'ua'],
  ['запись', 'присваивать', 'writes', 'write'],
  ['дерево', 'директория', 'worktree'],
  ['мобильный', 'телефон', 'смартфон', 'phone', 'phones'],
  ['жилой', 'дом', 'здание', 'постройка', 'residential'],
  ['материал', 'пена', 'foam'],
  ['медиатор', 'pick'],
  ['полностью', 'растопить', 'растопилось', 'melted', 'fully'],
  ['диапазон', 'предел', 'пределы', 'range'],
  ['конденсатор', 'конденсаторы', 'capacitor', 'capacitors', 'cap', 'caps'],
  ['сша', 'us'],
  ['сторона', 'слева', 'направо', 'left', 'right'],
  ['отверждение', 'отверждаться', 'полимеризация', 'полимеризоваться', 'cure', 'cures'],
  ['пахнуть', 'запах', 'odorless', 'odor', 'smell'],
  ['добавлять', 'содержать', 'включать', 'include', 'includes', 'contains'],
  ['находиться', 'расположен', 'располагаться', 'located'],
  ['кулинарный', 'кулинария', 'cooking'],
  ['возле', 'рядом', 'near'],
  ['предназначен', 'создавать', 'создает', 'выполнять', 'produces', 'produce'],
  ['страница', 'документ', 'document', 'page'],
  ['обвязка', 'брус', 'sill', 'plate'],
  ['подкоманда', 'команда', 'command'],
  ['томат', 'томаты', 'помидор', 'помидоры', 'tomato', 'tomatoes'],
  ['дефицит', 'нехватка', 'deficiency'],
  ['габариты', 'размеры', 'ширина', 'высота', 'width', 'height'],
  ['лопатка', 'спаджер', 'spudger'],
  ['коллекция', 'словарь', 'counter'],
  ['количество', 'счетчик', 'count'],
];

const RU_SUFFIXES = [
  'иями', 'ями', 'ами', 'ыми', 'ими', 'ого', 'его', 'ому', 'ему', 'ивать', 'ывать', 'овать', 'евать',
  'ться', 'ются', 'ется', 'ите', 'ешь', 'ишь', 'ать', 'ять', 'еть', 'ить', 'ыть', 'уть',
  'ых', 'их', 'ую', 'юю', 'ою', 'ею', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ый', 'ий', 'ой', 'ей',
  'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'ия', 'ья', 'ие', 'ье', 'ию', 'ью',
  'ал', 'ял', 'ил', 'ел', 'ла', 'ло', 'ли', 'ут', 'ют', 'ат', 'ят', 'ет', 'ем', 'им', 'ся', 'сь',
  'а', 'я', 'о', 'е', 'и', 'ы', 'у', 'ю', 'ь',
];

const collapseWs = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function normalizeForTokens(text) {
  return collapseWs(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/(\d+(?:\.\d+)?)\s*[-–]\s*миллиметров\p{L}*/gu, '$1 мм')
    .replace(/(\d+(?:\.\d+)?)\s*[-–]\s*сантиметров\p{L}*/gu, '$1 см')
    .replace(/(\d+(?:\.\d+)?)\s*[-–]\s*дюймов\p{L}*/gu, '$1 дюйм')
    .replace(/(\d+(?:\.\d+)?)"/g, '$1 inch');
}

function tokenize(text, { keepStopwords = false } = {}) {
  const norm = normalizeForTokens(text);
  const raw = norm.match(/\d+\.\d+|[\p{L}\p{N}]+/gu) || [];
  return raw.filter((w) => (w.length >= 2 || /^\d+$/.test(w)) && (keepStopwords || !STOPWORDS.has(w)));
}

function stem(w) {
  if (!w || /^\d+(?:\.\d+)?$/.test(w)) return w;
  if (/^[a-z]+$/.test(w)) {
    if (w.length >= 6 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
    if (w.length >= 6 && w.endsWith('ied')) return `${w.slice(0, -3)}y`;
    if (w.length >= 6 && w.endsWith('ing')) return w.slice(0, -3);
    if (w.length >= 5 && w.endsWith('ed')) return w.slice(0, -2);
    if (w.length >= 5 && w.endsWith('es')) return w.slice(0, -2);
    if (w.length >= 5 && w.endsWith('ly')) return w.slice(0, -2);
    if (w.length >= 4 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('is') && !w.endsWith('us')) return w.slice(0, -1);
    return w;
  }
  if (/^[а-я]+$/.test(w)) {
    for (const suf of RU_SUFFIXES) {
      if (w.length - suf.length >= 4 && w.endsWith(suf)) {
        return w.slice(0, -suf.length);
      }
    }
    if (w.length === 4 && /[аеиоуыяюь]$/.test(w) && !/[аеиоуыяюь]$/.test(w.slice(0, 3))) {
      return w.slice(0, 3);
    }
  }
  return w;
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function sameScript(a, b) {
  const isRuA = /^[а-я]+$/.test(a);
  const isRuB = /^[а-я]+$/.test(b);
  if (isRuA && isRuB) return true;
  const isEnA = /^[a-z]+$/.test(a);
  const isEnB = /^[a-z]+$/.test(b);
  return isEnA && isEnB;
}

function isMorphMatch(a, b) {
  if (a === b) return true;
  if (/^\d+(?:\.\d+)?$/.test(a) || /^\d+(?:\.\d+)?$/.test(b)) return a === b;
  const sa = stem(a);
  const sb = stem(b);
  if (sa === sb && (sa.length >= 4 || (sa.length === 3 && /^[а-я]+$/.test(sa)))) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 5 && Math.abs(a.length - b.length) <= 2 && sameScript(a, b)) {
    if (commonPrefixLen(a, b) >= Math.max(5, minLen - 2)) return true;
  }
  return false;
}

const SYNONYM_CACHE = new Map();

function getSynonymGroups(token) {
  if (SYNONYM_CACHE.has(token)) return SYNONYM_CACHE.get(token);
  const groups = new Set();
  for (let i = 0; i < SYNONYM_GROUPS.length; i++) {
    for (const entry of SYNONYM_GROUPS[i]) {
      if (
        token === entry
        || (Math.min(token.length, entry.length) >= 4 && isMorphMatch(token, entry))
        || (token.length <= 4 && entry.length <= 4 && stem(token) === stem(entry))
      ) {
        groups.add(i);
        break;
      }
    }
  }
  SYNONYM_CACHE.set(token, groups);
  return groups;
}

function matchStrength(qt, tokenList, tokenGroupsList) {
  let best = 0;
  const qGroups = getSynonymGroups(qt);
  for (let i = 0; i < tokenList.length; i++) {
    const ct = tokenList[i];
    if (qt === ct) return 1.0;
    if (isMorphMatch(qt, ct)) {
      if (best < 0.85) best = 0.85;
      continue;
    }
    if (qGroups.size > 0 && tokenGroupsList[i].size > 0) {
      for (const g of qGroups) {
        if (tokenGroupsList[i].has(g)) {
          if (best < 0.75) best = 0.75;
          break;
        }
      }
    }
  }
  return best;
}

function extractHardLiterals(query) {
  const norm = normalizeForTokens(query);
  const raw = collapseWs(query);
  const literals = [];
  for (const m of raw.matchAll(/(?:^|\s)(--[a-z0-9][a-z0-9-]*|-[a-z0-9])\b/gi)) {
    literals.push({ type: 'flag', value: m[1].toLowerCase() });
  }
  for (const m of raw.matchAll(/\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\b/gi)) {
    literals.push({ type: 'ident', value: m[0].toLowerCase() });
  }
  for (const m of raw.matchAll(/<([a-z0-9-]+)>|\b[a-z]+_[a-z0-9_]+\b|\b[a-z]+[A-Z][a-zA-Z0-9]*\b/g)) {
    literals.push({ type: 'ident', value: (m[1] || m[0]).toLowerCase() });
  }
  for (const m of norm.matchAll(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{3,}\b/gi)) {
    literals.push({ type: 'code', value: m[0].toLowerCase() });
  }
  for (const m of norm.matchAll(/\b(\d+(?:\.\d+)?)\s*(мм|см|м|км|дюйм\p{L}*|в|мв|кв|а|ма|мка|гц|кгц|мгц|к?ом|ч|мин|сек|°[fc]|v|mv|a|ma|mm|cm|m|hz|khz)\b/giu)) {
    literals.push({ type: 'number', value: m[1] });
  }
  for (const m of norm.matchAll(/(?:команд\p{L}*|функци\p{L}*|метод\p{L}*|декоратор\p{L}*|модул\p{L}*|алгоритм\p{L}*|ограничен\p{L}*)\s+([a-z][a-z0-9_-]{1,})\b/giu)) {
    const val = m[1].toLowerCase();
    if (!['git', 'bash', 'python', 'html', 'css', 'arduino'].includes(val)) {
      literals.push({ type: 'codeword', value: val });
    }
  }
  for (const m of norm.matchAll(/\b(maxsize|lru|pipefail|ph)\b/gi)) {
    literals.push({ type: 'codeword', value: m[1].toLowerCase() });
  }
  return literals;
}

function failsHardTokenVeto(literals, cardNormFull, cardTokensSet) {
  for (const lit of literals) {
    if (lit.type === 'flag') {
      const esc = lit.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`(?:^|[\\s(\`"'])${esc}(?=[\\s),.?\`"']|$)`, 'i').test(cardNormFull)) return true;
    } else if (lit.type === 'ident') {
      if (!cardNormFull.includes(lit.value) && !cardTokensSet.has(lit.value)) return true;
    } else if (lit.type === 'code' || lit.type === 'codeword') {
      if (!cardTokensSet.has(lit.value) && !cardNormFull.includes(lit.value)) return true;
    } else if (lit.type === 'number') {
      if (!cardTokensSet.has(lit.value)) return true;
    }
  }
  return false;
}

function passesAnswerTypeGate(query, cardFactNorm, cardFullNorm = cardFactNorm) {
  const q = normalizeForTokens(query);
  const f = cardFactNorm;
  const wbL = '(?<![\\p{L}\\p{N}])';
  const wbR = '(?![\\p{L}\\p{N}])';
  const hasNumWord = new RegExp(`${wbL}(?:один|одна|одно|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|ноль|one|two|three|four|five|zero)${wbR}`, 'iu');

  if (/(?:^|\s)(?:какой|каким|какая|какую|с\s+каким)\s+(?:\S+\s+){0,2}(?:флаг\p{L}*|опци\p{L}*|ключ\p{L}*|параметр\p{L}*)/iu.test(q)) {
    if (!new RegExp(`(?:--[a-z0-9-]+|(?:^|[\\s(\`"'])-[a-z0-9](?=[\\s),.?"'\`]|$)|${wbL}(?:флаг\\p{L}*|опци\\p{L}*|ключ\\p{L}*|option|flag)${wbR})`, 'iu').test(f)) {
      return false;
    }
  }
  if (/(?:^|\s)(?:какой|какая|какое|какие)\s+(?:\S+\s+){0,2}(?:метод\p{L}*|декоратор\p{L}*|функци\p{L}*)/iu.test(q)) {
    if (!new RegExp(`(?:${wbL}(?:метод\\p{L}*|декоратор\\p{L}*|функци\\p{L}*|method|decorator|function)${wbR}|\\(\\)|@[a-z_])`, 'iu').test(f)) {
      return false;
    }
  }
  if (/(?:^|\s)(?:какой|какая|какое|какие)\s+(?:\S+\s+){0,2}(?:массив\p{L}*|переменн\p{L}*)/iu.test(q)) {
    if (!new RegExp(`(?:${wbL}(?:массив\\p{L}*|переменн\\p{L}*|array|variable)${wbR}|\\$[A-Z_])`, 'iu').test(f)) {
      return false;
    }
  }
  if (new RegExp(`(?:по\\s+умолчанию|${wbL}default${wbR})`, 'iu').test(q)) {
    if (!new RegExp(`(?:по\\s+умолчанию|${wbL}default${wbR})`, 'iu').test(f)) return false;
  }
  if (/(?:сколько|за\s+сколько|через\s+сколько)\s+(?:\S+\s+){0,2}(?:минут\p{L}*|час\p{L}*|секунд\p{L}*|дн\p{L}*|суток)/iu.test(q)) {
    if (!new RegExp(`(?:\\d+(?:\\.\\d+)?|${wbL}(?:один|два|три|четыре|пять|десять)${wbR})\\s*(?:мин|мин\\.|минут\\p{L}*|ч|час\\p{L}*|сек|секунд\\p{L}*|дн\\p{L}*|суток|min|minutes?|hours?|hrs?|sec|seconds?|days?)${wbR}`, 'iu').test(f)) {
      return false;
    }
  }
  if (/(?:в\s+каком\s+году|какого\s+года)/iu.test(q)) {
    if (!/(?<![\p{L}\p{N}])(?:1\d{3}|20\d{2})(?![\p{L}\p{N}])/.test(f)) return false;
  }
  if (/(?:в\s+каком\s+месяце|в\s+какой\s+месяц)/iu.test(q)) {
    if (!new RegExp(`${wbL}(?:январ\\p{L}*|феврал\\p{L}*|март\\p{L}*|апрел\\p{L}*|ма[йяю]|июн\\p{L}*|июл\\p{L}*|август\\p{L}*|сентябр\\p{L}*|октябр\\p{L}*|ноябр\\p{L}*|декабр\\p{L}*|january|february|march|april|may|june|july|august|september|october|november|december)${wbR}`, 'iu').test(f)) {
      return false;
    }
  }
  if (new RegExp(`(?:какой|какая|при\\s+какой)\\s+(?:\\S+\\s+){0,2}частот\\p{L}*|${wbL}(?:гц|кгц|мгц|hz|khz|mhz)${wbR}`, 'iu').test(q)) {
    if (!new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:гц|кгц|мгц|hz|khz|mhz)${wbR}`, 'iu').test(f)) return false;
  }
  if (/(?:какой|каков|сколько)\s+(?:\S+\s+){0,3}(?:ток\p{L}*|микроампер\p{L}*|миллиампер\p{L}*|ампер\p{L}*)/iu.test(q)) {
    if (!new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:мка|ма|а|µa|ua|ma|a)${wbR}`, 'iu').test(f)) return false;
  }
  if (/(?:порог\s+напряжени\p{L}*|(?:чему\s+равн\p{L}*|на\s+сколько\s+милливольт|какое)\s+(?:\S+\s+){0,3}напряжени\p{L}*)/iu.test(q)) {
    if (!new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:мв|в|кв|mv|v|kv)${wbR}`, 'iu').test(f)) return false;
  }
  if (/теплопроводност\p{L}*|вт\/\(м[·*]к\)/iu.test(q)) {
    if (!/\d/.test(f)) return false;
  }
  if (/(?:при\s+какой|какая|сколько|какой|до\s+какой)\s+(?:\S+\s+){0,2}температур\p{L}*/iu.test(q)) {
    if (!new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:°\\s*[fc]|градус\\p{L}*|degrees?)${wbR}`, 'iu').test(f)) return false;
  }
  if (/(?:какой|какая|какое|каков\p{L}*|на\s+каком|на\s+какой|на\s+какую|на\s+сколько)\s+(?:\S+\s+){0,3}(?:длин\p{L}*|толщин\p{L}*|ширин\p{L}*|глубин\p{L}*|высот\p{L}*|протяженност\p{L}*|расстояни\p{L}*|миллиметр\p{L}*|сантиметр\p{L}*|метр\p{L}*|километр\p{L}*|дюйм\p{L}*|интервал\p{L}*|шаг\p{L}*)/iu.test(q)) {
    if (!new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:мм|см|м|км|дюйм\\p{L}*|mm|cm|m|km|inch(?:es)?)${wbR}`, 'iu').test(f)) return false;
  }
  if (/^\s*сколько(?![\p{L}\p{N}])/iu.test(q) && !/\d/.test(f) && !hasNumWord.test(f)) {
    return false;
  }
  if (/(?:^|\s)какое\s+(?:\S+\s+){0,2}значени\p{L}*/iu.test(q)) {
    const hasValueSyntax = /(?:по\s+умолчанию|\bdefault\b|\b[a-z]+-[a-z]+\b|\b(?:true|false|none|auto|inherit|initial)\b|["'`][^"'`]+["'`]|\d)/i.test(f);
    if (!hasValueSyntax) return false;
    const optionMatches = new Set([...q.matchAll(/\(([a-z][a-z0-9-]{1,})\)/gi)].map((m) => m[1].toLowerCase()));
    const predMatch = q.match(/(?:включает|задает|определяет|отключает|добавляет)\s+(.+)$/iu);
    if (predMatch) {
      for (const m of predMatch[1].matchAll(/\b([a-z][a-z0-9-]{2,})\b/gi)) {
        const tok = m[1].toLowerCase();
        if (!['css', 'html', 'python', 'bash', 'git'].includes(tok)) optionMatches.add(tok);
      }
    }
    for (const opt of optionMatches) {
      if (!cardFullNorm.includes(opt)) return false;
    }
  }
  if (/псевдоэлемент\p{L}*|псевдокласс\p{L}*|pseudo-?element|pseudo-?class/iu.test(q)) {
    if (!/(?:псевдоэлемент|псевдокласс|pseudo|::[a-z-]+)/iu.test(cardFullNorm)) return false;
  }
  return true;
}

const TARGET_ATTR_RULES = [
  { qRe: /(?:какой|какая|какое|каков\p{L}*)\s+(?:\S+\s+){0,2}толщин\p{L}*/iu, fRe: /толщ\p{L}*|thick\p{L}*|gauge/iu },
  { qRe: /(?:какой|какая|какое|каков\p{L}*)\s+(?:\S+\s+){0,2}протяженност\p{L}*/iu, fRe: /протяж\p{L}*|длин\p{L}*|length|long|(?<![\p{L}\p{N}])(?:км|km)(?![\p{L}\p{N}])/iu },
  { qRe: /(?:какой|какая|какое|каков\p{L}*|на\s+какую)\s+(?:\S+\s+){0,2}глубин\p{L}*/iu, fRe: /глубин\p{L}*|deep|depth/iu },
  { qRe: /(?:какой|какая|какое|каков\p{L}*|на\s+какой)\s+(?:\S+\s+){0,2}(?:высот\p{L}*|над\s+уровнем)/iu, fRe: /высот\p{L}*|над\s+уровнем|height|high|elevation|altitude/iu },
  { qRe: /(?:какой|какая|какое|каков\p{L}*)\s+(?:\S+\s+){0,2}ширин\p{L}*/iu, fRe: /ширин\p{L}*|wide|width/iu },
  { qRe: /(?:какой|какая|какое|каков\p{L}*)\s+(?:\S+\s+){0,2}длин\p{L}*/iu, fRe: /длин\p{L}*|length|long/iu },
];

const TOOL_NOUN_PATTERN = '(?:бит\\p{L}*|насадк\\p{L}*|отв[её]рт\\p{L}*|ключ\\p{L}*|головк\\p{L}*|жало|жал\\p{L}*|bit|bits|driver|screwdriver|wrench|socket|hex\\s+key)';
const TOOL_SIZE_PATTERN = '(?:размер\\p{L}*|номер\\p{L}*|маркировк\\p{L}*|калибр\\p{L}*|типоразмер\\p{L}*|size|number|gauge)';
const TOOLING_SIZE_QUERY_RE = new RegExp(
  `(?:(?:какой|какая|какое|какого|каким|какую|what|which)\\s+(?:\\S+\\s+){0,2}${TOOL_SIZE_PATTERN}\\s+(?:\\S+\\s+){0,2}${TOOL_NOUN_PATTERN}|${TOOL_SIZE_PATTERN}\\s+(?:для\\s+|у\\s+)?${TOOL_NOUN_PATTERN}|${TOOL_NOUN_PATTERN}\\s+(?:size|number))`,
  'iu',
);
const TOOLING_CODE_FACT_RE = /(?<![\p{L}\p{N}])(?:ph|pz|torx|tr|tx|ts|sl|sq|hex|p|t|h)\s*-?\s*\d{1,3}(?:\.\d+)?(?![\p{L}\p{N}])|#\d{1,3}(?![\p{L}\p{N}])/iu;
const TOOL_ADJ_PATTERN = '(?:hex|torx|pentalobe|phillips|pozidriv|flat|slotted|square|tri-?wing|шестигранн\\p{L}*|крестов\\p{L}*|шлицев\\p{L}*|торцев\\p{L}*)';
const TOOLING_DIM_PAIR_RE = new RegExp(
  `(?:${TOOL_NOUN_PATTERN}\\s+(?:${TOOL_ADJ_PATTERN}\\s+)?\\d+(?:[.,/]\\d+)?\\s*(?:мм|см|дюйм\\p{L}*|mm|cm|inch(?:es)?)|\\d+(?:[.,/]\\d+)?\\s*(?:мм|см|дюйм\\p{L}*|mm|cm|inch(?:es)?)\\s+(?:${TOOL_ADJ_PATTERN}\\s+)?${TOOL_NOUN_PATTERN}|(?:размер\\p{L}*|номер\\p{L}*|маркировк\\p{L}*)\\s+${TOOL_NOUN_PATTERN}|(?:bit|driver|screwdriver)\\s+size)`,
  'iu',
);

/**
 * Generic bit/driver tooling attribute gate: when a query asks for tool/bit/driver size/number/marking,
 * requires a specific tool size/code in claim/quote rather than a part dimension (e.g. screw length).
 */
function passesToolingAttributeGate(query, cardFactNorm) {
  const q = normalizeForTokens(query);
  if (!TOOLING_SIZE_QUERY_RE.test(q)) return true;
  return TOOLING_CODE_FACT_RE.test(cardFactNorm) || TOOLING_DIM_PAIR_RE.test(cardFactNorm);
}

function passesTargetAttributeGate(query, cardFactNorm) {
  const q = normalizeForTokens(query);
  for (const rule of TARGET_ATTR_RULES) {
    if (rule.qRe.test(q) && !rule.fRe.test(cardFactNorm)) return false;
  }
  return passesToolingAttributeGate(query, cardFactNorm);
}

const LOCALIZATION_HEAD_CONCEPTS = [
  { id: 'connector', stems: ['разъем', 'коннектор', 'connector', 'порт', 'port'] },
  { id: 'board', stems: ['плат', 'board', 'pcb', 'motherboard'] },
  { id: 'body', stems: ['корпус', 'панел', 'крышк', 'стекл', 'body', 'case', 'cover', 'panel'] },
];

const GENERIC_NODE_MODIFIERS = new Set([
  'с', 'у', 'в', 'на', 'от', 'для', 'к', 'по', 'из', 'при', 'возле', 'рядом', 'около', 'зоне', 'типу', 'типа',
  'the', 'of', 'to', 'and', 'in', 'on', 'near', 'with', 'from', 'two', '2', '3', '5', 'pentalobe',
  'новый', 'новая', 'нового', 'старый', 'старую', 'несколько', 'одной', 'одного', 'другой', 'другую',
  'всех', 'какой', 'какого', 'какому', 'этой', 'этого', 'подключен', 'подключена', 'подключено', 'установлен',
  'расположен', 'расположена', 'прикреплен', 'крепят', 'крепит',
]);

function getLocalizationHeadConcept(tok) {
  const st = stem(tok);
  for (const hc of LOCALIZATION_HEAD_CONCEPTS) {
    for (const hs of hc.stems) {
      if (tok === hs || st === hs || (hs.length >= 4 && st.startsWith(hs)) || (tok.length >= 4 && hs.startsWith(st))) {
        return hc.id;
      }
    }
  }
  return null;
}

function extractHeadModifiers(text) {
  const norm = normalizeForTokens(text);
  const map = new Map();
  const add = (hcId, mod) => {
    if (!mod || mod.length < 2 || STOPWORDS.has(mod) || GENERIC_NODE_MODIFIERS.has(mod) || /^\d+(?:\.\d+)?$/.test(mod)) return;
    if (getLocalizationHeadConcept(mod) === hcId) return;
    if (!map.has(hcId)) map.set(hcId, new Set());
    map.get(hcId).add(mod);
  };
  for (const m of norm.matchAll(/([\p{L}\p{N}]+)-([\p{L}\p{N}]+)/gu)) {
    const left = m[1];
    const right = m[2];
    const hcR = getLocalizationHeadConcept(right);
    const hcL = getLocalizationHeadConcept(left);
    if (hcR) add(hcR, left);
    if (hcL) add(hcL, right);
  }
  for (const clause of norm.split(/[.,;!?()—–:]+/)) {
    const words = clause.match(/[\p{L}\p{N}]+/gu) || [];
    for (let i = 0; i < words.length; i++) {
      const hc = getLocalizationHeadConcept(words[i]);
      if (!hc) continue;
      if (i > 0) {
        const prev = words[i - 1];
        if (!STOPWORDS.has(prev) && !GENERIC_NODE_MODIFIERS.has(prev)) {
          if (/^[a-z]+$/.test(prev) || /(?:ой|ей|ий|ый|ая|яя|ое|ее|ую|юю|ом|ем|ого|его|ому|ему|ые|ие|ых|их)$/.test(prev)) {
            add(hc, prev);
          }
        }
      }
      if (i + 1 < words.length) {
        const next = words[i + 1];
        if (!STOPWORDS.has(next) && !GENERIC_NODE_MODIFIERS.has(next)) {
          if (/^[a-z0-9]+$/.test(next) || (/^[а-я]+$/.test(next) && !/(?:ть|тся|ют|ет|ит|ат|ят|ли|ла|ло|ал|ил|ел|ен|ён|на|но|ны)$/.test(next))) {
            add(hc, next);
          }
        }
      }
    }
  }
  return map;
}

function modifiersMatch(modA, modB) {
  if (modA === modB || isMorphMatch(modA, modB)) return true;
  const gA = getSynonymGroups(modA);
  const gB = getSynonymGroups(modB);
  for (const g of gA) {
    if (gB.has(g)) return true;
  }
  return false;
}

function passesModifierExclusivity(query, card) {
  const cardText = `${card.title} ${card.claim} ${card.quote}`;
  const qMap = extractHeadModifiers(query);
  const cMap = extractHeadModifiers(cardText);
  if (qMap.size === 0 || cMap.size === 0) return true;

  for (const [hcId, qMods] of qMap.entries()) {
    const cMods = cMap.get(hcId);
    if (!cMods || cMods.size === 0 || qMods.size === 0) continue;
    let anyOverlap = false;
    for (const qm of qMods) {
      for (const cm of cMods) {
        if (modifiersMatch(qm, cm)) {
          anyOverlap = true;
          break;
        }
      }
      if (anyOverlap) break;
    }
    if (!anyOverlap) return false;
  }

  const qNorm = normalizeForTokens(query);
  const cNorm = normalizeForTokens(cardText);
  const qToks = tokenize(query);
  const cToks = tokenize(cardText);
  let hasUnmatchedQNode = false;
  for (const qMods of qMap.values()) {
    for (const qm of qMods) {
      if (!cToks.some((ct) => modifiersMatch(qm, ct)) && !cNorm.includes(stem(qm))) {
        hasUnmatchedQNode = true;
        break;
      }
    }
    if (hasUnmatchedQNode) break;
  }
  if (!hasUnmatchedQNode) return true;

  for (const cMods of cMap.values()) {
    for (const cm of cMods) {
      if (!qToks.some((qt) => modifiersMatch(cm, qt)) && !qNorm.includes(stem(cm))) {
        return false;
      }
    }
  }
  return true;
}

function selectCandidatesCpu(cards, query, limit = 3) {
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length || !Array.isArray(cards) || !cards.length) return [];

  const N = cards.length;
  const dfMap = new Map();
  const indexed = cards.map((card) => {
    const fieldMap = {
      title: tokenize(card.title),
      claim: tokenize(card.claim),
      quote: tokenize(card.quote),
      book: tokenize(card.book).filter((t) => !BOOK_META_TOKENS.has(t)),
    };
    const allCardTokens = [...new Set([...fieldMap.title, ...fieldMap.claim, ...fieldMap.quote, ...fieldMap.book])];
    for (const st of new Set(allCardTokens.map(stem))) {
      dfMap.set(st, (dfMap.get(st) || 0) + 1);
    }
    const fieldEntries = [
      ['title', 1.3, fieldMap.title, fieldMap.title.map(getSynonymGroups)],
      ['claim', 1.2, fieldMap.claim, fieldMap.claim.map(getSynonymGroups)],
      ['quote', 1.0, fieldMap.quote, fieldMap.quote.map(getSynonymGroups)],
      ['book', 0.6, fieldMap.book, fieldMap.book.map(getSynonymGroups)],
    ];
    const fullNorm = normalizeForTokens(`${card.title} ${card.claim} ${card.quote} ${card.book}`);
    const factNorm = normalizeForTokens(`${card.claim} ${card.quote}`);
    const fullTokensSet = new Set(tokenize(`${card.title} ${card.claim} ${card.quote} ${card.book}`, { keepStopwords: true }));
    return { card, fieldEntries, fullNorm, factNorm, fullTokensSet };
  });

  const idf = (t) => Math.log((N + 1) / ((dfMap.get(stem(t)) || 0) + 0.5)) + 0.5;
  const hardLiterals = extractHardLiterals(query);
  const ranked = [];

  for (const item of indexed) {
    if (failsHardTokenVeto(hardLiterals, item.fullNorm, item.fullTokensSet)) continue;
    if (!passesAnswerTypeGate(query, item.factNorm, item.fullNorm)) continue;
    if (!passesTargetAttributeGate(query, item.factNorm)) continue;
    if (!passesModifierExclusivity(query, item.card)) continue;

    let score = 0;
    let matchedTokens = 0;
    for (const qt of qTokens) {
      let bestTokenScore = 0;
      const w = idf(qt);
      for (const [, fw, fTokens, fGroups] of item.fieldEntries) {
        const ms = matchStrength(qt, fTokens, fGroups);
        if (ms > 0) {
          const s = ms * fw * w;
          if (s > bestTokenScore) bestTokenScore = s;
        }
      }
      if (bestTokenScore > 0) matchedTokens++;
      score += bestTokenScore;
    }

    if (matchedTokens > 0 && score > 0) {
      ranked.push({
        id: item.card.id,
        title: item.card.title,
        card: item.card,
        score: Math.round(score * 1000) / 1000,
      });
    }
  }

  ranked.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  return ranked.slice(0, limit);
}

/**
 * Strict verdict parser: requires the exact `SPAN: <...> | VERDICT: <YES|NO>` envelope without
 * conflicting extra verdicts, empty/NONE spans with YES, or overly long whole-card copies.
 */
function parseE4BVerdict(rawText) {
  const text = collapseWs(rawText);
  if (!text) return { verdict: 'NO', span: '', raw: text };

  const strict = /^SPAN\s*:\s*(.+?)\s*\|\s*VERDICT\s*:\s*(YES|NO)\s*\.?$/i.exec(text);
  if (!strict) {
    return { verdict: 'NO', span: '', raw: text };
  }
  const span = strict[1].replace(/^["'`«»„“]+|["'`«»„“]+$/g, '').trim();
  const verdict = strict[2].toUpperCase();
  if (verdict === 'NO') {
    return { verdict: 'NO', span: /^none$/i.test(span) ? 'NONE' : span, raw: text };
  }
  if (!span || /^(?:none|no_answer|n\/a|null)$/i.test(span) || span.length > 120 || span.split(/\s+/).length > 6) {
    return { verdict: 'NO', span: '', raw: text };
  }
  return { verdict: 'YES', span, raw: text };
}

const normForSpan = (s) => collapseWs(s)
  .toLowerCase()
  .replace(/ё/g, 'е')
  .replace(/[–—−]/g, '-')
  .replace(/(\d),(\d)/g, '$1.$2');

const isWordOrNumChar = (ch) => Boolean(ch) && /^[\p{L}\p{M}\p{N}]$/u.test(ch);

function hasValidSpanBoundary(hay, idx, len) {
  const prev = idx > 0 ? hay[idx - 1] : '';
  const next = idx + len < hay.length ? hay[idx + len] : '';
  const first = hay[idx];
  const last = hay[idx + len - 1];

  if (isWordOrNumChar(first)) {
    if (isWordOrNumChar(prev)) return false;
    if (/^\d$/.test(first) && /[+\-]/.test(prev)) return false;
    if (/^\d$/.test(first) && (prev === '.' || prev === ':') && idx >= 2 && /\d/.test(hay[idx - 2])) {
      return false;
    }
  } else if (first === '-' && (isWordOrNumChar(prev) || prev === '-')) {
    return false;
  }

  if (isWordOrNumChar(last)) {
    if (isWordOrNumChar(next)) return false;
    if (/^\d$/.test(last) && (next === '.' || next === '-' || next === ':') && idx + len + 1 < hay.length && /\d/.test(hay[idx + len + 1])) {
      return false;
    }
  } else if (last === '-' && (isWordOrNumChar(next) || next === '-')) {
    return false;
  }

  return true;
}

/**
 * Stage 3 (CPU): Requires an exact contiguous span inside `card.claim` or `card.quote`
 * with Unicode token and number boundaries (never Title-only, never unordered token bags).
 */
function isSpanGroundedInCard(span, card) {
  const cleanSpan = collapseWs(span);
  if (!cleanSpan || /^(?:none|no_answer|n\/a|null)$/i.test(cleanSpan) || !card) return false;
  const ndl = normForSpan(cleanSpan);
  if (!ndl || !/[\p{L}\p{N}]/u.test(ndl)) return false;

  for (const field of [card.claim, card.quote]) {
    if (typeof field !== 'string' || !field.trim()) continue;
    const hay = normForSpan(field);
    let pos = 0;
    while (pos <= hay.length - ndl.length) {
      const idx = hay.indexOf(ndl, pos);
      if (idx < 0) break;
      if (hasValidSpanBoundary(hay, idx, ndl.length)) return true;
      pos = idx + 1;
    }
  }
  return false;
}

function buildE4BPrompt(query, card) {
  return [
    'Task: Check whether FACT explicitly contains the exact requested answer to QUESTION (Russian and English translations/synonyms are equivalent).',
    'Rules:',
    '1) If FACT only mentions the topic or a general category WITHOUT the exact requested parameter, value, name, CLI flag, method, specific substance, or detail, output ONLY:',
    'SPAN: NONE | VERDICT: NO',
    '2) Do NOT confuse a part/fastener/object dimension (e.g. screw length in mm) with a tool/bit/driver size or marking, and do NOT treat a general tool family name as a specific tool size.',
    '3) If FACT explicitly states the answer, copy 1-6 exact contiguous words from Claim or Quote (not Title alone) that answer QUESTION and output ONLY:',
    'SPAN: <exact words from Claim or Quote> | VERDICT: YES',
    '',
    'FACT:',
    `Title: ${card.title}`,
    `Claim: ${card.claim}`,
    `Quote: ${card.quote}`,
    '',
    `QUESTION: ${query}`,
    'Output:',
  ].join('\n');
}

function loadApprovedCards(cardsPath = DEFAULT_CARDS_PATH) {
  const raw = JSON.parse(fs.readFileSync(cardsPath, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('NOMAD root cards must be an array');
  const frozen = raw.map((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('Invalid NOMAD root card');
    for (const k of ['id', 'title', 'claim', 'book', 'link', 'quote', 'lang']) {
      if (typeof c[k] !== 'string' || !c[k].trim()) throw new Error(`Invalid card field "${k}"`);
    }
    return Object.freeze({ ...c });
  });
  return Object.freeze(frozen);
}

let cachedCards = null;
let activeVerifications = 0;
function getApprovedCards(cardsPath = DEFAULT_CARDS_PATH) {
  if (cardsPath === DEFAULT_CARDS_PATH && cachedCards) return cachedCards;
  const loaded = loadApprovedCards(cardsPath);
  if (cardsPath === DEFAULT_CARDS_PATH) cachedCards = loaded;
  return loaded;
}

const EXPLICIT_NOMAD_PATTERNS = [
  /^\s*\/nomad(?:\s+|$)([\s\S]+)$/i,
  /^\s*(?:капри,?\s+)?(?:nomad|номад)\s*[:,—–-]\s*([\s\S]+)$/i,
  /^\s*(?:капри,?\s+)?(?:найди|поищи|посмотри|проверь|глянь)\s+(?:в|по)\s+(?:номад[еу]?|nomad|kiwix|кивикс[еу]?|оф+лайн[- ]?(?:баз[еу]|библиотек[еу]|номад[еу]?))\s*(?:про|о|об)?\s*[,:—–-]?\s*([\s\S]+)$/i,
  /^\s*(?:капри,?\s+)?что\s+в\s+(?:номад[еу]?|nomad|kiwix|кивикс[еу]?|оф+лайн[- ]?(?:баз[еу]|библиотек[еу]|номад[еу]?))\s+(?:про|о|об|по)\s*[,:—–-]?\s*([\s\S]+)$/i,
  /^\s*(?:капри,?\s+)?(?:оф+лайн|offline)\s+(?:в\s+)?(?:номад[е]?|nomad)\s*[,:—–-]?\s*([\s\S]+)$/i,
];

function parseNomadRootCommand(said) {
  const text = String(said || '').trim();
  if (!text || text.length > 400) return null;
  for (const re of EXPLICIT_NOMAD_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const q = m[1].replace(/[.!]+$/, '').trim();
    if (q.length >= 2 && q.length <= 300) return q;
  }
  return null;
}

function isEnabledFlag(cfg) {
  return cfg?.memoryRootLookup === 'on';
}

function loopbackUrl(raw) {
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function evaluateRootLookupGate({
  cfg,
  said,
  messages,
  worker = null,
  voice = false,
  torState = null,
  torCtx = false,
  tor = torDefault,
  ollamaUrl = 'http://127.0.0.1:11434',
} = {}) {
  if (!isEnabledFlag(cfg)) return { allowed: false, reason: 'disabled' };
  const query = parseNomadRootCommand(said);
  if (!query) return { allowed: false, reason: 'not_explicit' };
  if (worker !== null && worker !== undefined) return { allowed: false, reason: 'worker' };
  if (cfg?.rp === true) return { allowed: false, reason: 'rp' };
  if (voice === true) return { allowed: false, reason: 'voice' };
  const torBlocked = Boolean(
    torCtx
    || torState?.isQuarantined?.()
    || hasTorSignal(said, tor)
    || hasTorSignal(query, tor)
    || (messages !== undefined && contextMentionsTor(messages, tor))
  );
  if (torBlocked) return { allowed: false, reason: 'tor' };
  if ((cfg?.provider && cfg.provider !== 'ollama') || !loopbackUrl(ollamaUrl)) return { allowed: false, reason: 'not_local' };
  return { allowed: true, query };
}

/**
 * E4B only if already resident in fresh `/api/ps` and idle; skips explicitly for
 * 26B / busy / cold / unavailable / timeout and never warms or swaps any model.
 */
async function verifyCandidateWithResidentE4B({
  query,
  card,
  fastModel = FAST,
  mainModel = MAIN,
  loadedModels,
  isBusy,
  callModel,
  psTimeoutMs = 300,
  verifyTimeoutMs = 4000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  signal,
} = {}) {
  if (activeVerifications > 0) return { status: 'skipped', reason: 'busy', accepted: false };
  try {
    if (isBusy?.()) return { status: 'skipped', reason: 'busy', accepted: false };
  } catch {
    return { status: 'skipped', reason: 'busy', accepted: false };
  }
  if (typeof loadedModels !== 'function' || typeof callModel !== 'function') {
    return { status: 'skipped', reason: 'unavailable', accepted: false };
  }

  // 1. Fresh residency check via /api/ps
  const psCtrl = new AbortController();
  let psTimedOut = false;
  const psTimer = setTimer(() => {
    psTimedOut = true;
    try { psCtrl.abort(new Error('ps timeout')); } catch {}
  }, psTimeoutMs);
  psTimer?.unref?.();
  const onParentPsAbort = () => { try { psCtrl.abort(signal.reason); } catch {} };
  if (signal) {
    if (signal.aborted) {
      clearTimer(psTimer);
      return { status: 'skipped', reason: 'aborted', accepted: false };
    }
    signal.addEventListener('abort', onParentPsAbort, { once: true });
  }

  let loaded;
  try {
    loaded = await loadedModels(psCtrl.signal);
  } catch {
    if (signal?.aborted) return { status: 'skipped', reason: 'aborted', accepted: false };
    if (psTimedOut) return { status: 'skipped', reason: 'timeout', accepted: false };
    return { status: 'skipped', reason: 'unavailable', accepted: false };
  } finally {
    clearTimer(psTimer);
    if (signal) signal.removeEventListener('abort', onParentPsAbort);
  }

  if (signal?.aborted) return { status: 'skipped', reason: 'aborted', accepted: false };
  if (psTimedOut) return { status: 'skipped', reason: 'timeout', accepted: false };
  if (!Array.isArray(loaded)) return { status: 'skipped', reason: 'unavailable', accepted: false };

  const unique = [...new Set(loaded.filter((m) => typeof m === 'string' && m))];
  if (unique.includes(mainModel)) return { status: 'skipped', reason: '26b', accepted: false };
  if (!unique.includes(fastModel)) return { status: 'skipped', reason: 'cold', accepted: false };
  if (unique.length !== 1) return { status: 'skipped', reason: 'busy', accepted: false };

  if (activeVerifications > 0) return { status: 'skipped', reason: 'busy', accepted: false };
  try {
    if (isBusy?.()) return { status: 'skipped', reason: 'busy', accepted: false };
  } catch {
    return { status: 'skipped', reason: 'busy', accepted: false };
  }

  // 2. Resident E4B verification call (think: false, deterministic temperature 0)
  const verifyCtrl = new AbortController();
  let verifyTimedOut = false;
  const verifyTimer = setTimer(() => {
    verifyTimedOut = true;
    try { verifyCtrl.abort(new Error('root verifier timeout')); } catch {}
  }, verifyTimeoutMs);
  verifyTimer?.unref?.();
  const onParentVerifyAbort = () => { try { verifyCtrl.abort(signal.reason); } catch {} };
  if (signal) {
    if (signal.aborted) {
      clearTimer(verifyTimer);
      return { status: 'skipped', reason: 'aborted', accepted: false };
    }
    signal.addEventListener('abort', onParentVerifyAbort, { once: true });
  }

  activeVerifications++;
  try {
    const raw = await callModel({
      model: fastModel,
      messages: [{ role: 'user', content: buildE4BPrompt(query, card) }],
      temperature: 0,
      numPredict: 64,
      think: false,
    }, verifyCtrl.signal);
    if (signal?.aborted) return { status: 'skipped', reason: 'aborted', accepted: false };
    if (verifyTimedOut) return { status: 'skipped', reason: 'timeout', accepted: false };
    const parsed = parseE4BVerdict(raw);
    const grounded = parsed.verdict === 'YES' && isSpanGroundedInCard(parsed.span, card);
    return {
      status: grounded ? 'verified' : 'rejected',
      accepted: grounded,
      verdict: parsed.verdict,
      span: parsed.span,
      grounded,
    };
  } catch (err) {
    if (signal?.aborted) return { status: 'skipped', reason: 'aborted', accepted: false };
    if (verifyTimedOut || err?.name === 'TimeoutError' || err?.code === 'ETIMEDOUT') {
      return { status: 'skipped', reason: 'timeout', accepted: false };
    }
    return { status: 'skipped', reason: 'unavailable', accepted: false };
  } finally {
    activeVerifications = Math.max(0, activeVerifications - 1);
    clearTimer(verifyTimer);
    if (signal) signal.removeEventListener('abort', onParentVerifyAbort);
  }
}

function hasUnsafePathToken(raw) {
  const s = String(raw || '');
  if (s.includes('\\')) return true;
  const pathOnly = s.split(/[?#]/)[0];
  if (!pathOnly.startsWith('/content/') || pathOnly.includes('//')) return true;
  const hasDotSeg = (p) => p.split('/').slice(1).some((seg) => seg === '.' || seg === '..' || seg.includes('\\'));
  if (hasDotSeg(pathOnly)) return true;

  let decoded = pathOnly;
  for (let pass = 0; pass < 3; pass++) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) break;
    decoded = next;
    if (decoded.includes('\\') || hasDotSeg(decoded)) return true;
  }
  return false;
}

function linkBelongsToBook(link, bookEntry) {
  if (typeof link !== 'string' || !bookEntry?.content) return false;
  if (hasUnsafePathToken(link) || hasUnsafePathToken(bookEntry.content)) return false;
  try {
    const normLink = decodeURIComponent(new URL(link, 'http://127.0.0.1:8090').pathname);
    const normBook = decodeURIComponent(new URL(bookEntry.content, 'http://127.0.0.1:8090').pathname).replace(/\/+$/, '');
    return normLink.startsWith(`${normBook}/`);
  } catch {
    return false;
  }
}

function createStrictKiwixFetch(fetchImpl, allowedOrigins, signal) {
  return (input, init = {}) => {
    const urlStr = typeof input === 'string' ? input : input?.url;
    let parsed;
    try {
      parsed = new URL(String(urlStr || ''));
    } catch {
      throw new Error(`Invalid Kiwix URL: "${urlStr}"`);
    }
    if (!allowedOrigins.has(parsed.origin)) {
      throw new Error(`Unexpected Kiwix origin: ${parsed.origin}`);
    }
    const requestSignal = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
    return fetchImpl(input, { ...init, redirect: 'error', signal: requestSignal });
  };
}

/**
 * Verifies the selected card's book, link boundary, and quote against NOMAD Kiwix
 * (local-first via `kiwix.fromLocalFirst`, no redirects) before showing the card/link.
 */
async function verifyCardSource({
  card,
  kiwix = kiwixDefault,
  kiwixUrl = kiwixDefault.DEFAULT_URL,
  fetchImpl = fetch,
  signal,
} = {}) {
  if (!card || typeof card.book !== 'string' || typeof card.link !== 'string' || typeof card.quote !== 'string') {
    return { ok: false, reason: 'invalid_card' };
  }
  if (hasUnsafePathToken(card.link)) {
    return { ok: false, reason: 'unsafe_link' };
  }
  const allowedOrigins = new Set();
  try { allowedOrigins.add(new URL(kiwix.LOCAL_URL || kiwixDefault.LOCAL_URL).origin); } catch {}
  try {
    const reserve = new URL(kiwixUrl);
    if (reserve.protocol === 'http:' && isIPv4(reserve.hostname) && /^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(reserve.hostname)) {
      allowedOrigins.add(reserve.origin);
    }
  } catch {}
  if (!allowedOrigins.size) return { ok: false, reason: 'invalid_origin' };

  const sourceTimeout = AbortSignal.timeout(5000);
  const strictFetch = createStrictKiwixFetch(fetchImpl, allowedOrigins, signal ? AbortSignal.any([signal, sourceTimeout]) : sourceTimeout);
  try {
    return await kiwix.fromLocalFirst(async (origin) => {
      const books = await kiwix.catalog({ url: origin, fetchImpl: strictFetch });
      const bookEntry = Array.isArray(books)
        ? books.find((b) => b && (b.name === card.book || b.short === card.book))
        : null;
      if (!bookEntry) return { ok: false, reason: 'book_missing' };

      if (card.lang) {
        const want = LANG_ALIASES[String(card.lang).toLowerCase()] || String(card.lang).toLowerCase();
        const have = LANG_ALIASES[String(bookEntry.lang || '').toLowerCase()] || String(bookEntry.lang || '').toLowerCase();
        if (have && want && !have.split(',').map((s) => s.trim()).includes(want)) {
          return { ok: false, reason: 'lang_mismatch' };
        }
      }

      if (!linkBelongsToBook(card.link, bookEntry)) {
        return { ok: false, reason: 'link_mismatch' };
      }

      const article = await kiwix.read(card.link, { url: origin, chars: 200000, fetchImpl: strictFetch });
      const normQuote = collapseWs(card.quote);
      if (!normQuote || !collapseWs(article).includes(normQuote)) {
        return { ok: false, reason: 'quote_missing' };
      }

      return {
        ok: true,
        origin,
        book: bookEntry.name,
        bookTitle: bookEntry.title || bookEntry.name,
        link: card.link,
      };
    }, kiwixUrl);
  } catch (err) {
    return { ok: false, reason: 'source_unavailable', error: err?.message || 'Kiwix unavailable' };
  }
}

const SKIP_TEXT = Object.freeze({
  '26b': 'Сейчас активна основная модель 26B — не проверяю карточки NOMAD и не переключаю модели.',
  busy: 'Локальная модель сейчас занята — пропускаю проверку карточек NOMAD.',
  cold: 'Быстрая локальная модель E4B не загружена в память — не прогреваю её ради проверки NOMAD.',
  timeout: 'Быстрая модель E4B не успела ответить — пропускаю проверку карточек NOMAD.',
  unavailable: 'Локальная модель E4B сейчас недоступна для проверки карточек NOMAD.',
  aborted: 'Остановила проверку карточек NOMAD.',
});

const REFUSAL_TEXT = Object.freeze({
  no_candidate: 'В проверенных карточках NOMAD не нашлось подходящего ответа на этот запрос.',
  rejected: 'В карточках NOMAD нет точного подтверждения этого факта.',
  source_unverified: 'Не смогла проверить источник NOMAD (Kiwix) — неподтверждённую карточку и ссылку не показываю.',
});

function formatRootLookupReply({ card, span, source }) {
  const href = new URL(source.link, source.origin).href;
  return [
    `${card.claim} (совпадение: ${span})`,
    `Источник NOMAD: ${href}`,
    `Цитата: «${card.quote}»`,
  ].join('\n');
}

/**
 * Narrow entry point for explicit offline NOMAD root lookup in Capri normal chat.
 * Returns `{ handled: false, reason }` when gated off (flag off, not explicit, voice, Tor, worker, RP),
 * or `{ handled: true, status, reason, text, card?, span?, source? }` without saving any retrieval data.
 */
async function lookupApprovedRoot({
  cfg,
  said,
  messages,
  worker = null,
  voice = false,
  torState = null,
  torCtx = false,
  tor = torDefault,
  ollamaUrl,
  cards = null,
  cardsPath = DEFAULT_CARDS_PATH,
  kiwix = kiwixDefault,
  kiwixUrl,
  loadedModels,
  isBusy,
  callModel,
  fetchImpl = fetch,
  fastModel = FAST,
  mainModel = MAIN,
  psTimeoutMs = 300,
  verifyTimeoutMs = 4000,
  signal,
} = {}) {
  const gate = evaluateRootLookupGate({ cfg, said, messages, worker, voice, torState, torCtx, tor, ollamaUrl });
  if (!gate.allowed) {
    return { handled: false, status: 'skipped', reason: gate.reason };
  }

  const cardPool = Array.isArray(cards) ? cards : getApprovedCards(cardsPath);
  const candidates = selectCandidatesCpu(cardPool, gate.query, 3);
  if (!candidates.length) {
    return {
      handled: true,
      status: 'no_match',
      reason: 'no_candidate',
      text: REFUSAL_TEXT.no_candidate,
    };
  }

  const top = candidates[0];
  const verify = await verifyCandidateWithResidentE4B({
    query: gate.query,
    card: top.card,
    fastModel,
    mainModel,
    loadedModels,
    isBusy,
    callModel,
    psTimeoutMs,
    verifyTimeoutMs,
    signal,
  });

  if (verify.status === 'skipped') {
    return {
      handled: true,
      status: 'skipped',
      reason: verify.reason,
      text: SKIP_TEXT[verify.reason] || SKIP_TEXT.unavailable,
    };
  }
  if (!verify.accepted) {
    return {
      handled: true,
      status: 'no_match',
      reason: verify.verdict === 'YES' ? 'ungrounded' : 'rejected',
      text: REFUSAL_TEXT.rejected,
    };
  }

  const source = await verifyCardSource({
    card: top.card,
    kiwix,
    kiwixUrl: kiwixUrl || cfg?.kiwixUrl || kiwix.DEFAULT_URL,
    fetchImpl,
    signal,
  });
  if (!source.ok) {
    return {
      handled: true,
      status: 'source_unverified',
      reason: source.reason,
      text: REFUSAL_TEXT.source_unverified,
    };
  }

  const readOnlyCard = Object.freeze({ ...top.card });
  return {
    handled: true,
    status: 'hit',
    reason: 'verified',
    card: readOnlyCard,
    span: verify.span,
    source: Object.freeze({ ...source }),
    text: formatRootLookupReply({ card: readOnlyCard, span: verify.span, source }),
  };
}

module.exports = {
  DEFAULT_CARDS_PATH,
  collapseWs,
  normalizeForTokens,
  tokenize,
  stem,
  isMorphMatch,
  passesAnswerTypeGate,
  passesToolingAttributeGate,
  passesTargetAttributeGate,
  passesModifierExclusivity,
  selectCandidatesCpu,
  parseE4BVerdict,
  isSpanGroundedInCard,
  buildE4BPrompt,
  loadApprovedCards,
  getApprovedCards,
  parseNomadRootCommand,
  evaluateRootLookupGate,
  verifyCandidateWithResidentE4B,
  hasUnsafePathToken,
  linkBelongsToBook,
  verifyCardSource,
  formatRootLookupReply,
  lookupApprovedRoot,
};
