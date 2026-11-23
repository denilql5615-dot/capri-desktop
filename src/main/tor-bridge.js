'use strict';

// 2.95c: the phone reaches home through her own onion service instead of Tailscale (Danyal, 2026-11-24).
// Tor here is ONLY a transport to this PC's phone bridge: nothing from the Tor network comes in through
// it, and it never touches the browsing Tor node (tor.js, SOCKS 9050) or the isolator. A separate tor.exe
// process with its own data folder, no SOCKS port, one v3 onion service -> 127.0.0.1:<bridge port>,
// and client authorization: without the phone's x25519 key the service does not exist for anyone.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** A client-auth keypair in Tor's form: { publicKey, privateKey } as unpadded base32 of the raw x25519 keys. */
function clientKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const raw = (key, part) => Buffer.from(key.export({ format: 'jwk' })[part], 'base64url');
  return { publicKey: base32(raw(publicKey, 'x')), privateKey: base32(raw(privateKey, 'd')) };
}

function torrc({ dataDir, serviceDir, port }) {
  const p = (s) => s.replace(/\\/g, '/');
  return [
    '# ALTAI:RE 2.95c: onion transport to the phone bridge only. Written by tor-bridge.js.',
    `DataDirectory ${p(dataDir)}`,
    'SocksPort 0',
    `HiddenServiceDir ${p(serviceDir)}`,
    'HiddenServiceVersion 3',
    `HiddenServicePort ${port} 127.0.0.1:${port}`,
    `Log notice file ${p(path.join(dataDir, 'notice.log'))}`,
    '',
  ].join('\n');
}

/**
 * Prepares the folder (once: the client key; every time: the torrc) and returns what the phone needs.
 * root: e.g. D:\Capri\tools\tor-bridge. Never prints a key.
 */
function prepare({ root, port = 8770 }) {
  const dataDir = path.join(root, 'data');
  const serviceDir = path.join(root, 'service');
  const authDir = path.join(serviceDir, 'authorized_clients');
  fs.mkdirSync(authDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const keyFile = path.join(root, 'phone-client.json');
  let keys = null;
  try { keys = JSON.parse(fs.readFileSync(keyFile, 'utf8')); } catch { /* first run */ }
  if (!keys?.publicKey || !keys?.privateKey) {
    keys = clientKeys();
    fs.writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
  }
  fs.writeFileSync(path.join(authDir, 'phone.auth'), `descriptor:x25519:${keys.publicKey}\n`);
  const conf = path.join(root, 'torrc');
  fs.writeFileSync(conf, torrc({ dataDir, serviceDir, port }));
  return { conf, serviceDir, keyFile, keys };
}

/** The onion address once Tor has published the service, else null. */
function hostname(serviceDir) {
  try { return fs.readFileSync(path.join(serviceDir, 'hostname'), 'utf8').trim() || null; } catch { return null; }
}

/** What the phone's Tor needs: its ClientOnionAuthDir line and the address. */
function phoneAuth(host, keys) {
  return `${host.replace(/\.onion$/, '')}:descriptor:x25519:${keys.privateKey}\n`;
}

/** Starts the bridge's own tor.exe if it is not running (one process per data folder). */
function start({ exe, root, port = 8770, spawn = require('node:child_process').spawn, isRunning = null }) {
  if (!exe || !fs.existsSync(exe)) return { ok: false, error: `нет tor.exe (${exe || 'путь не задан'})` };
  const info = prepare({ root, port });
  const lock = path.join(root, 'data', 'lock');
  if (isRunning ? isRunning() : fs.existsSync(lock) && alive(path.join(root, 'tor.pid'))) return { ok: true, started: false, ...info };
  const child = spawn(exe, ['-f', info.conf], { detached: true, stdio: 'ignore', windowsHide: true });
  try { fs.writeFileSync(path.join(root, 'tor.pid'), String(child.pid)); } catch { /* best effort */ }
  child.unref?.();
  return { ok: true, started: true, ...info };
}

function alive(pidFile) {
  try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0); return true; } catch { return false; }
}

module.exports = { base32, clientKeys, torrc, prepare, hostname, phoneAuth, start };
