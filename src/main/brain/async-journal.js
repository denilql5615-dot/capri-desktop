'use strict';

// Standalone async shadow journal. Not connected to Capri IPC or any live path.
// Architecture: the core (index.js) stages a record without changing state
// (prepareIngest/prepareTick); a single serialized queue awaits the append and only
// then commits the staged state, so state never runs ahead of the durable write.
// One writer per file is assumed: no locks, no fsync (power-loss durability not promised).
const fsp = require('node:fs/promises');
const path = require('node:path');
const { CONFIG, replay, sanitize, canonical } = require('./index');

const fail = (reason, cause) => new Error(`brain: ${reason}`, cause ? { cause } : undefined);
const DEFAULT_QUEUE = 64;

async function readBounded(file) {
  let fh;
  try { fh = await fsp.open(file, 'r'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  try {
    const { size } = await fh.stat();
    if (size > CONFIG.max_journal_bytes) throw fail('journal size');
    const bytes = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const { bytesRead } = await fh.read(bytes, off, size - off, off);
      if (bytesRead === 0) throw fail('journal changed during read');
      off += bytesRead;
    }
    if ((await fh.stat()).size !== size) throw fail('journal changed during read');
    return bytes;
  } finally { await fh.close(); }
}

async function openAsyncJournal(file, { max_queue = DEFAULT_QUEUE } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw fail('absolute journal path required');
  if (!Number.isSafeInteger(max_queue) || max_queue < 1 || max_queue > 1000) throw fail('max_queue 1..1000');

  let bytes = await readBounded(file);
  if (bytes === null) {
    // wx refuses an existing file (including a concurrent creator): never truncate.
    const header = `${canonical({ kind: 'header', schema_version: CONFIG.schema_version, config: CONFIG })}\n`;
    await fsp.writeFile(file, header, { flag: 'wx', encoding: 'utf8' });
    bytes = Buffer.from(header, 'utf8');
  }
  const core = replay(bytes.toString('utf8')); // validates everything before any append
  let size = bytes.length;
  const fh = await fsp.open(file, 'a');

  const queue = [];
  let running = null; // promise of the latest pump (for close)
  let active = false; // a pump is draining the queue
  let poison = null;
  let closed = false;
  let closing = null;

  const pending = () => queue.length + (active ? 1 : 0);

  function poisonAll(err) {
    poison = fail('async journal poisoned', err);
    const items = queue.splice(0);
    return items;
  }

  // active is cleared synchronously when the loop exits, so no enqueue can be stranded.
  async function pump() {
    while (queue.length) {
      const item = queue.shift();
      try {
        const staged = item.kind === 'event' ? core.prepareIngest(item.env) : core.prepareTick(item.env);
        if (staged.result) { item.resolve(staged.result); continue; } // duplicate: nothing appended
        const added = Buffer.byteLength(staged.line);
        if (size + added > CONFIG.max_journal_bytes) throw fail('journal size');
        try {
          if ((await fh.stat()).size !== size) throw fail('journal changed since open');
          await fh.appendFile(staged.line, 'utf8');
        } catch (err) {
          const rest = poisonAll(err);
          item.reject(poison);
          for (const r of rest) r.reject(poison);
          active = false; return;
        }
        size += added;
        let result;
        try { result = staged.commit(); } catch (err) {
          // Record is durable but state could not follow: refuse further work.
          const rest = poisonAll(err);
          item.reject(poison);
          for (const r of rest) r.reject(poison);
          active = false; return;
        }
        item.resolve(result);
      } catch (err) {
        item.reject(err); // validation/sequence/limit error: only this operation fails
      }
    }
    active = false;
  }

  function enqueue(kind, envelope) {
    let env;
    try {
      env = sanitize(kind, envelope); // privacy filter + strict schema BEFORE queue/disk
      if (env === null) return Promise.resolve({ status: 'discarded' });
      if (poison) throw poison;
      if (closed) throw fail('journal closed');
      if (pending() >= max_queue) throw fail('queue full');
    } catch (err) { return Promise.reject(err); }
    return new Promise((resolve, reject) => {
      queue.push({ kind, env, resolve, reject });
      if (!active) { active = true; running = pump(); }
    });
  }

  return Object.freeze({
    ingest: (envelope) => enqueue('event', envelope),
    tick: (envelope) => enqueue('tick', envelope),
    snapshot: () => core.snapshot(), // committed (durable) state only
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        while (active) await running;
        await fh.close();
      })();
      return closing;
    },
  });
}

module.exports = { openAsyncJournal, DEFAULT_QUEUE };
