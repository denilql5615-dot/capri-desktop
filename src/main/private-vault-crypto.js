'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PRIVATE_VAULT_DIR = 'D:\\Capri\\private-vault';
const KEY_FILE = '.vault-key.dpapi';
const MAGIC = Buffer.from('CPV1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MIN_CIPHER_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES;

function vaultUnavailable() {
  return new Error('Приватный Vault недоступен.');
}

function assertValidKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw vaultUnavailable();
  }
}

function encryptBuffer(key, utf8Text) {
  assertValidKey(key);
  if (typeof utf8Text !== 'string') {
    throw vaultUnavailable();
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(utf8Text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

function decryptBuffer(key, buf) {
  assertValidKey(key);
  if (!Buffer.isBuffer(buf) || buf.length < MIN_CIPHER_BYTES) {
    throw vaultUnavailable();
  }
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw vaultUnavailable();
  }
  const ivStart = MAGIC.length;
  const tagStart = ivStart + IV_BYTES;
  const cipherStart = tagStart + TAG_BYTES;
  const iv = buf.subarray(ivStart, tagStart);
  const tag = buf.subarray(tagStart, cipherStart);
  const ciphertext = buf.subarray(cipherStart);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw vaultUnavailable();
  }
}

function hasEncryptedFiles(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      throw vaultUnavailable();
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(path.join(current, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.enc')) {
        return true;
      }
    }
  }
  return false;
}

function decodeKeyMaterial(opened) {
  if (Buffer.isBuffer(opened)) {
    if (opened.length !== KEY_BYTES) throw vaultUnavailable();
    return Buffer.from(opened);
  }
  if (typeof opened !== 'string') throw vaultUnavailable();
  const trimmed = opened.trim();
  if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) {
    const key = Buffer.from(trimmed, 'base64');
    if (key.length === KEY_BYTES) return key;
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  throw vaultUnavailable();
}

function ensurePrivateVaultKey(dir, { seal, open } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || typeof seal !== 'function' || typeof open !== 'function') {
    throw vaultUnavailable();
  }
  let dirStat;
  try {
    dirStat = fs.statSync(dir);
  } catch {
    throw vaultUnavailable();
  }
  if (!dirStat.isDirectory()) throw vaultUnavailable();

  const keyPath = path.join(dir, KEY_FILE);
  if (fs.existsSync(keyPath)) {
    let sealed;
    try {
      const stat = fs.lstatSync(keyPath);
      if (!stat.isFile() || stat.size === 0 || stat.size > 16384) throw vaultUnavailable();
      sealed = fs.readFileSync(keyPath, 'utf8').trim();
    } catch {
      throw vaultUnavailable();
    }
    if (!sealed) throw vaultUnavailable();
    let opened;
    try {
      opened = open(sealed);
    } catch {
      throw vaultUnavailable();
    }
    return decodeKeyMaterial(opened);
  }

  if (hasEncryptedFiles(dir)) {
    throw vaultUnavailable();
  }

  const key = crypto.randomBytes(KEY_BYTES);
  const encoded = key.toString('base64');
  let sealed;
  try {
    sealed = seal(encoded);
  } catch {
    throw vaultUnavailable();
  }
  if (typeof sealed !== 'string' || !sealed.trim() || sealed.trim() === encoded) {
    throw vaultUnavailable();
  }

  const tmpPath = path.join(dir, `${KEY_FILE}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, sealed.trim(), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(tmpPath, keyPath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw vaultUnavailable();
  }
  return key;
}

module.exports = {
  DEFAULT_PRIVATE_VAULT_DIR,
  KEY_FILE,
  KEY_BYTES,
  encryptBuffer,
  decryptBuffer,
  ensurePrivateVaultKey,
};
