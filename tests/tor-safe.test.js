'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const config = require('../src/main/config');
const torSafe = require('../src/main/tor-safe');
const { createTorIsolator, GW_IP, NETNS_CONTAINER, ISOLATOR_IMAGE } = require('../src/main/tor-isolator');

function makeTempSafeDir(t) {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-tor-safe-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('config DEFAULTS keeps torSafe off and points torSafeDir to D:\\Capri\\tor-safe', () => {
  assert.equal(config.DEFAULTS.torSafe, 'off');
  assert.equal(config.DEFAULTS.torSafeDir, 'D:\\Capri\\tor-safe');
  assert.equal(torSafe.DEFAULT_SAFE_DIR, 'D:\\Capri\\tor-safe');
});

test('strict D:\\ path rule refuses relative paths, C:/E:/Z:, root, UNC, and device paths', async () => {
  const forbiddenDirs = [
    'tor-safe',
    '.\\tor-safe',
    '..\\tor-safe',
    'D:relative-dir',
    'C:\\Capri\\tor-safe',
    'c:/Users/Public/tor-safe-test',
    'E:\\Capri\\tor-safe',
    'Z:\\tor-safe',
    'D:\\',
    'd:/',
    '\\\\server\\share\\tor-safe',
    '//server/share/tor-safe',
    '\\\\?\\D:\\Capri\\tor-safe',
    '\\\\.\\D:\\Capri\\tor-safe',
    '\\\\?\\C:\\tor-safe',
    'D:\\Capri\\tor-safe\0evil',
  ];

  for (const dir of forbiddenDirs) {
    assert.throws(() => torSafe.assertSafeDir(dir), /Tor|диск|UNC|корень|Недопустим/);
    await assert.rejects(() => torSafe.createKey({ dir, passphrase: 'strong-passphrase-99', scryptWorkFactor: 10 }));
    await assert.rejects(() => torSafe.writeEntry({ dir, entry: { isolator: true, answer: 'x' } }));
    await assert.rejects(() => torSafe.unlockEntries({ dir, passphrase: 'strong-passphrase-99' }));
    assert.throws(() => torSafe.destroyKey({ dir }));

    const st = torSafe.status({ dir });
    assert.equal(st.dirAllowed, false);
    assert.equal(st.hasKey, false);

    const rec = await torSafe.recordSearchIfEnabled({
      cfg: { torSafe: 'on', torIsolator: 'on', torSafeDir: dir },
      query: 'test',
      result: { isolator: true, answer: 'ok' },
    });
    assert.equal(rec.saved, false);
    assert.equal(rec.reason, 'unsafe_dir');
    assert.equal(rec.notice, 'В сейф Tor не записано: путь сейфа должен быть на диске D:.');
  }
});

test('junction or symlink in safe path, ancestors, or key files is rejected without touching target', async (t) => {
  const base = makeTempSafeDir(t);
  const realTarget = path.join(base, 'real-target');
  const junctionDir = path.join(base, 'junc-dir');
  const nestedUnderJunction = path.join(junctionDir, 'nested');
  fs.mkdirSync(realTarget, { recursive: true });
  fs.symlinkSync(realTarget, junctionDir, 'junction');

  assert.throws(() => torSafe.assertSafeDir(junctionDir), /junction|symlink/i);
  assert.throws(() => torSafe.assertSafeDir(nestedUnderJunction), /junction|symlink/i);
  await assert.rejects(() => torSafe.createKey({ dir: junctionDir, passphrase: 'strong-passphrase-99', scryptWorkFactor: 10 }), /junction|symlink/i);
  await assert.rejects(() => torSafe.createKey({ dir: nestedUnderJunction, passphrase: 'strong-passphrase-99', scryptWorkFactor: 10 }), /junction|symlink/i);
  await assert.rejects(() => torSafe.writeEntry({ dir: junctionDir, entry: { isolator: true, answer: 'x' } }), /junction|symlink/i);
  assert.equal(torSafe.status({ dir: junctionDir }).dirAllowed, false);
  assert.deepEqual(fs.readdirSync(realTarget), []);

  // Also reject non-regular file (directory) masquerading as recipient.txt inside a normal dir
  const safeWithDirTrick = path.join(base, 'safe-trick');
  fs.mkdirSync(path.join(safeWithDirTrick, 'recipient.txt'), { recursive: true });
  await assert.rejects(() => torSafe.createKey({ dir: safeWithDirTrick, passphrase: 'strong-passphrase-99', scryptWorkFactor: 10 }), /обычный файл|Недопустимый объект/);
});

test('createKey refuses concurrent race and existing key overwrite without modifying existing key files', async (t) => {
  const dir = makeTempSafeDir(t);
  const pass = 'race-test-passphrase-2026';

  const [r1, r2] = await Promise.allSettled([
    torSafe.createKey({ dir, passphrase: pass, scryptWorkFactor: 10 }),
    torSafe.createKey({ dir, passphrase: pass, scryptWorkFactor: 10 }),
  ]);
  const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
  const rejected = [r1, r2].filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /уже выполняется|уже существует/);

  const beforeId = fs.readFileSync(path.join(dir, 'identity.age'));
  const beforeRec = fs.readFileSync(path.join(dir, 'recipient.txt'));

  await assert.rejects(() => torSafe.createKey({ dir, passphrase: 'other-passphrase-2026', scryptWorkFactor: 10 }), /уже существует/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'identity.age')), beforeId);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'recipient.txt')), beforeRec);

  // If recipient.txt appears mid-flight on an empty directory, createKey aborts cleanly with no orphan identity.age
  const partialDir = makeTempSafeDir(t);
  const pendingCreate = torSafe.createKey({ dir: partialDir, passphrase: pass, scryptWorkFactor: 12 });
  fs.mkdirSync(partialDir, { recursive: true });
  fs.writeFileSync(path.join(partialDir, 'recipient.txt'), 'age1planted\n', 'utf8');
  await assert.rejects(() => pendingCreate, /уже существует/);
  assert.equal(fs.existsSync(path.join(partialDir, 'identity.age')), false);
});

test('createKey, encrypted write by public key only, ciphertext inspection, unlock, wrong passphrase, and key destruction', async (t) => {
  const dir = makeTempSafeDir(t);
  const pass = 'my-secret-passphrase-2026';

  assert.equal(torSafe.hasKey(dir), false);
  const created = await torSafe.createKey({ dir, passphrase: pass, scryptWorkFactor: 10 });
  assert.match(created.recipient, /^age1[0-9a-z]+$/);
  assert.equal(created.recipient.startsWith('age1pq'), false);
  assert.equal(torSafe.hasKey(dir), true);

  // Secret key must never appear in plaintext inside identity.age or recipient.txt
  const identityRaw = fs.readFileSync(path.join(dir, 'identity.age'));
  assert.equal(identityRaw.includes(Buffer.from('AGE-SECRET-KEY-')), false);
  assert.equal(identityRaw.includes(Buffer.from(pass)), false);

  const secretQuery = 'ULTRA_SECRET_TOR_QUERY_9182';
  const secretAnswer = 'CONFIDENTIAL_TOR_ANSWER_7341';
  const secretUrl = 'hxxp://secret777777777777777777777777777777777777777777777777[.]onion/report';
  const secretPageText = 'HIDDEN_ONION_PAYLOAD_BODY_5543';

  const rec = await torSafe.recordSearchIfEnabled({
    cfg: { torSafe: 'on', torIsolator: 'on', torSafeDir: dir },
    query: secretQuery,
    result: {
      isolator: true,
      node: 'dark',
      fetched_at: '2026-11-18T10:30:00.000Z',
      answer: secretAnswer,
      sources: [{ n: 1, title: 'Hidden Report', url: secretUrl }],
      results: [{ title: 'Hidden Report', url_defanged: secretUrl, snippet: 'secret snippet' }],
      pages: [{ url_defanged: secretUrl, title: 'Hidden Report', text: secretPageText, truncated: false, flags: ['suspicious'] }],
    },
  });
  assert.equal(rec.saved, true);
  assert.ok(rec.id);

  // Directory contains only recipient.txt, identity.age, and <uuid>.age (no manifest, no plaintext temp files)
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, [`${rec.id}.age`, 'identity.age', 'recipient.txt'].sort());

  // Inspect ciphertext bytes directly: zero plaintext substrings may exist on disk
  const entryRaw = fs.readFileSync(path.join(dir, `${rec.id}.age`));
  for (const needle of [secretQuery, secretAnswer, secretUrl, secretPageText, 'Hidden Report', 'secret snippet', '2026-11-18T10:30:00.000Z']) {
    assert.equal(entryRaw.includes(Buffer.from(needle, 'utf8')), false, `plaintext leaked into .age: ${needle}`);
  }

  // Wrong passphrase fails
  await assert.rejects(() => torSafe.unlockEntries({ dir, passphrase: 'wrong-passphrase-000' }), /Неверная парольная фраза/);

  // Correct passphrase decrypts in memory
  const unlocked = await torSafe.unlockEntries({ dir, passphrase: pass });
  assert.equal(unlocked.length, 1);
  assert.equal(unlocked[0].id, rec.id);
  assert.equal(unlocked[0].node, 'dark');
  assert.equal(unlocked[0].query, secretQuery);
  assert.equal(unlocked[0].answer, secretAnswer);
  assert.equal(unlocked[0].sources[0].url, secretUrl);
  assert.equal(unlocked[0].pages[0].text, secretPageText);
  assert.deepEqual(unlocked[0].pages[0].flags, ['suspicious']);

  const stBefore = torSafe.status({ dir });
  assert.equal(stBefore.hasKey, true);
  assert.equal(stBefore.count, 1);

  // Destroy key -> identity.age and recipient.txt removed, entries become unreadable
  const destroyed = torSafe.destroyKey({ dir });
  assert.equal(destroyed.destroyed, true);
  assert.deepEqual(destroyed.removed.sort(), ['identity.age', 'recipient.txt']);
  assert.equal(torSafe.hasKey(dir), false);
  assert.equal(torSafe.status({ dir }).count, 1);

  await assert.rejects(() => torSafe.unlockEntries({ dir, passphrase: pass }), /не найден/);

  // Even creating a new key in the same dir cannot decrypt the old .age file
  const pass2 = 'brand-new-passphrase-2026';
  await torSafe.createKey({ dir, passphrase: pass2, scryptWorkFactor: 10 });
  const unlockedWithNewKey = await torSafe.unlockEntries({ dir, passphrase: pass2 });
  assert.equal(unlockedWithNewKey.length, 1);
  assert.equal(unlockedWithNewKey[0].unreadable, true);
  assert.equal(unlockedWithNewKey[0].answer, '');
});

test('flag off writes nothing, non-isolator results are rejected, missing key fails honestly, and disk write error stays concise without leaking details', async (t) => {
  const dir = makeTempSafeDir(t);
  await torSafe.createKey({ dir, passphrase: 'test-passphrase-888', scryptWorkFactor: 10 });

  // 1. torSafe === 'off' -> writes nothing
  const offRes = await torSafe.recordSearchIfEnabled({
    cfg: { torSafe: 'off', torIsolator: 'on', torSafeDir: dir },
    query: 'q',
    result: { isolator: true, answer: 'secret answer' },
  });
  assert.equal(offRes.saved, false);
  assert.equal(offRes.reason, 'off');
  assert.equal(torSafe.status({ dir }).count, 0);

  // 2. Without isolator: true -> refused, nothing written
  await assert.rejects(() => torSafe.writeEntry({ dir, entry: { isolator: false, answer: 'legacy host answer' } }), /только ответы.*Tor-изолятор/i);
  const nonIsoRes = await torSafe.recordSearchIfEnabled({
    cfg: { torSafe: 'on', torIsolator: 'off', torSafeDir: dir },
    query: 'q',
    result: { isolator: false, answer: 'legacy answer' },
  });
  assert.equal(nonIsoRes.saved, false);
  assert.equal(nonIsoRes.reason, 'not_isolated');
  assert.match(nonIsoRes.notice, /Tor-изолятор/);
  assert.equal(torSafe.status({ dir }).count, 0);

  // 3. Simulated ENOSPC write error -> concise notice without internal error message
  const diskErrRes = await torSafe.recordSearchIfEnabled({
    cfg: { torSafe: 'on', torIsolator: 'on', torSafeDir: dir },
    query: 'q',
    result: { isolator: true, answer: 'isolated answer' },
    writeEntryImpl: async () => {
      const err = new Error('ENOSPC: no space left on device, secret-path-leak');
      err.code = 'ENOSPC';
      throw err;
    },
  });
  assert.equal(diskErrRes.saved, false);
  assert.equal(diskErrRes.reason, 'write_error');
  assert.equal(diskErrRes.notice, 'В сейф Tor не записано: ошибка записи на диск.');
  assert.equal(diskErrRes.notice.includes('ENOSPC'), false);
  assert.equal(diskErrRes.notice.includes('secret-path-leak'), false);

  // 4. Without key -> refuses cleanly with honest notice and writes nothing
  torSafe.destroyKey({ dir });
  const noKeyRes = await torSafe.recordSearchIfEnabled({
    cfg: { torSafe: 'on', torIsolator: 'on', torSafeDir: dir },
    query: 'q',
    result: { isolator: true, answer: 'isolated answer' },
  });
  assert.equal(noKeyRes.saved, false);
  assert.equal(noKeyRes.reason, 'no_key');
  assert.match(noKeyRes.notice, /не создан ключ/);
  assert.equal(torSafe.status({ dir }).count, 0);
});

test('a partial disk write leaves no incomplete key and key creation can be retried', async (t) => {
  const dir = makeTempSafeDir(t);
  const options = { dir, passphrase: 'test-partial-write-pass', scryptWorkFactor: 10 };
  const writeFile = fs.writeFileSync;
  const fault = t.mock.method(fs, 'writeFileSync', (fd, data, ...args) => {
    if (typeof fd !== 'number' || typeof data !== 'string') return writeFile(fd, data, ...args);
    writeFile(fd, data.slice(0, 8));
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });

  await assert.rejects(() => torSafe.createKey(options), { code: 'ENOSPC' });
  assert.deepEqual(fs.readdirSync(dir), []);
  fault.mock.restore();
  await torSafe.createKey(options);
  assert.equal(torSafe.hasKey(dir), true);
});

test('confirmAndDestroyKey calls showMessageBox without parent from tray, respects both cancel buttons, and triggers onDestroyed', async (t) => {
  const dir = makeTempSafeDir(t);
  await torSafe.createKey({ dir, passphrase: 'destroy-dialog-pass-2026', scryptWorkFactor: 10 });

  // Cancel on step 1 (called from tray without parentWindow -> 1 arg to showMessageBox)
  const calls1 = [];
  let destroyedCalls = 0;
  const c1 = await torSafe.confirmAndDestroyKey({
    dir,
    parentWindow: null,
    showMessageBox: async (...args) => {
      calls1.push(args);
      return { response: 0 };
    },
    onDestroyed: () => { destroyedCalls++; },
  });
  assert.equal(c1.destroyed, false);
  assert.equal(c1.cancelled, true);
  assert.equal(calls1.length, 1);
  assert.equal(calls1[0].length, 1);
  assert.equal(torSafe.hasKey(dir), true);
  assert.equal(destroyedCalls, 0);

  // Confirm step 1, cancel on step 2
  const calls2 = [];
  const c2 = await torSafe.confirmAndDestroyKey({
    dir,
    parentWindow: null,
    showMessageBox: async (...args) => {
      calls2.push(args);
      return { response: calls2.length === 1 ? 1 : 0 };
    },
    onDestroyed: () => { destroyedCalls++; },
  });
  assert.equal(c2.destroyed, false);
  assert.equal(c2.cancelled, true);
  assert.equal(calls2.length, 2);
  assert.equal(calls2[0].length, 1);
  assert.equal(calls2[1].length, 1);
  assert.equal(torSafe.hasKey(dir), true);
  assert.equal(destroyedCalls, 0);

  // Confirm both steps -> removes key and calls onDestroyed (rebuildTray)
  const calls3 = [];
  const c3 = await torSafe.confirmAndDestroyKey({
    dir,
    parentWindow: null,
    showMessageBox: async (...args) => {
      calls3.push(args);
      return { response: 1 };
    },
    onDestroyed: () => { destroyedCalls++; },
  });
  assert.equal(c3.destroyed, true);
  assert.equal(calls3.length, 2);
  assert.equal(torSafe.hasKey(dir), false);
  assert.equal(destroyedCalls, 1);
});

test('default scrypt work factor createKey + answerIsolated integration saves CDR-cleaned payload to safe', async (t) => {
  const dir = makeTempSafeDir(t);
  const pass = 'default-scrypt-passphrase-2026';

  const created = await torSafe.createKey({ dir, passphrase: pass });
  assert.match(created.recipient, /^age1[0-9a-z]+$/);

  const mockSpawn = (_cmd, args) => {
    const child = new EventEmitter();
    child.stdin = { write() { return true; }, end() {} };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      const sub = args[0];
      let out = '';
      if (sub === 'version') out = '29.9.3';
      else if (sub === 'image' || sub === 'network') out = JSON.stringify([{ Internal: true }]);
      else if (sub === 'container') {
        out = args[2] === NETNS_CONTAINER
          ? JSON.stringify([{ State: { Running: true } }])
          : JSON.stringify([{ State: { Running: true }, NetworkSettings: { Networks: { 'capri-tor-int': { IPAddress: GW_IP } } } }]);
      } else if (sub === 'logs') out = 'Bootstrapped 100% (done)\n';
      else if (sub === 'exec') out = `${GW_IP} dev eth0 scope link\n`;
      else if (sub === 'run' && args.includes(ISOLATOR_IMAGE)) {
        out = JSON.stringify({
          v: 1,
          ok: true,
          isTor: true,
          node: 'tor',
          fetched_at: 1700000000000,
          results: [{ title: 'Source One', url: 'https://example.org/one', snippet: 'clean snippet' }],
          pages: [{ url: 'https://example.org/one', title: 'Source One', text: 'clean page body '.repeat(25), truncated: false }],
        });
      }
      if (out) child.stdout.write(out);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };

  const isolator = createTorIsolator({
    spawn: mockSpawn,
    seccompPath: path.resolve(__dirname, '..', 'isolator', 'seccomp-camoufox.json'),
    existsSync: () => true,
    pause: async () => {},
  });
  const answerRes = await isolator.answerIsolated('изолятор тест', {
    node: 'tor',
    chat: async () => 'Ответ из изолятора [1]',
  });

  const rec = await torSafe.recordSearchIfEnabled({
    cfg: { torSafe: 'on', torIsolator: 'on', torSafeDir: dir },
    query: 'изолятор тест',
    result: answerRes,
  });
  assert.equal(rec.saved, true);

  const unlocked = await torSafe.unlockEntries({ dir, passphrase: pass });
  assert.equal(unlocked.length, 1);
  assert.equal(unlocked[0].answer, 'Ответ из изолятора [1]');
  assert.equal(unlocked[0].sources[0].url, 'hxxps://example[.]org/one');
  assert.ok(unlocked[0].pages[0].text.startsWith('clean page body'));
});
