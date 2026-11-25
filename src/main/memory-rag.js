'use strict';

const WEIGHTS = Object.freeze({
  lexical: 0.45,
  freshness: 0.15,
  provenance: 0.15,
  layer: 0.15,
  dedupPenalty: 0.10,
});

const TRUNK_SOURCES = new Set(['local_nomad', 'nomad', 'genesis_doc', 'kiwix', 'docs', 'reference']);
const TRUNK_LINK_PREFIXES = ['http://', 'https://', 'nomad://', 'kiwix://'];

const STOP_WORDS_2 = new Set([
  'по', 'на', 'из', 'от', 'до', 'за', 'не', 'да', 'но', 'то', 'же', 'ли', 'бы', 'он', 'мы', 'вы', 'ты',
  'во', 'со', 'ко', 'об', 'ни', 'ну', 'уж', 'их', 'ее', 'ей', 'им', 'ту', 'та', 'те', 'ти', 'ох', 'эх',
  'ах', 'ой', 'ай', 'эй', 'ок', 'гм', 'ау',
  'in', 'on', 'at', 'to', 'of', 'or', 'by', 'as', 'is', 'it', 'no', 'if', 'so', 'we', 'he', 'me', 'my',
  'an', 'do', 'go', 'up', 'us', 'be', 'am', 'ok', 'hi', 'oh', 'ah', 'ha',
]);

const STOP_WORDS_3 = new Set([
  'что', 'как', 'для', 'при', 'без', 'под', 'над', 'про', 'или', 'уже', 'еще', 'все', 'его', 'она', 'они',
  'оно', 'так', 'вот', 'тут', 'там', 'где', 'кто', 'чем', 'кем', 'это', 'эта', 'эти', 'эту', 'нет',
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'his', 'was', 'one', 'our',
  'out', 'has', 'who', 'how', 'why', 'did', 'she', 'its', 'too',
]);

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е');
}

function isUsefulShortToken(tok) {
  if (tok.length >= 3) return !STOP_WORDS_3.has(tok);
  if (tok.length === 2) return /\d/.test(tok) || !STOP_WORDS_2.has(tok);
  return false;
}

function stems(s) {
  const normalized = normalizeText(s);
  const matches = normalized.match(/[a-zа-я0-9]+(?:-[a-zа-я0-9]+)*/g) || [];
  const out = new Set();
  for (const w of matches) {
    if (w.includes('-')) {
      if (w.length >= 2) out.add(w.slice(0, 32));
      for (const part of w.split('-')) {
        if (part.length >= 3 && !STOP_WORDS_3.has(part)) {
          out.add(part.slice(0, 5));
        } else if (part.length === 2 && /\d/.test(part)) {
          out.add(part);
        }
      }
      continue;
    }
    if (w.length >= 3) {
      if (!STOP_WORDS_3.has(w)) out.add(w.slice(0, 5));
    } else if (w.length === 2 && (/\d/.test(w) || !STOP_WORDS_2.has(w))) {
      out.add(w);
    }
  }
  return out;
}

function exactTokens(s) {
  const normalized = normalizeText(s);
  const matches = normalized.match(/[a-zа-я0-9_]+(?:-[a-zа-я0-9_]+)*/g) || [];
  return matches.filter((tok) => (tok.includes('-') ? tok.length >= 2 : isUsefulShortToken(tok)));
}

function normalizeLayer(layer) {
  const raw = normalizeText(layer).trim();
  if (raw === '10_ствол' || raw === '10_stvol' || raw === 'ствол') return '10_ствол';
  if (raw === '20_крона' || raw === '20_krona' || raw === 'крона') return '20_крона';
  if (raw === '90_архив' || raw === '90_archive' || raw === 'архив') return '90_архив';
  if (raw === 'pending_review' || raw === 'conflicted') return raw;
  return raw || 'regular';
}

function isCardAllowed(card, { vaultOnly = false, includeTor = false, branch = '' } = {}) {
  const source = normalizeText(card?.source).trim();
  const layer = normalizeLayer(card?.layer);
  const cardBranch = normalizeText(card?.branch).trim();
  const wantBranch = normalizeText(branch).trim();
  if (source === 'tor' && !includeTor && wantBranch !== 'tor') return false;
  if (cardBranch && cardBranch !== wantBranch && !vaultOnly) return false;
  if (vaultOnly) return source === 'vault' || layer === 'vault' || card?.vault === true;
  if (source === 'vault' || layer === 'vault' || card?.vault === true) {
    return Boolean(wantBranch && cardBranch && cardBranch === wantBranch);
  }
  return true;
}

function classifyShelf(payload = {}) {
  const rawLayer = normalizeText(payload.layer).trim();
  if (rawLayer === '10_ствол') return '10_ствол';
  if (rawLayer === '20_крона') return '20_крона';

  const source = normalizeText(payload.source).trim();
  if (TRUNK_SOURCES.has(source)) {
    return '10_ствол';
  }

  const link = normalizeText(payload.link).trim();
  if (link && TRUNK_LINK_PREFIXES.some((prefix) => link.startsWith(prefix))) {
    return '10_ствол';
  }

  return '20_крона';
}

function computeLexical(card, queryWords, rawQuery) {
  const qSet = queryWords instanceof Set ? queryWords : stems(queryWords);
  if (!qSet.size) return 0;

  const titleText = [card.title, card.topic].filter(Boolean).join(' ');
  const fileText = String(card.file || '').replace(/\.md(?:\.enc)?$/i, '').replace(/[\\/._]+/g, ' ');
  const titleFileText = [titleText, fileText].filter(Boolean).join(' ');
  const bodyText = [card.body, card.text].filter(Boolean).join(' ');
  const quoteText = String(card.quote || '');

  const titleStems = stems(titleText);
  const fileStems = stems(fileText);
  const bodyStems = stems(bodyText);
  const quoteStems = stems(quoteText);

  let matchedWords = 0;
  let titleMatched = 0;
  let titleFileMatched = 0;
  let bodyMatched = 0;

  for (const qw of qSet) {
    const inTitle = titleStems.has(qw);
    const inFile = fileStems.has(qw);
    const inBody = bodyStems.has(qw);
    const inQuote = quoteStems.has(qw);

    if (inTitle) titleMatched += 1;
    if (inTitle || inFile) titleFileMatched += 1;
    if (inBody || inQuote) bodyMatched += 1;
    if (inTitle || inFile || inBody || inQuote) matchedWords += 1;
  }

  if (matchedWords === 0) return 0;

  const overallCoverage = matchedWords / qSet.size;
  const titleCoverage = titleMatched / qSet.size;
  const titleFileCoverage = titleFileMatched / qSet.size;
  const bodyCoverage = bodyMatched / qSet.size;

  let exactCoverage = overallCoverage;
  let titleFileExactCoverage = titleFileCoverage;
  let phraseBonus = 0;

  const cleanQuery = normalizeText(rawQuery).replace(/\s+/g, ' ').trim();
  const exactQ = exactTokens(rawQuery);
  const effectivePhrase = exactQ.length > 0 ? exactQ.join(' ') : cleanQuery;

  const normTitle = normalizeText(card.title).replace(/\s+/g, ' ').trim();
  const normTitleFile = normalizeText(titleFileText).replace(/\s+/g, ' ').trim();
  const normBodyQuote = normalizeText(`${bodyText} ${quoteText}`).replace(/\s+/g, ' ').trim();

  if (effectivePhrase) {
    if (normTitle === cleanQuery || normTitle === effectivePhrase) {
      phraseBonus = 0.22;
    } else if (effectivePhrase.length >= 3 && (normTitle.includes(effectivePhrase) || normTitleFile.includes(effectivePhrase))) {
      phraseBonus = 0.14;
    } else if (cleanQuery.length >= 3 && (normTitle.includes(cleanQuery) || normTitleFile.includes(cleanQuery))) {
      phraseBonus = 0.12;
    } else if (cleanQuery.length >= 4 && normBodyQuote.includes(cleanQuery)) {
      phraseBonus = 0.04;
    }
  }

  if (exactQ.length > 0) {
    const fullHaystack = `${normTitleFile} ${normBodyQuote}`;
    const exactHay = new Set(exactTokens(fullHaystack));
    const titleFileExactHay = new Set(exactTokens(normTitleFile));
    let exactHits = 0;
    let titleFileExactHits = 0;
    for (const tok of exactQ) {
      if (exactHay.has(tok)) exactHits += 1;
      if (titleFileExactHay.has(tok)) titleFileExactHits += 1;
    }
    exactCoverage = exactHits / exactQ.length;
    titleFileExactCoverage = titleFileExactHits / exactQ.length;
  }

  const rawScore =
    0.22 * overallCoverage +
    0.22 * exactCoverage +
    0.22 * titleFileCoverage +
    0.14 * titleCoverage +
    0.12 * titleFileExactCoverage +
    0.08 * bodyCoverage +
    phraseBonus;
  return Math.max(0, Math.min(1, Number(rawScore.toFixed(6))));
}

function computeFreshness(card, layer, nowMs) {
  const tsRaw = card.updated || card.created;
  if (!tsRaw) return 0.5;
  const tsMs = typeof tsRaw === 'number' ? tsRaw : Date.parse(String(tsRaw));
  if (!Number.isFinite(tsMs)) return 0.5;

  const ageDays = Math.max(0, (nowMs - tsMs) / 86400000);
  const tau = layer === '10_ствол' ? 365 : layer === '20_крона' ? 90 : 180;
  return Number(Math.exp(-ageDays / tau).toFixed(6));
}

function computeProvenance(card) {
  const source = normalizeText(card.source).trim();
  const hasLink = Boolean(String(card.link || '').trim());
  const hasQuote = Boolean(String(card.quote || '').trim());

  if (TRUNK_SOURCES.has(source)) {
    if (hasLink && hasQuote) return 1.0;
    if (hasLink || hasQuote) return 0.85;
    return 0.75;
  }
  if (source === 'council_verdict' || source === 'deep_research') return 0.90;
  if (source === 'branch_memory') return 0.85;
  if (source === 'user_remember') return 0.75;
  if (source === 'chat_extract') return 0.55;
  return 0.30;
}

function computeLayerFactor(card, layer) {
  const status = normalizeText(card.status).trim();
  if (layer === 'pending_review' || layer === 'conflicted' || status === 'pending_review' || status === 'conflicted') {
    return 0;
  }
  if (layer === '10_ствол') {
    return status === 'verified' || !status ? 1.0 : 0.70;
  }
  if (layer === '20_крона') {
    return status === 'verified' || !status ? 0.95 : 0.65;
  }
  if (layer === '90_архив' || status === 'archived') {
    return 0.40;
  }
  return 0.65;
}

function scoreCard(card, query, nowMs = Date.now(), rawQuery = '', opts = {}) {
  const layer = normalizeLayer(card.layer);
  const status = normalizeText(card.status).trim();

  if (
    !isCardAllowed(card, opts) ||
    layer === 'pending_review' ||
    layer === 'conflicted' ||
    layer === 'quarantined' ||
    status === 'pending_review' ||
    status === 'conflicted' ||
    status === 'quarantined'
  ) {
    return {
      score: 0,
      factors: { lexical: 0, freshness: 0, provenance: 0, layer: 0, dedupPenalty: 0 },
    };
  }

  const queryWords = query instanceof Set ? query : stems(query);
  const effectiveRawQuery = rawQuery || (typeof query === 'string' ? query : '');
  const lexical = computeLexical(card, queryWords, effectiveRawQuery);
  if (lexical === 0) {
    return {
      score: 0,
      factors: { lexical: 0, freshness: 0, provenance: 0, layer: 0, dedupPenalty: 0 },
    };
  }

  const freshness = computeFreshness(card, layer, nowMs);
  const provenance = computeProvenance(card);
  const layerFactor = computeLayerFactor(card, layer);

  const weightedSum =
    WEIGHTS.lexical * lexical +
    WEIGHTS.freshness * freshness +
    WEIGHTS.provenance * provenance +
    WEIGHTS.layer * layerFactor;

  const maxPositiveWeight = WEIGHTS.lexical + WEIGHTS.freshness + WEIGHTS.provenance + WEIGHTS.layer;
  const baseScore = Number((weightedSum / maxPositiveWeight).toFixed(6));

  return {
    score: baseScore,
    factors: {
      lexical,
      freshness,
      provenance,
      layer: layerFactor,
      dedupPenalty: 0,
    },
  };
}

function jaccardStems(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function getCardStemSignature(card) {
  return stems(`${card.title || ''} ${card.topic || ''} ${card.body || ''} ${card.text || ''}`);
}

function rankCards(cards, query, { limit = 3, nowMs = Date.now(), minScore = 0.12, vaultOnly = false, includeTor = false, branch = '' } = {}) {
  if (!Array.isArray(cards) || !cards.length) return [];
  const queryWords = query instanceof Set ? query : stems(query);
  if (!queryWords.size) return [];
  const rawQuery = typeof query === 'string' ? query : '';

  const candidates = [];
  for (const card of cards) {
    if (!card || typeof card !== 'object') continue;
    const { score, factors } = scoreCard(card, queryWords, nowMs, rawQuery, { vaultOnly, includeTor, branch });
    if (score > 0 && score >= minScore) {
      candidates.push({
        card,
        baseScore: score,
        factors,
        topicNorm: normalizeText(card.topic).trim(),
        signature: getCardStemSignature(card),
      });
    }
  }

  candidates.sort((a, b) => b.baseScore - a.baseScore);

  const selected = [];
  const selectedMeta = [];
  const remaining = [...candidates];

  while (remaining.length > 0 && selected.length < limit) {
    let bestIdx = -1;
    let bestEffectiveScore = -Infinity;
    let bestPenalty = 0;

    for (let i = 0; i < remaining.length; i += 1) {
      const cand = remaining[i];
      let isDuplicate = false;

      for (const prev of selectedMeta) {
        if (cand.topicNorm && prev.topicNorm && cand.topicNorm === prev.topicNorm) {
          isDuplicate = true;
          break;
        }
        if (jaccardStems(cand.signature, prev.signature) >= 0.70) {
          isDuplicate = true;
          break;
        }
      }

      const penalty = isDuplicate ? WEIGHTS.dedupPenalty : 0;
      const effectiveScore = Number(Math.max(0, cand.baseScore - penalty).toFixed(6));

      if (effectiveScore > bestEffectiveScore) {
        bestEffectiveScore = effectiveScore;
        bestPenalty = penalty;
        bestIdx = i;
      }
    }

    if (bestIdx === -1 || bestEffectiveScore < minScore) break;

    const [chosen] = remaining.splice(bestIdx, 1);
    selectedMeta.push({ topicNorm: chosen.topicNorm, signature: chosen.signature });
    selected.push({
      ...chosen.card,
      score: bestEffectiveScore,
      factors: {
        ...chosen.factors,
        dedupPenalty: bestPenalty,
      },
    });
  }

  return selected;
}

module.exports = {
  WEIGHTS,
  normalizeText,
  exactTokens,
  stems,
  scoreCard,
  rankCards,
  classifyShelf,
  isCardAllowed,
};
