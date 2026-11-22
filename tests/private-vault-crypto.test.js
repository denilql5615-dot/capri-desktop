'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const pvc = require('../src/main/private-vault-crypto');
const notes = require('../src/main/notes');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'capri-pvc-'));

const mockBox = () => ({
  seal: (plain) => `mock:${Buffer.from(plain, 'utf8').toString('base64')}`,
  open: (stored) => {
    if (typeof stored !== 'string' || !stored.startsWith('mock:')) throw new Error('bad seal');
    return Buffer.from(stored.slice(5), 'base64').toString('utf8');
  },
});

test('DEFAULT_PRIVATE_VAULT_DIR is strictly on drive D: outside Obsidian', () => {
  assert.equal(pvc.DEFAULT_PRIVATE_VAULT_DIR, 'D:\\Capri\\private-vault');
});

test('encryptBuffer and decryptBuffer use CPV1 AES-256-GCM and fail closed on tampering or wrong key', () => {
  const key = crypto.randomBytes(32);
  const wrongKey = crypto.randomBytes(32);
  const secret = 'Секретная строка: пароль99 и токен альфа-бета';
  const buf = pvc.encryptBuffer(key, secret);

  assert.equal(buf.subarray(0, 4).toString('ascii'), 'CPV1');
  assert.ok(buf.length >= 4 + 12 + 16);
  assert.equal(buf.includes(Buffer.from('пароль99', 'utf8')), false);
  assert.equal(pvc.decryptBuffer(key, buf), secret);

  const tamperedTag = Buffer.from(buf);
  tamperedTag[20] ^= 0xff;
  assert.throws(() => pvc.decryptBuffer(key, tamperedTag), /Приватный Vault недоступен/);

  const badMagic = Buffer.from(buf);
  badMagic[0] = 0x58;
  assert.throws(() => pvc.decryptBuffer(key, badMagic), /Приватный Vault недоступен/);

  assert.throws(() => pvc.decryptBuffer(wrongKey, buf), /Приватный Vault недоступен/);
  assert.throws(() => pvc.decryptBuffer(key, buf.subarray(0, 20)), /Приватный Vault недоступен/);
});

test('ensurePrivateVaultKey generates sealed key once, reopens it, and refuses to overwrite lost key over .enc files', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const box = mockBox();

  const key1 = pvc.ensurePrivateVaultKey(dir, box);
  assert.equal(Buffer.isBuffer(key1), true);
  assert.equal(key1.length, 32);

  const keyFile = path.join(dir, pvc.KEY_FILE);
  const stored = fs.readFileSync(keyFile, 'utf8');
  assert.match(stored, /^mock:/);
  assert.equal(stored.includes(key1.toString('base64')), false);
  assert.equal(stored.includes(key1.toString('hex')), false);

  const key2 = pvc.ensurePrivateVaultKey(dir, box);
  assert.deepEqual(key2, key1);

  // If .vault-key.dpapi is deleted while .enc files exist, never regenerate a new key
  fs.writeFileSync(path.join(dir, 'existing-01.md.enc'), pvc.encryptBuffer(key1, 'data'));
  fs.unlinkSync(keyFile);
  assert.throws(() => pvc.ensurePrivateVaultKey(dir, box), /Приватный Vault недоступен/);
  assert.equal(fs.existsSync(keyFile), false);

  // Corrupted key file is rejected without overwriting
  fs.writeFileSync(keyFile, 'corrupted-key-payload', 'utf8');
  assert.throws(() => pvc.ensurePrivateVaultKey(dir, box), /Приватный Vault недоступен/);

  // Plaintext seal return is rejected
  const emptyDir = tmp();
  t.after(() => fs.rmSync(emptyDir, { recursive: true, force: true }));
  assert.throws(() => pvc.ensurePrivateVaultKey(emptyDir, { seal: (s) => s, open: (s) => s }), /Приватный Vault недоступен/);
});

test('savePrivateChat and savePrivateNote encrypt on disk, searchPrivateVault finds them, and searchVault stays blind', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const common = path.join(dir, 'Common');
  const vault = path.join(dir, 'Private');
  fs.mkdirSync(common);
  fs.mkdirSync(vault);

  const key = pvc.ensurePrivateVaultKey(vault, mockBox());
  const chatId = '6d32b710-4b4e-4b3b-9c35-09e41358a2d1';
  const chatSecret = 'кобальтчат88';
  const noteSecret = 'янтарьзаметка99';

  assert.equal(notes.savePrivateChat(vault, common, chatId, [
    { role: 'user', content: `Запомни код ${chatSecret}` },
    { role: 'assistant', content: 'Принято в закрытую память.' },
  ], { append: true, key }), true);

  assert.equal(notes.savePrivateChat(vault, common, chatId, [
    { role: 'user', content: `Запомни код ${chatSecret}` },
    { role: 'assistant', content: 'Принято в закрытую память.' },
    { role: 'user', content: 'Ещё одна реплика опал77' },
  ], { key }), true);

  const chatEncPath = path.join(vault, `altair-chat-${chatId}.enc`);
  assert.equal(fs.existsSync(chatEncPath), true);
  assert.equal(fs.existsSync(path.join(vault, `altair-chat-${chatId}.json`)), false);
  const rawChat = fs.readFileSync(chatEncPath);
  assert.equal(rawChat.subarray(0, 4).toString('ascii'), 'CPV1');
  assert.equal(rawChat.includes(Buffer.from(chatSecret, 'utf8')), false);
  assert.equal(rawChat.includes(Buffer.from('опал77', 'utf8')), false);

  const noteFile = notes.savePrivateNote(vault, common, 'Тайный протокол / доступ', `Содержимое ${noteSecret} для входа.`, { key });
  assert.match(noteFile, /^тайный-протокол-доступ-[0-9a-f]{8}\.md\.enc$/);
  const rawNote = fs.readFileSync(path.join(vault, noteFile));
  assert.equal(rawNote.subarray(0, 4).toString('ascii'), 'CPV1');
  assert.equal(rawNote.includes(Buffer.from(noteSecret, 'utf8')), false);

  // searchPrivateVault finds both encrypted note and encrypted chat
  const noteHits = notes.searchPrivateVault(vault, common, noteSecret, { key });
  assert.equal(noteHits.length, 1);
  assert.equal(noteHits[0].title, 'Тайный протокол / доступ');
  assert.equal(noteHits[0].file, noteFile);
  assert.match(notes.vaultPrompt(noteHits), new RegExp(noteSecret));

  const chatHits = notes.searchPrivateVault(vault, common, chatSecret, { key });
  assert.equal(chatHits.length, 1);
  assert.equal(chatHits[0].file, `altair-chat-${chatId}.enc`);
  assert.match(notes.vaultPrompt(chatHits), new RegExp(chatSecret));

  // Common Obsidian searchVault never reads .enc and never sees private items
  fs.writeFileSync(path.join(common, 'leak-test.md.enc'), rawNote);
  assert.deepEqual(notes.searchVault(common, noteSecret), []);
  assert.deepEqual(notes.searchVault(common, chatSecret), []);

  // Wrong key fails closed on searchPrivateVault and savePrivateChat
  const wrongKey = crypto.randomBytes(32);
  assert.throws(() => notes.searchPrivateVault(vault, common, noteSecret, { key: wrongKey }), /Приватный Vault недоступен/);
  assert.throws(() => notes.savePrivateChat(vault, common, chatId, [{ role: 'user', content: 'x' }], { append: true, key: wrongKey }), /Приватный Vault недоступен/);
});

test('pim-headers.ps1 DPAPI -Protect and -Unprotect round-trips private vault key on Windows', { skip: process.platform !== 'win32' }, (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ps1 = path.join(__dirname, '..', 'scripts', 'pim-headers.ps1');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1];

  const key = pvc.ensurePrivateVaultKey(dir, {
    seal: (plain) => execFileSync('powershell.exe', [...args, '-Protect'], { encoding: 'utf8', input: plain, windowsHide: true }).trim(),
    open: (stored) => execFileSync('powershell.exe', [...args, '-Unprotect'], { encoding: 'utf8', input: stored, windowsHide: true }).trim(),
  });

  const stored = fs.readFileSync(path.join(dir, pvc.KEY_FILE), 'utf8');
  assert.match(stored, /^dpapi:/);

  const reopened = pvc.ensurePrivateVaultKey(dir, {
    seal: () => assert.fail('should not reseal'),
    open: (s) => execFileSync('powershell.exe', [...args, '-Unprotect'], { encoding: 'utf8', input: s, windowsHide: true }).trim(),
  });
  assert.deepEqual(reopened, key);
});
