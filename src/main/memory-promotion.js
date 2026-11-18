'use strict';

// Memory promotion engine and crash-safe Markdown + NDJSON vault store.
// Supports preview (read-only), cancel, explicit confirm (replacement or primary),
// idempotent single-writer WAL recovery (reconcile), targeted rollback, and Tor/origin guards.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ACTIVE_LAYERS = new Set(['10_ствол', '20_крона', 'trunk', 'crown']);
const LAYER_FOLDER_MAP = Object.freeze({
  '10_ствол': '10_Ствол',
  trunk: '10_Ствол',
  '20_крона': '20_Крона',
  crown: '20_Крона',
});
const PENDING_REVIEW_DIR = 'pending_review';
const ARCHIVE_DIR = '90_Архив';
const AUDIT_FILE = 'audit.jsonl';
const CANDIDATE_STATUSES = new Set(['candidate', 'pending_review']);
const TOR_SOURCES = new Set(['tor', 'dark', 'darknet', 'tor_vault']);
const RETRYABLE_FS_CODES = new Set(['EBUSY', 'EPERM']);
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function clone(value) {
  return structuredClone(value);
}

function normalizeStr(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

function withWinRetry(fn, delays = [10, 25, 50]) {
  for (let i = 0; ; i += 1) {
    try {
      return fn();
    } catch (err) {
      if (!RETRYABLE_FS_CODES.has(err?.code) || i >= delays.length) throw err;
      sleepSync(delays[i]);
    }
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function computeStateVersion(cards, opCount) {
  const digest = crypto.createHash('sha256').update(stableStringify(cards)).digest('hex').slice(0, 12);
  return `v${opCount}:${digest}`;
}

function computePreviewHash(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 16);
}

function hasOnionUrl(value) {
  const s = normalizeStr(value);
  if (!s) return false;
  if (/\.onion(?:[/:?#]|$)/i.test(s)) return true;
  try {
    return /\.onion$/i.test(new URL(s).hostname);
  } catch {
    return false;
  }
}

function isTorScheme(value) {
  return /^tor:\/\//i.test(normalizeStr(value));
}

function isTorOriginValue(value) {
  const s = normalizeStr(value).toLowerCase();
  return Boolean(s && (TOR_SOURCES.has(s) || isTorScheme(s) || hasOnionUrl(s)));
}

function hasHttpUrl(value) {
  return /^https?:\/\//i.test(normalizeStr(value));
}

function entryUrls(entry) {
  if (!entry || typeof entry !== 'object') return [];
  return [entry.url, entry.link, entry.ref, entry.source_ref].map(normalizeStr).filter(Boolean);
}

function hasSpoofedOrigin(card) {
  if (!card || typeof card !== 'object') return false;
  const prov = card.provenance && typeof card.provenance === 'object' ? card.provenance : {};
  const declared = [
    card.source,
    card.origin,
    card.tor_origin,
    prov.source,
    prov.origin,
    prov.tor_origin,
    prov.source_class,
  ].map((v) => normalizeStr(v).toLowerCase());
  const marksTor = declared.some(isTorOriginValue) || Boolean(card.tor || card.torTainted || prov.tor);
  const allUrls = [
    ...entryUrls(card),
    ...entryUrls(prov),
    ...(Array.isArray(card.evidence) ? card.evidence.flatMap(entryUrls) : []),
  ];
  if (marksTor && allUrls.some((u) => hasHttpUrl(u) && !hasOnionUrl(u))) return true;
  if (!marksTor && allUrls.some(hasOnionUrl)) return true;
  return false;
}

function entryHasTorTaint(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const fields = [entry.source, entry.origin, entry.tor_origin, entry.source_class];
  if (fields.some(isTorOriginValue)) return true;
  if (entry.tor === true || entry.torTainted === true || entry.quarantined === true) return true;
  if (entry.torState === 'quarantined' || entry.torState?.quarantined === true) return true;
  return entryUrls(entry).some((u) => isTorScheme(u) || hasOnionUrl(u));
}

function isTorTaintedCard(card) {
  if (!card || typeof card !== 'object') return false;
  if (entryHasTorTaint(card) || entryHasTorTaint(card.provenance)) return true;
  if (Array.isArray(card.evidence) && card.evidence.some(entryHasTorTaint)) return true;
  return false;
}

function normalizeEvidenceList(card) {
  if (!card || typeof card !== 'object') return [];
  const rawList = Array.isArray(card.evidence)
    ? card.evidence
    : (card.quote || card.link || card.source_ref ? [{ book: card.book, link: card.link, source_ref: card.source_ref, quote: card.quote, source: card.source }] : []);
  return rawList
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const ref = normalizeStr(item.link || item.url || item.ref || item.source_ref);
      const quote = normalizeStr(item.quote || item.excerpt || item.hash);
      const book = normalizeStr(item.book);
      const source = normalizeStr(item.source || item.source_class || card.provenance?.source || card.source);
      if (!quote || (!ref && !book)) return null;
      return {
        ...clone(item),
        cardId: item.cardId || card.id,
        ...(source ? { source } : {}),
      };
    })
    .filter(Boolean);
}

function hasValidProvenance(card) {
  if (!card || typeof card !== 'object') return false;
  const prov = card.provenance;
  const hasOrigin = Boolean(
    (prov && typeof prov === 'object' && normalizeStr(prov.source || prov.origin || prov.kind || prov.source_class)) ||
    normalizeStr(card.source || card.origin),
  );
  return hasOrigin && normalizeEvidenceList(card).length > 0;
}

function mergeEvidence(candidateCard, previousCard) {
  const combined = [
    ...normalizeEvidenceList(candidateCard),
    ...(previousCard ? normalizeEvidenceList(previousCard) : []),
  ];
  const seen = new Set();
  const deduped = [];
  for (const item of combined) {
    const key = stableStringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function normalizeLayer(layer) {
  const s = normalizeStr(layer).toLowerCase();
  if (s === 'trunk' || s === '10_ствол') return '10_ствол';
  if (s === 'crown' || s === '20_крона') return '20_крона';
  return normalizeStr(layer);
}

function makeAuditError(message, code, detail = {}) {
  const err = new Error(message);
  err.auditCode = code;
  err.detail = detail;
  return err;
}

function validatePromotionPair(cards, cardMap, candidateId, previousId = null) {
  const candId = normalizeStr(candidateId);
  const prevId = previousId == null ? null : (normalizeStr(previousId) || null);
  if (!candId) throw new Error('Требуется candidateId');
  if (prevId && candId === prevId) throw new Error('candidateId и previousId не должны совпадать');

  const candidate = cardMap.get(candId);
  if (!candidate) throw new Error(`Карточка-кандидат не найдена: ${candId}`);

  if (hasSpoofedOrigin(candidate)) {
    throw makeAuditError('Подделка или несоответствие origin у карточки-кандидата', 'invalid_origin', { cardId: candId });
  }
  if (isTorTaintedCard(candidate)) {
    throw makeAuditError('Продвижение заблокировано: обнаружен Tor-источник или карантин', 'invalid_origin', { cardId: candId });
  }
  if (!CANDIDATE_STATUSES.has(candidate.status)) {
    throw new Error(`Недопустимый статус кандидата (${candidate.status}) для ${candId}`);
  }

  const candLayer = normalizeLayer(candidate.layer);
  if (!ACTIVE_LAYERS.has(candLayer)) {
    throw new Error(`Неподдерживаемый целевой слой: ${candidate.layer}`);
  }
  const candTopic = normalizeStr(candidate.topic);
  if (!candTopic) throw new Error(`У кандидата ${candId} отсутствует тема topic`);
  if (!hasValidProvenance(candidate)) {
    throw new Error(`Отсутствует подтверждённый провенанс или evidence у ${candId}`);
  }

  let previous = null;
  if (prevId === null) {
    const existingActive = cards.find(
      (c) =>
        c.id !== candId &&
        c.status === 'verified' &&
        normalizeLayer(c.layer) === candLayer &&
        normalizeStr(c.topic) === candTopic,
    );
    if (existingActive) {
      throw new Error(`В слое ${candLayer} уже есть активная карточка по теме ${candTopic} (${existingActive.id}); требуется замена`);
    }
  } else {
    previous = cardMap.get(prevId);
    if (!previous) throw new Error(`Прежняя карточка не найдена: ${prevId}`);
    if (hasSpoofedOrigin(previous) || isTorTaintedCard(previous)) {
      throw makeAuditError('Продвижение заблокировано: Tor-метка или поддельный origin у прежней карточки', 'invalid_origin', { cardId: prevId });
    }
    if (previous.status !== 'verified') {
      throw new Error(`Прежняя карточка должна иметь статус verified (${previous.status}) для ${prevId}`);
    }
    const prevLayer = normalizeLayer(previous.layer);
    if (candLayer !== prevLayer) {
      throw new Error(`Слои карточек не совпадают или не поддерживаются: ${candLayer} vs ${prevLayer}`);
    }
    if (candTopic !== normalizeStr(previous.topic)) {
      throw new Error(`Темы карточек не совпадают: ${candTopic} vs ${normalizeStr(previous.topic)}`);
    }
    if (!hasValidProvenance(previous)) {
      throw new Error(`Отсутствует подтверждённый провенанс или evidence у ${prevId}`);
    }
  }

  return { candidate, previous };
}

function buildPromotedPair(candidate, previous, operationId = null) {
  const next = {
    ...clone(candidate),
    status: 'verified',
    evidence: mergeEvidence(candidate, previous),
    ...(previous ? { supersedes: previous.id } : {}),
    ...(operationId ? { promotionOperationId: operationId } : {}),
  };
  if (next.rollbackOf) delete next.rollbackOf;

  const archivedPrevious = previous
    ? {
      ...clone(previous),
      status: 'archived',
      supersededBy: candidate.id,
      ...(operationId ? { archivedByOperationId: operationId } : {}),
    }
    : null;
  return { next, archivedPrevious };
}

function buildRollbackCards(currentCandidate, currentPrevious, rollbackOperationId) {
  const archivedCard = {
    ...clone(currentCandidate),
    status: 'archived',
    rollbackOf: rollbackOperationId,
    evidence: clone(currentCandidate.evidence),
  };
  delete archivedCard.promotionOperationId;

  let restoredPrevious = null;
  if (currentPrevious) {
    restoredPrevious = {
      ...clone(currentPrevious),
      status: 'verified',
      restoredByRollbackId: rollbackOperationId,
      evidence: clone(currentPrevious.evidence),
    };
    delete restoredPrevious.supersededBy;
    delete restoredPrevious.archivedByOperationId;
  }
  return { archivedCard, restoredPrevious };
}

function atomicWriteText(targetPath, text) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${base}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(tmpPath, 'wx', 0o600);
  try {
    fs.writeSync(fd, text, 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  withWinRetry(() => fs.renameSync(tmpPath, targetPath));
  try {
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {
    // Directory fsync unsupported on Windows.
  }
}

function safeUnlink(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return;
  withWinRetry(() => fs.unlinkSync(targetPath));
}

function isIgnoredJournalEntry(dirent) {
  if (!dirent.isFile()) return true;
  const name = dirent.name;
  if (name.startsWith('.') || name.includes('.tmp')) return true;
  return !name.endsWith('.ndjson');
}

function readCommittedOps(journalDir) {
  if (!fs.existsSync(journalDir)) return [];
  const entries = fs.readdirSync(journalDir, { withFileTypes: true });
  const ops = [];

  for (const dirent of entries) {
    if (isIgnoredJournalEntry(dirent)) continue;
    const raw = fs.readFileSync(path.join(journalDir, dirent.name), 'utf8').trim();
    if (!raw || raw.includes('\n')) throw new Error(`Некорректная запись NDJSON в файле ${dirent.name}`);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Повреждённый JSON в файле ${dirent.name}`);
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Number.isInteger(parsed.seq) ||
      parsed.seq < 1 ||
      !normalizeStr(parsed.operationId) ||
      !normalizeStr(parsed.expectedVersion) ||
      !normalizeStr(parsed.newVersion)
    ) {
      throw new Error(`Неполная запись операции в файле ${dirent.name}`);
    }
    ops.push(parsed);
  }

  ops.sort((a, b) => a.seq - b.seq);
  const seenIds = new Set();
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    if (op.seq !== i + 1) throw new Error(`Нарушена последовательность журнала: ожидался seq ${i + 1}, получен ${op.seq}`);
    if (seenIds.has(op.operationId)) throw new Error(`Дублирующий operationId в журнале: ${op.operationId}`);
    seenIds.add(op.operationId);
  }
  return ops;
}

function readAuditLog(journalDir) {
  const auditPath = path.join(journalDir, AUDIT_FILE);
  if (!fs.existsSync(auditPath)) return [];
  const lines = fs.readFileSync(auditPath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  return lines.map((line) => JSON.parse(line));
}

function appendAuditEvent(journalDir, event) {
  fs.mkdirSync(journalDir, { recursive: true });
  const auditPath = path.join(journalDir, AUDIT_FILE);
  const existing = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
  const nextLine = `${JSON.stringify({ ...event, at: event.at || new Date().toISOString() })}\n`;
  atomicWriteText(auditPath, existing + nextLine);
}

function publishNdjsonRecord(journalDir, finalFileName, line, beforePublishHook) {
  fs.mkdirSync(journalDir, { recursive: true });
  const finalPath = path.join(journalDir, finalFileName);
  if (fs.existsSync(finalPath)) {
    throw new Error(`Целевой файл операции уже существует: ${finalFileName}`);
  }
  const tmpPath = path.join(journalDir, `.${finalFileName}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(tmpPath, 'wx', 0o600);
  try {
    fs.writeSync(fd, line, 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (typeof beforePublishHook === 'function') beforePublishHook({ tmpPath, finalPath });
  withWinRetry(() => fs.renameSync(tmpPath, finalPath));
  try {
    const dirFd = fs.openSync(journalDir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {
    // Directory fsync unsupported on Windows.
  }
}

function assertSingleActivePerLineage(cards) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const activeTopics = new Set();
  for (const card of cards) {
    if (card.status === 'verified') {
      const key = `${normalizeLayer(card.layer)}::${normalizeStr(card.topic)}`;
      if (card.topic && activeTopics.has(key)) {
        throw new Error(`Инвариант одной активной версии нарушен для темы ${key}`);
      }
      if (card.topic) activeTopics.add(key);
      if (card.supersedes) {
        const target = byId.get(card.supersedes);
        if (!target || target.status !== 'archived') {
          throw new Error(`Инвариант одной активной версии нарушен для ${card.id} -> ${card.supersedes}`);
        }
      }
    }
  }
}

function buildCoreHandlers({ journalDir, loadBaseCards, onBeforeJournal, onAfterCommit }) {
  let writing = false;

  const deriveState = () => {
    const baseCards = clone(loadBaseCards());
    const ops = readCommittedOps(journalDir);
    const audits = readAuditLog(journalDir);
    const cardMap = new Map(baseCards.map((c) => [c.id, c]));

    for (const op of ops) {
      if (op.type === 'rollback') {
        if (!cardMap.has(op.candidateId) || (op.previousId && !cardMap.has(op.previousId))) {
          throw new Error(`Операция отката ${op.operationId} ссылается на неизвестную карточку`);
        }
        cardMap.set(op.candidateId, clone(op.archived));
        if (op.previousId && op.restored) cardMap.set(op.previousId, clone(op.restored));
      } else {
        if (!cardMap.has(op.candidateId) || (op.previousId && !cardMap.has(op.previousId))) {
          throw new Error(`Операция ${op.operationId} ссылается на неизвестную карточку`);
        }
        if (op.previousId && op.previous) cardMap.set(op.previousId, clone(op.previous));
        cardMap.set(op.candidateId, clone(op.next));
      }
    }

    const orderedCards = baseCards.map((c) => cardMap.get(c.id));
    assertSingleActivePerLineage(orderedCards);

    return {
      version: computeStateVersion(orderedCards, ops.length),
      cards: orderedCards,
      cardMap: new Map(orderedCards.map((c) => [c.id, c])),
      ops,
      opsById: new Map(ops.map((o) => [o.operationId, o])),
      cancelledIds: new Set(audits.filter((e) => e.event === 'cancelled').map((e) => e.operationId)),
      audits,
    };
  };

  function read() {
    const state = deriveState();
    return { version: state.version, cards: clone(state.cards), operations: clone(state.ops) };
  }

  function auditEvents() {
    return clone(readAuditLog(journalDir));
  }

  function preview(candidateId, previousId = null) {
    const state = deriveState();
    let candidate;
    let previous;
    try {
      ({ candidate, previous } = validatePromotionPair(state.cards, state.cardMap, candidateId, previousId));
    } catch (err) {
      if (err.auditCode) {
        appendAuditEvent(journalDir, { event: err.auditCode, candidateId, previousId, reason: err.message });
      }
      throw err;
    }
    const { next, archivedPrevious } = buildPromotedPair(candidate, previous);
    const prevIdVal = previous ? previous.id : null;
    const previewHash = computePreviewHash({
      candidateId: candidate.id,
      previousId: prevIdVal,
      version: state.version,
      next,
      archivedPrevious,
    });
    return {
      version: state.version,
      previewHash,
      candidateId: candidate.id,
      previousId: prevIdVal,
      previous: clone(previous),
      archivedPrevious,
      next,
    };
  }

  function cancel(previewData, operationId) {
    const opId = normalizeStr(operationId || previewData?.operationId);
    if (!opId || /[\r\n]/.test(opId)) throw new Error('Требуется корректный непустой operationId');
    const state = deriveState();
    if (state.opsById.has(opId)) {
      throw new Error(`Нельзя отменить уже зафиксированную операцию ${opId}`);
    }
    if (!state.cancelledIds.has(opId)) {
      appendAuditEvent(journalDir, {
        event: 'cancelled',
        operationId: opId,
        candidateId: normalizeStr(previewData?.candidateId) || null,
        previousId: previewData?.previousId ?? null,
        version: normalizeStr(previewData?.version) || null,
      });
    }
    return { ok: true, cancelled: true, operationId: opId };
  }

  function confirm(previewData, operationId) {
    if (writing) throw new Error('Конкурентная запись заблокирована (single-writer)');
    const opId = normalizeStr(operationId || previewData?.operationId);
    if (!opId || /[\r\n]/.test(opId)) throw new Error('Требуется корректный непустой operationId');
    if (!previewData || typeof previewData !== 'object') throw new Error('Требуется объект preview');

    writing = true;
    try {
      const state = deriveState();
      if (state.cancelledIds.has(opId)) {
        appendAuditEvent(journalDir, { event: 'confirm_after_cancel', operationId: opId, candidateId: previewData.candidateId });
        throw new Error(`Операция ${opId} была отменена пользователем`);
      }

      const existing = state.opsById.get(opId);
      const reqPrevId = previewData.previousId ?? null;
      if (existing) {
        const matches =
          existing.type !== 'rollback' &&
          previewData.candidateId === existing.candidateId &&
          reqPrevId === (existing.previousId ?? null) &&
          previewData.version === existing.expectedVersion;
        if (!matches) {
          appendAuditEvent(journalDir, { event: 'idempotency_conflict', operationId: opId, candidateId: previewData.candidateId });
          throw new Error(`Конфликт operationId ${opId}: параметры не совпадают с завершённой операцией`);
        }
        return clone({
          operationId: existing.operationId,
          version: existing.newVersion,
          previous: existing.previous ?? null,
          next: existing.next,
        });
      }

      if (previewData.version !== state.version) {
        appendAuditEvent(journalDir, { event: 'stale_preview', operationId: opId, expected: state.version, got: previewData.version });
        throw new Error(`Устаревший preview: ожидалась версия ${state.version}, передана ${previewData.version}`);
      }

      let candidate;
      let previous;
      try {
        ({ candidate, previous } = validatePromotionPair(state.cards, state.cardMap, previewData.candidateId, reqPrevId));
      } catch (err) {
        if (err.auditCode) {
          appendAuditEvent(journalDir, { event: err.auditCode, operationId: opId, candidateId: previewData.candidateId, reason: err.message });
        }
        throw err;
      }

      if (previewData.previewHash) {
        const expectedPair = buildPromotedPair(candidate, previous);
        const actualHash = computePreviewHash({
          candidateId: candidate.id,
          previousId: previous ? previous.id : null,
          version: state.version,
          next: expectedPair.next,
          archivedPrevious: expectedPair.archivedPrevious,
        });
        if (previewData.previewHash !== actualHash) {
          appendAuditEvent(journalDir, { event: 'stale_preview', operationId: opId, reason: 'previewHash mismatch' });
          throw new Error('Устаревший preview: хэш предпросмотра не совпадает');
        }
      }

      const { next, archivedPrevious } = buildPromotedPair(candidate, previous, opId);
      const nextCards = state.cards.map((card) => {
        if (card.id === next.id) return next;
        if (archivedPrevious && card.id === archivedPrevious.id) return archivedPrevious;
        return card;
      });
      assertSingleActivePerLineage(nextCards);

      const seq = state.ops.length + 1;
      const newVersion = computeStateVersion(nextCards, seq);
      const record = {
        v: 1,
        type: 'promote',
        seq,
        operationId: opId,
        candidateId: candidate.id,
        previousId: previous ? previous.id : null,
        expectedVersion: state.version,
        newVersion,
        previous: archivedPrevious,
        next,
      };

      const opHash = crypto.createHash('sha256').update(opId).digest('hex').slice(0, 12);
      const finalFileName = `${String(seq).padStart(6, '0')}-${opHash}.ndjson`;
      const enriched = onBeforeJournal ? onBeforeJournal(record, candidate, previous) : record;
      publishNdjsonRecord(journalDir, finalFileName, `${JSON.stringify(enriched)}\n`);
      if (onAfterCommit) onAfterCommit(enriched);

      return clone({
        operationId: opId,
        version: newVersion,
        previous: archivedPrevious,
        next,
      });
    } finally {
      writing = false;
    }
  }

  function rollback(rollbackOperationId, targetOperationId) {
    if (writing) throw new Error('Конкурентная запись заблокирована (single-writer)');
    const rbId = normalizeStr(rollbackOperationId);
    const targetId = normalizeStr(targetOperationId);
    if (!rbId || /[\r\n]/.test(rbId) || !targetId) throw new Error('Требуются rollbackOperationId и targetOperationId');
    if (rbId === targetId) throw new Error('rollbackOperationId не должен совпадать с targetOperationId');

    writing = true;
    try {
      const state = deriveState();
      const existingRb = state.opsById.get(rbId);
      if (existingRb) {
        if (existingRb.type !== 'rollback' || existingRb.targetOperationId !== targetId) {
          appendAuditEvent(journalDir, { event: 'idempotency_conflict', operationId: rbId, targetOperationId: targetId });
          throw new Error(`Конфликт operationId ${rbId}: параметры отката не совпадают`);
        }
        return clone({
          operationId: existingRb.operationId,
          targetOperationId: existingRb.targetOperationId,
          version: existingRb.newVersion,
          archived: existingRb.archived,
          restored: existingRb.restored ?? null,
        });
      }

      const targetOp = state.opsById.get(targetId);
      if (!targetOp || targetOp.type === 'rollback') {
        throw new Error(`Целевая операция для отката не найдена: ${targetId}`);
      }
      const priorRollback = state.ops.find((o) => o.type === 'rollback' && o.targetOperationId === targetId);
      if (priorRollback) {
        throw new Error(`Операция ${targetId} уже откачена (${priorRollback.operationId})`);
      }

      const currentCandidate = state.cardMap.get(targetOp.candidateId);
      const currentPrevious = targetOp.previousId ? state.cardMap.get(targetOp.previousId) : null;
      if (!currentCandidate || currentCandidate.status !== 'verified') {
        throw new Error(`Нельзя откатить ${targetId}: карточка ${targetOp.candidateId} не в статусе verified`);
      }
      if (currentPrevious && (currentPrevious.status !== 'archived' || currentPrevious.supersededBy !== currentCandidate.id)) {
        throw new Error(`Нельзя откатить ${targetId}: нарушена связь архивации ${targetOp.previousId}`);
      }

      const { archivedCard, restoredPrevious } = buildRollbackCards(currentCandidate, currentPrevious, rbId);
      const nextCards = state.cards.map((card) => {
        if (card.id === archivedCard.id) return archivedCard;
        if (restoredPrevious && card.id === restoredPrevious.id) return restoredPrevious;
        return card;
      });
      assertSingleActivePerLineage(nextCards);

      const seq = state.ops.length + 1;
      const newVersion = computeStateVersion(nextCards, seq);
      const record = {
        v: 1,
        type: 'rollback',
        seq,
        operationId: rbId,
        targetOperationId: targetId,
        candidateId: archivedCard.id,
        previousId: restoredPrevious ? restoredPrevious.id : null,
        expectedVersion: state.version,
        newVersion,
        archived: archivedCard,
        restored: restoredPrevious,
      };

      const opHash = crypto.createHash('sha256').update(rbId).digest('hex').slice(0, 12);
      const finalFileName = `${String(seq).padStart(6, '0')}-${opHash}.ndjson`;
      const enriched = onBeforeJournal ? onBeforeJournal(record, currentCandidate, currentPrevious, targetOp) : record;
      publishNdjsonRecord(journalDir, finalFileName, `${JSON.stringify(enriched)}\n`);
      if (onAfterCommit) onAfterCommit(enriched);

      return clone({
        operationId: rbId,
        targetOperationId: targetId,
        version: newVersion,
        archived: archivedCard,
        restored: restoredPrevious,
      });
    } finally {
      writing = false;
    }
  }

  return { read, preview, cancel, confirm, rollback, auditEvents, deriveState };
}

function createPromotionPilot({ journalDir, cards, beforePublish } = {}) {
  if (!normalizeStr(journalDir)) throw new Error('Требуется journalDir');
  if (!Array.isArray(cards)) throw new Error('Требуется массив начальных карточек cards');
  const initialCards = clone(cards);
  const ids = new Set();
  for (const c of initialCards) {
    if (!c || typeof c !== 'object' || !normalizeStr(c.id)) throw new Error('Каждая карточка должна иметь строковый id');
    if (ids.has(c.id)) throw new Error(`Дублирующий id карточки: ${c.id}`);
    ids.add(c.id);
  }

  let beforeJournalRecord = null;
  const origPublish = publishNdjsonRecord;
  const core = buildCoreHandlers({
    journalDir,
    loadBaseCards: () => initialCards,
    onBeforeJournal: (record) => {
      beforeJournalRecord = record;
      return record;
    },
    onAfterCommit: null,
  });

  // Preserve exact beforePublish hook signature on confirm for the synthetic pilot
  const confirm = (previewData, operationId) => {
    const opId = normalizeStr(operationId || previewData?.operationId);
    const existing = opId && readCommittedOps(journalDir).find((o) => o.operationId === opId);
    if (!existing && typeof beforePublish === 'function') {
      // Probe validation & write via wrapped publish helper by wrapping beforePublish once
      const origOpen = fs.renameSync;
      let fired = false;
      fs.renameSync = function patchedRename(from, to) {
        if (!fired && String(to).endsWith('.ndjson')) {
          fired = true;
          beforePublish({ tmpPath: from, finalPath: to, record: clone(beforeJournalRecord) });
        }
        return origOpen.apply(this, arguments);
      };
      try {
        return core.confirm(previewData, operationId);
      } finally {
        fs.renameSync = origOpen;
      }
    }
    return core.confirm(previewData, operationId);
  };

  void origPublish;
  return {
    read: core.read,
    preview: core.preview,
    cancel: core.cancel,
    confirm,
    rollback: core.rollback,
    auditEvents: core.auditEvents,
  };
}

// ---------- Markdown YAML Frontmatter Parser / Serializer ----------

function parseYamlScalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
    try { return JSON.parse(s); } catch { /* treat as string */ }
  }
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function formatYamlScalar(value) {
  if (typeof value === 'boolean' || value === null) return String(value);
  const s = String(value ?? '');
  if (/[\r\n:#"'{}[\],&*!|>%@`]|^\s|\s$/.test(s) || /^(?:true|false|null)$/i.test(s) || s === '') {
    return JSON.stringify(s);
  }
  return s;
}

function parseFrontmatter(source) {
  const normalized = String(source || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(normalized);
  if (!match) return { meta: {}, keyOrder: [], body: normalized.trim() };

  const lines = match[1].split('\n');
  const meta = {};
  const keyOrder = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) { i += 1; continue; }
    const kv = /^([A-Za-z0-9_\-\p{L}]+)\s*:\s*(.*)$/u.exec(line);
    if (!kv) { i += 1; continue; }
    const key = kv[1].trim();
    const rest = kv[2];
    if (!keyOrder.includes(key)) keyOrder.push(key);

    if (rest.trim() === '' && i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
      const items = [];
      i += 1;
      while (i < lines.length && /^\s+/.test(lines[i])) {
        const listMatch = /^\s+-\s*(.*)$/.exec(lines[i]);
        if (listMatch) {
          const itemLine = listMatch[1].trim();
          const subKv = /^([A-Za-z0-9_\-\p{L}]+)\s*:\s*(.*)$/u.exec(itemLine);
          if (subKv) {
            const obj = { [subKv[1]]: parseYamlScalar(subKv[2]) };
            i += 1;
            while (i < lines.length && /^\s{2,}[^\s-]/.test(lines[i])) {
              const cont = /^\s+([A-Za-z0-9_\-\p{L}]+)\s*:\s*(.*)$/u.exec(lines[i]);
              if (cont) obj[cont[1]] = parseYamlScalar(cont[2]);
              i += 1;
            }
            items.push(obj);
            continue;
          }
          items.push(parseYamlScalar(itemLine));
        }
        i += 1;
      }
      meta[key] = items;
      continue;
    }

    meta[key] = parseYamlScalar(rest);
    i += 1;
  }

  return { meta, keyOrder, body: (match[2] ?? '').replace(/\r\n/g, '\n').trim() };
}

function serializeFrontmatter(meta, body, keyOrder = []) {
  const ordered = [...keyOrder.filter((k) => Object.hasOwn(meta, k) && meta[k] !== undefined)];
  for (const k of Object.keys(meta)) {
    if (meta[k] !== undefined && !ordered.includes(k)) ordered.push(k);
  }
  const lines = ['---'];
  for (const key of ordered) {
    const val = meta[key];
    if (Array.isArray(val)) {
      lines.push(`${key}: ${JSON.stringify(val)}`);
    } else if (val && typeof val === 'object') {
      lines.push(`${key}: ${JSON.stringify(val)}`);
    } else {
      lines.push(`${key}: ${formatYamlScalar(val)}`);
    }
  }
  lines.push('---', String(body ?? '').replace(/\r\n/g, '\n').trim(), '');
  const out = lines.join('\n');
  const verify = parseFrontmatter(out);
  if (!out.startsWith('---\n') || !out.includes('\n---\n') || !Object.keys(verify.meta).length) {
    throw new Error('Ошибка проверки закрывающего --- перед записью Markdown');
  }
  return out;
}

// ---------- Vault Markdown Store & WAL Reconciler ----------

function resolveVaultRoot(vaultDir) {
  const s = normalizeStr(vaultDir);
  if (!s) throw new Error('Требуется vaultDir');
  return path.basename(s).toLowerCase() === 'capri' ? path.dirname(s) : s;
}

function findExistingDir(root, names) {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const candidate of names) {
      const hit = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === candidate.toLowerCase());
      if (hit) return hit.name;
    }
  } catch { /* ignore */ }
  return names[0];
}

function safeCardFileName(name, fallbackId) {
  const base = normalizeStr(name).replace(/[\\/:*?"<>|#^[\]\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const clean = base || normalizeStr(fallbackId).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'card';
  return clean.endsWith('.md') ? clean : `${clean}.md`;
}

function pickUniqueRelPath(root, folderRel, fileName) {
  let candidate = path.posix.join(folderRel, fileName);
  if (!fs.existsSync(path.join(root, ...candidate.split('/')))) return candidate;
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, -ext.length);
  for (let n = 2; n < 1000; n += 1) {
    candidate = path.posix.join(folderRel, `${stem} (${n})${ext}`);
    if (!fs.existsSync(path.join(root, ...candidate.split('/')))) return candidate;
  }
  return path.posix.join(folderRel, `${stem}-${crypto.randomUUID().slice(0, 8)}${ext}`);
}

function readMarkdownCardsFromDir(root, folderRel, defaultLayer, defaultStatus) {
  const fullDir = path.join(root, ...folderRel.split('/'));
  if (!fs.existsSync(fullDir)) return [];
  const entries = fs.readdirSync(fullDir, { withFileTypes: true });
  const list = [];

  for (const dirent of entries) {
    if (!dirent.isFile() || dirent.name.startsWith('.') || dirent.name.includes('.tmp')) continue;
    if (!dirent.name.toLowerCase().endsWith('.md')) continue;
    const relPath = path.posix.join(folderRel, dirent.name);
    const raw = fs.readFileSync(path.join(fullDir, dirent.name), 'utf8');
    const { meta, keyOrder, body } = parseFrontmatter(raw);
    const id = normalizeStr(meta.id) || dirent.name.slice(0, -3);
    const source = normalizeStr(meta.source || meta.tor_origin || meta.origin);
    const provenance = meta.provenance && typeof meta.provenance === 'object'
      ? meta.provenance
      : (source ? { source } : undefined);
    const evidence = Array.isArray(meta.evidence)
      ? meta.evidence
      : ((meta.quote || meta.link || meta.source_ref)
        ? [{ ...(meta.book ? { book: meta.book } : {}), ...(meta.link ? { link: meta.link } : {}), ...(meta.source_ref ? { source_ref: meta.source_ref } : {}), ...(meta.quote ? { quote: meta.quote } : {}), ...(source ? { source } : {}) }]
        : []);

    list.push({
      id,
      layer: normalizeLayer(meta.layer || defaultLayer),
      topic: normalizeStr(meta.topic),
      status: normalizeStr(meta.status) || defaultStatus,
      claim: body || normalizeStr(meta.claim),
      ...(source ? { source } : {}),
      ...(meta.origin ? { origin: meta.origin } : {}),
      ...(meta.tor_origin ? { tor_origin: meta.tor_origin } : {}),
      ...(meta.source_class ? { source_class: meta.source_class } : {}),
      ...(meta.tor !== undefined ? { tor: meta.tor } : {}),
      ...(meta.torTainted !== undefined ? { torTainted: meta.torTainted } : {}),
      ...(meta.torState ? { torState: meta.torState } : {}),
      ...(meta.quarantined !== undefined ? { quarantined: meta.quarantined } : {}),
      ...(provenance ? { provenance } : {}),
      evidence,
      ...(meta.supersedes ? { supersedes: meta.supersedes } : {}),
      ...(meta.superseded_by ? { supersededBy: meta.superseded_by } : {}),
      ...(meta.rollback_of ? { rollbackOf: meta.rollback_of } : {}),
      _meta: meta,
      _keyOrder: keyOrder,
      _relPath: relPath,
    });
  }
  return list;
}

function cardToMarkdown(card, baseCard) {
  const meta = { ...(baseCard?._meta || {}) };
  const keyOrder = [...(baseCard?._keyOrder || [])];
  meta.id = card.id;
  meta.status = card.status;
  meta.layer = normalizeLayer(card.layer);
  if (card.topic) meta.topic = card.topic;
  if (card.source) meta.source = card.source;
  if (card.provenance) meta.provenance = card.provenance;
  meta.evidence = card.evidence;

  if (card.supersedes) meta.supersedes = card.supersedes;
  else delete meta.supersedes;
  if (card.supersededBy) meta.superseded_by = card.supersededBy;
  else delete meta.superseded_by;
  if (card.rollbackOf) meta.rollback_of = card.rollbackOf;
  else delete meta.rollback_of;
  if (card.promotionOperationId) meta.promotion_operation_id = card.promotionOperationId;
  else delete meta.promotion_operation_id;
  if (card.restoredByRollbackId) meta.restored_by_rollback_id = card.restoredByRollbackId;
  else delete meta.restored_by_rollback_id;

  return serializeFrontmatter(meta, card.claim || '', keyOrder);
}

function applyCommittedDiskOp(root, op, beforeDiskStep) {
  const step = (name) => {
    if (typeof beforeDiskStep === 'function') beforeDiskStep(name, { op: clone(op) });
  };
  const abs = (rel) => path.join(root, ...String(rel).split('/'));

  if (op.type === 'rollback') {
    const activeRemoveFull = abs(op.activeRemovePath);
    const rbArchiveFull = abs(op.rollbackArchivePath);
    step('before_rollback_archive_write');
    if (!fs.existsSync(rbArchiveFull) || fs.readFileSync(rbArchiveFull, 'utf8') !== op.archivedMarkdown) {
      atomicWriteText(rbArchiveFull, op.archivedMarkdown);
    }
    step('before_rollback_active_unlink');
    if (fs.existsSync(activeRemoveFull)) {
      if (!op.restoredActivePath || activeRemoveFull !== abs(op.restoredActivePath)) {
        safeUnlink(activeRemoveFull);
      }
    }
    if (op.restoredActivePath && op.restoredMarkdown) {
      const restoredFull = abs(op.restoredActivePath);
      step('before_rollback_restore_write');
      if (!fs.existsSync(restoredFull) || fs.readFileSync(restoredFull, 'utf8') !== op.restoredMarkdown) {
        atomicWriteText(restoredFull, op.restoredMarkdown);
      }
      if (op.oldArchivePath) {
        step('before_rollback_archive_unlink');
        safeUnlink(abs(op.oldArchivePath));
      }
    }
    return;
  }

  const activeFull = abs(op.activePath);
  if (op.oldActivePath && op.archivePath && op.archivedPreviousMarkdown) {
    const oldActiveFull = abs(op.oldActivePath);
    const archiveFull = abs(op.archivePath);
    const alreadyReplacedSamePath =
      oldActiveFull === activeFull &&
      fs.existsSync(activeFull) &&
      fs.readFileSync(activeFull, 'utf8') === op.nextMarkdown;

    if (!alreadyReplacedSamePath) {
      step('before_archive_write');
      if (!fs.existsSync(archiveFull) || fs.readFileSync(archiveFull, 'utf8') !== op.archivedPreviousMarkdown) {
        atomicWriteText(archiveFull, op.archivedPreviousMarkdown);
      }
      step('before_old_active_unlink');
      safeUnlink(oldActiveFull);
    }
  }

  step('before_active_write');
  if (!fs.existsSync(activeFull) || fs.readFileSync(activeFull, 'utf8') !== op.nextMarkdown) {
    atomicWriteText(activeFull, op.nextMarkdown);
  }
  if (op.srcPath) {
    step('before_candidate_unlink');
    safeUnlink(abs(op.srcPath));
  }
}

function reconcileVaultJournal(vaultDir, journalDir, beforeDiskStep = null) {
  if (!normalizeStr(vaultDir) || !normalizeStr(journalDir) || !fs.existsSync(journalDir)) return 0;
  const root = resolveVaultRoot(vaultDir);
  const ops = readCommittedOps(journalDir);
  if (!ops.length) return 0;
  applyCommittedDiskOp(root, ops[ops.length - 1], beforeDiskStep);
  return ops.length;
}

function loadVaultCards(root) {
  const pendingDir = findExistingDir(root, [PENDING_REVIEW_DIR]);
  const trunkDir = findExistingDir(root, ['10_Ствол', '10_ствол']);
  const crownDir = findExistingDir(root, ['20_Крона', '20_крона']);
  const archiveDir = findExistingDir(root, [ARCHIVE_DIR, '90_архив']);
  return [
    ...readMarkdownCardsFromDir(root, pendingDir, '20_крона', 'candidate'),
    ...readMarkdownCardsFromDir(root, trunkDir, '10_ствол', 'verified'),
    ...readMarkdownCardsFromDir(root, crownDir, '20_крона', 'verified'),
    ...readMarkdownCardsFromDir(root, archiveDir, '90_архив', 'archived'),
  ];
}

function stripInternalFields(card) {
  if (!card || typeof card !== 'object') return card;
  const { _meta, _keyOrder, _relPath, ...rest } = card;
  void _meta;
  void _keyOrder;
  void _relPath;
  return rest;
}

function createVaultPromotionStore({ vaultDir, journalDir, beforeDiskStep } = {}) {
  if (!normalizeStr(journalDir)) throw new Error('Требуется journalDir');
  const root = resolveVaultRoot(vaultDir);

  let diskCards = [];
  const reloadFromDisk = () => {
    reconcileVaultJournal(root, journalDir, beforeDiskStep);
    diskCards = loadVaultCards(root);
    return diskCards;
  };

  // Drive validation through core handlers using live disk cards (post-reconcile);
  // committed ops already applied on disk are skipped during replay when card already reflects disk state.
  const loadCardsForCore = () => reloadFromDisk().map(stripInternalFields);

  const deriveDiskState = () => {
    const cards = loadCardsForCore();
    const ops = readCommittedOps(journalDir);
    const audits = readAuditLog(journalDir);
    assertSingleActivePerLineage(cards);
    return {
      version: computeStateVersion(cards, ops.length),
      cards,
      cardMap: new Map(cards.map((c) => [c.id, c])),
      ops,
      opsById: new Map(ops.map((o) => [o.operationId, o])),
      cancelledIds: new Set(audits.filter((e) => e.event === 'cancelled').map((e) => e.operationId)),
    };
  };

  let writing = false;

  const read = () => {
    const state = deriveDiskState();
    return { version: state.version, cards: clone(state.cards), operations: clone(state.ops) };
  };

  const auditEvents = () => clone(readAuditLog(journalDir));

  const preview = (candidateId, previousId = null) => {
    const state = deriveDiskState();
    let candidate;
    let previous;
    try {
      ({ candidate, previous } = validatePromotionPair(state.cards, state.cardMap, candidateId, previousId));
    } catch (err) {
      if (err.auditCode) {
        appendAuditEvent(journalDir, { event: err.auditCode, candidateId, previousId, reason: err.message });
      }
      throw err;
    }
    const { next, archivedPrevious } = buildPromotedPair(candidate, previous);
    const prevIdVal = previous ? previous.id : null;
    const previewHash = computePreviewHash({
      candidateId: candidate.id,
      previousId: prevIdVal,
      version: state.version,
      next,
      archivedPrevious,
    });
    return {
      operationId: crypto.randomUUID(),
      version: state.version,
      previewHash,
      candidateId: candidate.id,
      previousId: prevIdVal,
      previous: clone(previous),
      archivedPrevious,
      next,
    };
  };

  const findPreview = (query = '') => {
    const state = deriveDiskState();
    const q = normalizeStr(query).toLowerCase();
    const candidates = state.cards.filter((c) => CANDIDATE_STATUSES.has(c.status));
    if (!candidates.length) return null;

    const match = q
      ? candidates.find((c) => `${c.id} ${c.topic} ${c.claim}`.toLowerCase().includes(q))
      : candidates[0];
    if (!match) return null;

    const candLayer = normalizeLayer(match.layer);
    const activeMatch = state.cards.find(
      (c) =>
        c.status === 'verified' &&
        normalizeLayer(c.layer) === candLayer &&
        normalizeStr(c.topic) === normalizeStr(match.topic),
    );
    return preview(match.id, activeMatch ? activeMatch.id : null);
  };

  const cancel = (previewData, operationId) => {
    const opId = normalizeStr(operationId || previewData?.operationId);
    if (!opId || /[\r\n]/.test(opId)) throw new Error('Требуется корректный непустой operationId');
    const state = deriveDiskState();
    if (state.opsById.has(opId)) throw new Error(`Нельзя отменить уже зафиксированную операцию ${opId}`);
    if (!state.cancelledIds.has(opId)) {
      appendAuditEvent(journalDir, {
        event: 'cancelled',
        operationId: opId,
        candidateId: normalizeStr(previewData?.candidateId) || null,
        previousId: previewData?.previousId ?? null,
        version: normalizeStr(previewData?.version) || null,
      });
    }
    return { ok: true, cancelled: true, operationId: opId };
  };

  const confirm = (previewData, operationId) => {
    if (writing) throw new Error('Конкурентная запись заблокирована (single-writer)');
    const opId = normalizeStr(operationId || previewData?.operationId);
    if (!opId || /[\r\n]/.test(opId)) throw new Error('Требуется корректный непустой operationId');
    if (!previewData || typeof previewData !== 'object') throw new Error('Требуется объект preview');

    writing = true;
    try {
      const state = deriveDiskState();
      if (state.cancelledIds.has(opId)) {
        appendAuditEvent(journalDir, { event: 'confirm_after_cancel', operationId: opId, candidateId: previewData.candidateId });
        throw new Error(`Операция ${opId} была отменена пользователем`);
      }

      const existing = state.opsById.get(opId);
      const reqPrevId = previewData.previousId ?? null;
      if (existing) {
        const matches =
          existing.type !== 'rollback' &&
          previewData.candidateId === existing.candidateId &&
          reqPrevId === (existing.previousId ?? null) &&
          previewData.version === existing.expectedVersion;
        if (!matches) {
          appendAuditEvent(journalDir, { event: 'idempotency_conflict', operationId: opId, candidateId: previewData.candidateId });
          throw new Error(`Конфликт operationId ${opId}: параметры не совпадают с завершённой операцией`);
        }
        return clone({ operationId: existing.operationId, version: existing.newVersion, previous: existing.previous ?? null, next: existing.next });
      }

      if (previewData.version !== state.version) {
        appendAuditEvent(journalDir, { event: 'stale_preview', operationId: opId, expected: state.version, got: previewData.version });
        throw new Error(`Устаревший preview: ожидалась версия ${state.version}, передана ${previewData.version}`);
      }

      let candidate;
      let previous;
      try {
        ({ candidate, previous } = validatePromotionPair(state.cards, state.cardMap, previewData.candidateId, reqPrevId));
      } catch (err) {
        if (err.auditCode) {
          appendAuditEvent(journalDir, {
            event: err.auditCode,
            operationId: opId,
            candidateId: previewData.candidateId,
            previousId: reqPrevId,
            reason: err.message,
          });
        }
        throw err;
      }
      const rawCand = diskCards.find((c) => c.id === candidate.id);
      const rawPrev = previous ? diskCards.find((c) => c.id === previous.id) : null;

      if (previewData.previewHash) {
        const expectedPair = buildPromotedPair(candidate, previous);
        const actualHash = computePreviewHash({
          candidateId: candidate.id,
          previousId: previous ? previous.id : null,
          version: state.version,
          next: expectedPair.next,
          archivedPrevious: expectedPair.archivedPrevious,
        });
        if (previewData.previewHash !== actualHash) {
          appendAuditEvent(journalDir, { event: 'stale_preview', operationId: opId, reason: 'previewHash mismatch' });
          throw new Error('Устаревший preview: хэш предпросмотра не совпадает');
        }
      }

      const { next, archivedPrevious } = buildPromotedPair(candidate, previous, opId);
      const nextCards = state.cards.map((c) => {
        if (c.id === next.id) return next;
        if (archivedPrevious && c.id === archivedPrevious.id) return archivedPrevious;
        return c;
      });
      assertSingleActivePerLineage(nextCards);

      const layerRel = findExistingDir(root, [LAYER_FOLDER_MAP[normalizeLayer(next.layer)] || '20_Крона']);
      const archiveDirRel = findExistingDir(root, [ARCHIVE_DIR, '90_архив']);
      const srcPath = rawCand._relPath;
      const oldActivePath = rawPrev ? rawPrev._relPath : null;
      const archivePath = archivedPrevious
        ? pickUniqueRelPath(root, archiveDirRel, path.basename(oldActivePath))
        : null;
      const desiredActiveName = path.basename(srcPath);
      const activePath =
        oldActivePath && path.basename(oldActivePath) === desiredActiveName
          ? path.posix.join(layerRel, desiredActiveName)
          : pickUniqueRelPath(root, layerRel, desiredActiveName);

      const seq = state.ops.length + 1;
      const newVersion = computeStateVersion(nextCards, seq);
      const record = {
        v: 1,
        type: 'promote',
        seq,
        operationId: opId,
        candidateId: candidate.id,
        previousId: previous ? previous.id : null,
        expectedVersion: state.version,
        newVersion,
        previous: archivedPrevious,
        next,
        srcPath,
        oldActivePath,
        archivePath,
        activePath,
        archivedPreviousMarkdown: archivedPrevious ? cardToMarkdown(archivedPrevious, rawPrev) : null,
        nextMarkdown: cardToMarkdown(next, rawCand),
      };

      if (typeof beforeDiskStep === 'function') beforeDiskStep('before_journal', { op: clone(record) });
      const opHash = crypto.createHash('sha256').update(opId).digest('hex').slice(0, 12);
      const finalFileName = `${String(seq).padStart(6, '0')}-${opHash}.ndjson`;
      publishNdjsonRecord(journalDir, finalFileName, `${JSON.stringify(record)}\n`);
      applyCommittedDiskOp(root, record, beforeDiskStep);

      return clone({ operationId: opId, version: newVersion, previous: archivedPrevious, next });
    } finally {
      writing = false;
    }
  };

  const rollback = (rollbackOperationId, targetOperationId) => {
    if (writing) throw new Error('Конкурентная запись заблокирована (single-writer)');
    const rbId = normalizeStr(rollbackOperationId);
    const targetId = normalizeStr(targetOperationId);
    if (!rbId || /[\r\n]/.test(rbId) || !targetId) throw new Error('Требуются rollbackOperationId и targetOperationId');
    if (rbId === targetId) throw new Error('rollbackOperationId не должен совпадать с targetOperationId');

    writing = true;
    try {
      const state = deriveDiskState();
      const existingRb = state.opsById.get(rbId);
      if (existingRb) {
        if (existingRb.type !== 'rollback' || existingRb.targetOperationId !== targetId) {
          appendAuditEvent(journalDir, { event: 'idempotency_conflict', operationId: rbId, targetOperationId: targetId });
          throw new Error(`Конфликт operationId ${rbId}: параметры отката не совпадают`);
        }
        return clone({
          operationId: existingRb.operationId,
          targetOperationId: existingRb.targetOperationId,
          version: existingRb.newVersion,
          archived: existingRb.archived,
          restored: existingRb.restored ?? null,
        });
      }

      const targetOp = state.opsById.get(targetId);
      if (!targetOp || targetOp.type === 'rollback') throw new Error(`Целевая операция для отката не найдена: ${targetId}`);
      if (state.ops.some((o) => o.type === 'rollback' && o.targetOperationId === targetId)) {
        throw new Error(`Операция ${targetId} уже откачена`);
      }

      const currentCandidate = state.cardMap.get(targetOp.candidateId);
      const currentPrevious = targetOp.previousId ? state.cardMap.get(targetOp.previousId) : null;
      if (!currentCandidate || currentCandidate.status !== 'verified') {
        throw new Error(`Нельзя откатить ${targetId}: карточка ${targetOp.candidateId} не в статусе verified`);
      }
      if (currentPrevious && (currentPrevious.status !== 'archived' || currentPrevious.supersededBy !== currentCandidate.id)) {
        throw new Error(`Нельзя откатить ${targetId}: нарушена связь архивации ${targetOp.previousId}`);
      }

      const rawCand = diskCards.find((c) => c.id === currentCandidate.id);
      const rawPrev = currentPrevious ? diskCards.find((c) => c.id === currentPrevious.id) : null;
      const { archivedCard, restoredPrevious } = buildRollbackCards(currentCandidate, currentPrevious, rbId);
      const nextCards = state.cards.map((c) => {
        if (c.id === archivedCard.id) return archivedCard;
        if (restoredPrevious && c.id === restoredPrevious.id) return restoredPrevious;
        return c;
      });
      assertSingleActivePerLineage(nextCards);

      const archiveDirRel = findExistingDir(root, [ARCHIVE_DIR, '90_архив']);
      const rollbackArchivePath = pickUniqueRelPath(root, archiveDirRel, path.basename(rawCand._relPath));
      const restoredActivePath = restoredPrevious ? (targetOp.oldActivePath || rawPrev._relPath) : null;

      const seq = state.ops.length + 1;
      const newVersion = computeStateVersion(nextCards, seq);
      const record = {
        v: 1,
        type: 'rollback',
        seq,
        operationId: rbId,
        targetOperationId: targetId,
        candidateId: archivedCard.id,
        previousId: restoredPrevious ? restoredPrevious.id : null,
        expectedVersion: state.version,
        newVersion,
        archived: archivedCard,
        restored: restoredPrevious,
        activeRemovePath: rawCand._relPath,
        rollbackArchivePath,
        archivedMarkdown: cardToMarkdown(archivedCard, rawCand),
        oldArchivePath: rawPrev ? rawPrev._relPath : null,
        restoredActivePath,
        restoredMarkdown: restoredPrevious ? cardToMarkdown(restoredPrevious, rawPrev) : null,
      };

      if (typeof beforeDiskStep === 'function') beforeDiskStep('before_journal', { op: clone(record) });
      const opHash = crypto.createHash('sha256').update(rbId).digest('hex').slice(0, 12);
      const finalFileName = `${String(seq).padStart(6, '0')}-${opHash}.ndjson`;
      publishNdjsonRecord(journalDir, finalFileName, `${JSON.stringify(record)}\n`);
      applyCommittedDiskOp(root, record, beforeDiskStep);

      return clone({
        operationId: rbId,
        targetOperationId: targetId,
        version: newVersion,
        archived: archivedCard,
        restored: restoredPrevious,
      });
    } finally {
      writing = false;
    }
  };

  return {
    reconcile: () => reconcileVaultJournal(root, journalDir, beforeDiskStep),
    read,
    preview,
    findPreview,
    cancel,
    confirm,
    rollback,
    auditEvents,
  };
}

function formatPromotionPreview(pre) {
  const firstEv = Array.isArray(pre.next?.evidence) ? pre.next.evidence[0] : null;
  const evLine = firstEv ? (firstEv.quote || firstEv.link || firstEv.book || firstEv.source || 'проверено') : '—';
  const lines = [
    'Что изменится при подтверждении:',
    `- Новая активная (${pre.next?.layer || '20_крона'}): «${pre.next?.id}» — ${pre.next?.claim || ''}`,
    pre.previous
      ? `- Прежняя → 90_Архив: «${pre.previous.id}» (supersedes: ${pre.previous.id})`
      : '- Первичное утверждение без замены',
    `- Источник: ${String(evLine).slice(0, 160)}`,
  ];
  return lines.join('\n');
}

function registerMemoryPromotionIpc({
  ipcMain,
  isOverlaySender,
  notesDir,
  memoryJournalDir,
  torState,
  tor,
  shouldSkipChatPersistence,
  torBlockMsg,
  randomUUID = () => crypto.randomUUID(),
}) {
  const assertOverlay = (event) => {
    if (!isOverlaySender(event)) throw new Error('Доступно только из диалога Капри.');
  };
  const isBlocked = (query = '') =>
    shouldSkipChatPersistence({
      torState,
      messages: query ? [{ role: 'user', content: query }] : [],
      tor,
    });

  ipcMain.handle('chat:memory-preview', (event, text) => {
    assertOverlay(event);
    const query = typeof text === 'string' ? text.trim() : '';
    if (isBlocked(query)) {
      return { ok: false, blocked: true, text: torBlockMsg };
    }
    try {
      const store = createVaultPromotionStore({ vaultDir: notesDir(), journalDir: memoryJournalDir() });
      const pre = store.findPreview(query);
      if (!pre) {
        return {
          ok: false,
          text: query
            ? `В pending_review нет подходящего кандидата по запросу «${query}».`
            : 'В pending_review нет кандидатов для подтверждения.',
        };
      }
      return { ok: true, text: formatPromotionPreview(pre), preview: pre };
    } catch (err) {
      return { ok: false, text: err.message || 'Не удалось подготовить предпросмотр памяти.' };
    }
  });

  ipcMain.handle('chat:memory-confirm', (event, preview) => {
    assertOverlay(event);
    if (isBlocked()) {
      return { ok: false, text: torBlockMsg };
    }
    try {
      const store = createVaultPromotionStore({ vaultDir: notesDir(), journalDir: memoryJournalDir() });
      const res = store.confirm(preview, preview?.operationId);
      const summary = res.previous
        ? `Подтверждено: «${res.next.id}» теперь verified (supersedes ${res.previous.id}), прежняя переведена в 90_Архив.`
        : `Подтверждено: «${res.next.id}» теперь verified.`;
      return { ok: true, result: res, text: summary };
    } catch (err) {
      return { ok: false, text: err.message || 'Не удалось подтвердить замену памяти.' };
    }
  });

  ipcMain.handle('chat:memory-cancel', (event, preview) => {
    assertOverlay(event);
    if (isBlocked()) {
      return { ok: false, text: torBlockMsg };
    }
    try {
      const store = createVaultPromotionStore({ vaultDir: notesDir(), journalDir: memoryJournalDir() });
      const res = store.cancel(preview, preview?.operationId);
      return { ok: true, result: res, text: 'Замена отменена, карточка осталась в pending_review.' };
    } catch (err) {
      return { ok: false, text: err.message || 'Не удалось отменить замену памяти.' };
    }
  });

  ipcMain.handle('chat:memory-rollback', (event, req = {}) => {
    assertOverlay(event);
    if (isBlocked()) {
      return { ok: false, text: torBlockMsg };
    }
    try {
      const store = createVaultPromotionStore({ vaultDir: notesDir(), journalDir: memoryJournalDir() });
      const res = store.rollback(req.rollbackOperationId || randomUUID(), req.targetOperationId);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, text: err.message || 'Не удалось выполнить откат памяти.' };
    }
  });
}

module.exports = {
  createPromotionPilot,
  createVaultPromotionStore,
  reconcileVaultJournal,
  parseFrontmatter,
  serializeFrontmatter,
  formatPromotionPreview,
  registerMemoryPromotionIpc,
};
