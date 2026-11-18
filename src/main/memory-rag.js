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

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е');
}

function stems(s) {
  const normalized = normalizeText(s);
  const matches = normalized.match(/[a-zа-я0-9]{3,}/g) || [];
  const out = new Set();
  for (const w of matches) {
    out.add(w.slice(0, 5));
  }
  return out;
}

function normalizeLayer(layer) {
  const raw = normalizeText(layer).trim();
  if (raw === '10_ствол' || raw === '10_stvol' || raw === 'ствол') return '10_ствол';
  if (raw === '20_крона' || raw === '20_krona' || raw === 'крона') return '20_крона';
  if (raw === '90_архив' || raw === '90_archive' || raw === 'архив') return '90_архив';
  if (raw === 'pending_review' || raw === 'conflicted') return raw;
  return raw || 'regular';
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
  const bodyText = [card.body, card.text].filter(Boolean).join(' ');
  const quoteText = String(card.quote || '');

  const titleStems = stems(titleText);
  const bodyStems = stems(bodyText);
  const quoteStems = stems(quoteText);

  let weightedHits = 0;
  let matchedWords = 0;

  for (const qw of qSet) {
    let wordWeight = 0;
    if (titleStems.has(qw)) wordWeight += 2.0;
    if (bodyStems.has(qw)) wordWeight += 1.0;
    if (quoteStems.has(qw)) wordWeight += 0.8;

    if (wordWeight > 0) {
      matchedWords += 1;
      weightedHits += wordWeight;
    }
  }

  if (matchedWords === 0) return 0;

  const maxPossiblePerWord = 2.0;
  const coverage = matchedWords / qSet.size;
  const weightedDensity = Math.min(1, weightedHits / (qSet.size * maxPossiblePerWord));

  let exactCoverage = coverage;
  let phraseBonus = 0;
  const cleanQuery = normalizeText(rawQuery).trim();
  const fullHaystack = normalizeText(`${titleText} ${bodyText} ${quoteText}`);
  if (cleanQuery.length >= 4 && fullHaystack.includes(cleanQuery)) {
    phraseBonus = 0.15;
  }
  const exactQ = cleanQuery.match(/[a-zа-я0-9_]+/g) || [];
  if (exactQ.length > 0) {
    const exactHay = new Set(fullHaystack.match(/[a-zа-я0-9_]+/g) || []);
    let exactHits = 0;
    for (const tok of exactQ) {
      if (exactHay.has(tok)) exactHits += 1;
    }
    exactCoverage = exactHits / exactQ.length;
  }

  const rawScore = 0.35 * coverage + 0.30 * weightedDensity + 0.35 * exactCoverage + phraseBonus;
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

function scoreCard(card, queryWords, nowMs = Date.now(), rawQuery = '') {
  const layer = normalizeLayer(card.layer);
  const status = normalizeText(card.status).trim();

  if (layer === 'pending_review' || layer === 'conflicted' || status === 'pending_review' || status === 'conflicted') {
    return {
      score: 0,
      factors: { lexical: 0, freshness: 0, provenance: 0, layer: 0, dedupPenalty: 0 },
    };
  }

  const lexical = computeLexical(card, queryWords, rawQuery);
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

function rankCards(cards, query, { limit = 3, nowMs = Date.now(), minScore = 0.08 } = {}) {
  if (!Array.isArray(cards) || !cards.length) return [];
  const queryWords = query instanceof Set ? query : stems(query);
  if (!queryWords.size) return [];
  const rawQuery = typeof query === 'string' ? query : '';

  const candidates = [];
  for (const card of cards) {
    if (!card || typeof card !== 'object') continue;
    const { score, factors } = scoreCard(card, queryWords, nowMs, rawQuery);
    if (score >= minScore) {
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
  stems,
  scoreCard,
  rankCards,
  classifyShelf,
};
