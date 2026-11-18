'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_SAFE_DIR = 'D:\\Capri\\tor-safe';
const RECIPIENT_FILE = 'recipient.txt';
const IDENTITY_FILE = 'identity.age';
const MIN_PASSPHRASE_LEN = 8;

const DRIVE_D_PREFIX_RE = /^[dD]:[\\/]/;
const RESOLVED_D_RE = /^[dD]:\\/;
const SAFE_NAME_RE = /^[^\\/\0]+$/;

const creatingDirs = new Set();

let agePromise = null;
function loadAge() {
  agePromise ??= import('age-encryption');
  return agePromise;
}

function stripExtendedPrefix(p) {
  return String(p || '').replace(/^\\\\\?\\/, '');
}

function realPathNoPrefix(target) {
  return stripExtendedPrefix(fs.realpathSync.native(target));
}

/**
 * Enforces strict drive D:\ placement and rejects relative paths, C:/E:/other drives,
 * UNC/device paths, and any symlink or Windows directory junction in existing ancestors.
 */
function assertSafeDir(dir) {
  if (process.platform !== 'win32') throw new Error('Сейф Tor требует локального диска D: в Windows.');
  if (dir !== undefined && dir !== null && typeof dir !== 'string') {
    throw new Error('Путь к сейфу Tor должен быть строкой вида D:\\Capri\\tor-safe.');
  }
  const target = dir === undefined || dir === null || dir.trim() === ''
    ? DEFAULT_SAFE_DIR
    : dir.trim();

  if (target.includes('\0')) {
    throw new Error('Недопустимый символ в пути к сейфу Tor.');
  }
  if (target.startsWith('\\\\') || target.startsWith('//')) {
    throw new Error('UNC и device-пути запрещены для сейфа Tor; укажите локальный путь на D:.');
  }
  if (!DRIVE_D_PREFIX_RE.test(target)) {
    throw new Error('Сейф Tor допускает только абсолютный путь на диске D: (например, D:\\Capri\\tor-safe).');
  }

  const resolved = path.win32.resolve(target);
  if (!RESOLVED_D_RE.test(resolved) || resolved.length <= 3) {
    throw new Error('Укажите подкаталог на диске D:, а не корень диска.');
  }

  const parts = resolved.slice(3).split('\\').filter(Boolean);
  let cur = `${resolved[0].toUpperCase()}:\\`;
  try {
    const rootReal = realPathNoPrefix(cur);
    if (!RESOLVED_D_RE.test(rootReal)) {
      throw new Error('Диск D: указывает за пределы допустимого тома.');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  for (const part of parts) {
    cur = path.win32.join(cur, part);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      if (err.code === 'ENOENT') break;
      throw err;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error('В пути к сейфу Tor запрещены symlink, junction и не-каталоги.');
    }
    const real = realPathNoPrefix(cur);
    if (!RESOLVED_D_RE.test(real) || real.toLowerCase() !== cur.toLowerCase()) {
      throw new Error('Обнаружен junction/symlink в пути сейфа Tor; выход за D:\\ запрещён.');
    }
  }

  return `${resolved[0].toUpperCase()}${resolved.slice(1)}`;
}

function assertSafeFile(resolvedDir, fileName) {
  if (typeof fileName !== 'string' || !SAFE_NAME_RE.test(fileName) || fileName === '.' || fileName === '..') {
    throw new Error('Недопустимое имя файла в сейфе Tor.');
  }
  const filePath = path.win32.join(resolvedDir, fileName);
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return { filePath, exists: false, size: 0 };
    throw err;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Недопустимый объект в сейфе Tor (ожидался обычный файл): ${fileName}`);
  }
  const real = realPathNoPrefix(filePath);
  if (!RESOLVED_D_RE.test(real) || real.toLowerCase() !== filePath.toLowerCase()) {
    throw new Error(`Файл сейфа Tor выходит за пределы каталога D:\\: ${fileName}`);
  }
  return { filePath, exists: true, size: st.size };
}

function readRecipient(resolvedDir) {
  const { filePath, exists, size } = assertSafeFile(resolvedDir, RECIPIENT_FILE);
  if (!exists || size === 0) return '';
  const text = fs.readFileSync(filePath, 'utf8').trim();
  return /^age1[0-9a-z]+$/.test(text) ? text : '';
}

function hasKey(dir = DEFAULT_SAFE_DIR) {
  const resolved = assertSafeDir(dir);
  const recipient = readRecipient(resolved);
  const idInfo = assertSafeFile(resolved, IDENTITY_FILE);
  return Boolean(recipient) && idInfo.exists && idInfo.size > 0;
}

function listEncryptedFiles(resolvedDir) {
  if (!fs.existsSync(resolvedDir)) return [];
  const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
  const files = [];
  for (const ent of entries) {
    if (!ent.name.endsWith('.age') || ent.name === IDENTITY_FILE || ent.name.startsWith('.')) continue;
    if (ent.isSymbolicLink() || !ent.isFile()) continue;
    files.push(ent.name);
  }
  return files.sort();
}

function status({ dir = DEFAULT_SAFE_DIR } = {}) {
  let resolved;
  try {
    resolved = assertSafeDir(dir);
  } catch (err) {
    return {
      dir: String(dir || DEFAULT_SAFE_DIR),
      dirAllowed: false,
      error: err.message,
      hasKey: false,
      hasRecipient: false,
      hasIdentity: false,
      count: 0,
    };
  }
  try {
    const hasRecipient = Boolean(readRecipient(resolved));
    const idInfo = assertSafeFile(resolved, IDENTITY_FILE);
    const hasIdentity = idInfo.exists && idInfo.size > 0;
    const count = listEncryptedFiles(resolved).length;
    return {
      dir: resolved,
      dirAllowed: true,
      hasKey: hasRecipient && hasIdentity,
      hasRecipient,
      hasIdentity,
      count,
    };
  } catch (err) {
    return {
      dir: resolved,
      dirAllowed: false,
      error: err.message,
      hasKey: false,
      hasRecipient: false,
      hasIdentity: false,
      count: 0,
    };
  }
}

async function createKey({ dir = DEFAULT_SAFE_DIR, passphrase, scryptWorkFactor } = {}) {
  const resolved = assertSafeDir(dir);
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new Error(`Парольная фраза должна содержать не менее ${MIN_PASSPHRASE_LEN} символов.`);
  }

  const lockKey = resolved.toLowerCase();
  if (creatingDirs.has(lockKey)) {
    throw new Error('Создание ключа сейфа Tor уже выполняется.');
  }
  creatingDirs.add(lockKey);

  try {
    const idPre = assertSafeFile(resolved, IDENTITY_FILE);
    const recPre = assertSafeFile(resolved, RECIPIENT_FILE);
    if (idPre.exists || recPre.exists) {
      throw new Error('Ключ сейфа Tor уже существует.');
    }

    const age = await loadAge();
    const identity = await age.generateX25519Identity();
    const recipient = await age.identityToRecipient(identity);

    const enc = new age.Encrypter();
    if (Number.isInteger(scryptWorkFactor) && scryptWorkFactor > 0) {
      enc.setScryptWorkFactor(scryptWorkFactor);
    }
    enc.setPassphrase(passphrase);
    const encryptedIdentity = await enc.encrypt(identity);

    assertSafeDir(resolved);
    fs.mkdirSync(resolved, { recursive: true });
    assertSafeDir(resolved);
    const idInfo = assertSafeFile(resolved, IDENTITY_FILE);
    const recInfo = assertSafeFile(resolved, RECIPIENT_FILE);
    if (idInfo.exists || recInfo.exists) {
      throw new Error('Ключ сейфа Tor уже существует.');
    }

    let createdIdentity = false;
    try {
      writeNewFile(idInfo.filePath, encryptedIdentity);
      createdIdentity = true;
      writeNewFile(recInfo.filePath, `${recipient}\n`);
    } catch (err) {
      if (createdIdentity) {
        try { fs.unlinkSync(idInfo.filePath); } catch {}
      }
      throw err;
    }

    return { dir: resolved, recipient };
  } finally {
    creatingDirs.delete(lockKey);
  }
}

function writeNewFile(filePath, data) {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    try { fs.unlinkSync(filePath); } catch {}
    throw err;
  }
}

function destroyKey({ dir = DEFAULT_SAFE_DIR } = {}) {
  const resolved = assertSafeDir(dir);
  const idInfo = assertSafeFile(resolved, IDENTITY_FILE);
  const recInfo = assertSafeFile(resolved, RECIPIENT_FILE);
  const removed = [];
  if (idInfo.exists) {
    fs.unlinkSync(idInfo.filePath);
    removed.push(IDENTITY_FILE);
  }
  if (recInfo.exists) {
    fs.unlinkSync(recInfo.filePath);
    removed.push(RECIPIENT_FILE);
  }
  return { dir: resolved, destroyed: removed.length > 0, removed };
}

async function confirmAndDestroyKey({ dir = DEFAULT_SAFE_DIR, showMessageBox, parentWindow = null, onDestroyed } = {}) {
  const st = status({ dir });
  if (!st.dirAllowed) throw new Error(st.error || 'Недопустимый путь сейфа Tor');
  if (!st.hasIdentity && !st.hasRecipient) return { destroyed: false, reason: 'no_key' };
  if (typeof showMessageBox !== 'function') throw new Error('showMessageBox is required');

  const ask = (opts) => (parentWindow && !parentWindow.isDestroyed?.()
    ? showMessageBox(parentWindow, opts)
    : showMessageBox(opts));

  const step1 = await ask({
    type: 'warning',
    title: 'Сейф Tor — удаление ключей',
    message: 'Удалить identity.age и recipient.txt из каталога сейфа?',
    detail: `Каталог: ${st.dir}\nСохранено записей: ${st.count}\n\nПосле удаления файлов ключей Капри больше не сможет расшифровать записи .age (если у вас нет отдельной резервной копии ключа).`,
    buttons: ['Отмена', 'Продолжить…'],
    defaultId: 0,
    cancelId: 0,
  });
  if (step1?.response !== 1) return { destroyed: false, cancelled: true };

  const step2 = await ask({
    type: 'warning',
    title: 'Сейф Tor — финальное подтверждение',
    message: 'Точно удалить ключи сейфа Tor?',
    detail: 'Нажмите «Удалить ключи», чтобы удалить identity.age и recipient.txt из каталога сейфа.',
    buttons: ['Отмена', 'Удалить ключи'],
    defaultId: 0,
    cancelId: 0,
  });
  if (step2?.response !== 1) return { destroyed: false, cancelled: true };

  const res = destroyKey({ dir });
  await onDestroyed?.(res);
  return res;
}

async function writeEntry({ dir = DEFAULT_SAFE_DIR, entry } = {}) {
  const resolved = assertSafeDir(dir);
  if (!entry || entry.isolator !== true) {
    throw new Error('В сейф Tor можно записывать только ответы, полученные через Tor-изолятор.');
  }
  const recipient = readRecipient(resolved);
  const idInfo = assertSafeFile(resolved, IDENTITY_FILE);
  if (!recipient || !idInfo.exists || idInfo.size === 0) {
    throw new Error('Ключ сейфа Tor не создан (меню трея → Сейф Tor → Создать ключ…).');
  }

  const id = randomUUID();
  const createdAt = typeof entry.fetched_at === 'string' && entry.fetched_at
    ? entry.fetched_at
    : Number.isFinite(entry.fetched_at)
      ? new Date(entry.fetched_at).toISOString()
      : new Date().toISOString();

  const record = {
    v: 1,
    id,
    created_at: createdAt,
    node: entry.node === 'dark' ? 'dark' : 'tor',
    isolator: true,
    query: String(entry.query || '').slice(0, 500),
    answer: String(entry.answer || ''),
    sources: Array.isArray(entry.sources) ? entry.sources : [],
    results: Array.isArray(entry.results) ? entry.results : [],
    pages: Array.isArray(entry.pages) ? entry.pages : [],
  };

  const age = await loadAge();
  const plainBuf = Buffer.from(JSON.stringify(record), 'utf8');
  let ciphertext;
  try {
    const enc = new age.Encrypter();
    enc.addRecipient(recipient);
    ciphertext = await enc.encrypt(plainBuf);
  } finally {
    plainBuf.fill(0);
  }

  assertSafeDir(resolved);
  if (readRecipient(resolved) !== recipient || !assertSafeFile(resolved, IDENTITY_FILE).size) {
    throw new Error('Ключ сейфа Tor изменился во время сохранения.');
  }
  const outName = `${id}.age`;
  const { filePath } = assertSafeFile(resolved, outName);
  writeNewFile(filePath, ciphertext);
  return { id, file: outName, created_at: createdAt };
}

async function recordSearchIfEnabled({ cfg, query, result, writeEntryImpl = writeEntry } = {}) {
  if (cfg?.torSafe !== 'on') {
    return { saved: false, reason: 'off' };
  }
  if (cfg?.torIsolator !== 'on' || !result || result.isolator !== true) {
    return {
      saved: false,
      reason: 'not_isolated',
      notice: 'В сейф Tor не записано: сохраняются только ответы через Tor-изолятор.',
    };
  }
  const st = status({ dir: cfg?.torSafeDir });
  if (!st.dirAllowed) {
    return {
      saved: false,
      reason: 'unsafe_dir',
      notice: 'В сейф Tor не записано: путь сейфа должен быть на диске D:.',
    };
  }
  if (!st.hasKey) {
    return {
      saved: false,
      reason: 'no_key',
      notice: 'В сейф Tor не записано: не создан ключ сейфа (меню трея → Сейф Tor → Создать ключ…).',
    };
  }
  try {
    const saved = await writeEntryImpl({ dir: st.dir, entry: { ...result, query } });
    return { saved: true, ...saved };
  } catch {
    return {
      saved: false,
      reason: 'write_error',
      notice: 'В сейф Tor не записано: ошибка записи на диск.',
    };
  }
}

async function unlockEntries({ dir = DEFAULT_SAFE_DIR, passphrase } = {}) {
  const resolved = assertSafeDir(dir);
  if (typeof passphrase !== 'string' || !passphrase) {
    throw new Error('Введите парольную фразу.');
  }
  const idInfo = assertSafeFile(resolved, IDENTITY_FILE);
  if (!idInfo.exists || idInfo.size === 0) {
    throw new Error('Закрытый ключ сейфа Tor (identity.age) не найден.');
  }

  const age = await loadAge();
  const encryptedIdentity = fs.readFileSync(idInfo.filePath);
  const keyDecrypter = new age.Decrypter();
  keyDecrypter.addPassphrase(passphrase);

  let identityBytes;
  try {
    identityBytes = await keyDecrypter.decrypt(encryptedIdentity);
  } catch {
    throw new Error('Неверная парольная фраза или повреждён ключ сейфа.');
  }

  let identity = '';
  try {
    identity = Buffer.from(identityBytes).toString('utf8').trim();
  } finally {
    if (identityBytes && typeof identityBytes.fill === 'function') identityBytes.fill(0);
  }

  if (!identity.startsWith('AGE-SECRET-KEY-')) {
    throw new Error('Файл identity.age не содержит корректный ключ age.');
  }

  const files = listEncryptedFiles(resolved);
  const entries = [];
  try {
    for (const file of files) {
      const { filePath, exists } = assertSafeFile(resolved, file);
      if (!exists) continue;
      const cipher = fs.readFileSync(filePath);
      const dec = new age.Decrypter();
      dec.addIdentity(identity);
      let plainBytes;
      try {
        plainBytes = await dec.decrypt(cipher);
        const parsed = JSON.parse(Buffer.from(plainBytes).toString('utf8'));
        entries.push({
          id: parsed.id || file.replace(/\.age$/, ''),
          file,
          created_at: parsed.created_at || '',
          node: parsed.node === 'dark' ? 'dark' : 'tor',
          query: String(parsed.query || ''),
          answer: String(parsed.answer || ''),
          sources: Array.isArray(parsed.sources) ? parsed.sources : [],
          results: Array.isArray(parsed.results) ? parsed.results : [],
          pages: Array.isArray(parsed.pages) ? parsed.pages : [],
          unreadable: false,
        });
      } catch {
        entries.push({
          id: file.replace(/\.age$/, ''),
          file,
          created_at: '',
          node: 'tor',
          query: '',
          answer: '',
          sources: [],
          results: [],
          pages: [],
          unreadable: true,
        });
      } finally {
        if (plainBytes && typeof plainBytes.fill === 'function') plainBytes.fill(0);
      }
    }
  } finally {
    identity = '';
  }

  entries.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return entries;
}

module.exports = {
  DEFAULT_SAFE_DIR,
  RECIPIENT_FILE,
  IDENTITY_FILE,
  MIN_PASSPHRASE_LEN,
  assertSafeDir,
  assertSafeFile,
  hasKey,
  status,
  createKey,
  destroyKey,
  confirmAndDestroyKey,
  writeEntry,
  recordSearchIfEnabled,
  unlockEntries,
};
