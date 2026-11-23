'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bridge = require('../src/main/tor-bridge');

test('base32 matches RFC 4648 without padding', () => {
  assert.equal(bridge.base32(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(bridge.base32(Buffer.alloc(32)).length, 52);
});

test('client keys are 52-char base32 x25519 keys', () => {
  const { publicKey, privateKey } = bridge.clientKeys();
  assert.match(publicKey, /^[A-Z2-7]{52}$/);
  assert.match(privateKey, /^[A-Z2-7]{52}$/);
  assert.notEqual(publicKey, privateKey);
});

test('the bridge Tor has no SOCKS port, one v3 service to the bridge port, and client auth that survives restarts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'torbridge-'));
  const first = bridge.prepare({ root, port: 8770 });
  const conf = fs.readFileSync(first.conf, 'utf8');
  assert.match(conf, /^SocksPort 0$/m);
  assert.match(conf, /^HiddenServiceVersion 3$/m);
  assert.match(conf, /^HiddenServicePort 8770 127\.0\.0\.1:8770$/m);
  assert.doesNotMatch(conf, /SocksPort 9050|ControlPort/);
  const auth = fs.readFileSync(path.join(first.serviceDir, 'authorized_clients', 'phone.auth'), 'utf8');
  assert.equal(auth, `descriptor:x25519:${first.keys.publicKey}\n`);
  assert.deepEqual(bridge.prepare({ root }).keys, first.keys);
  assert.equal(bridge.phoneAuth('abc.onion', first.keys), `abc:descriptor:x25519:${first.keys.privateKey}\n`);
  assert.equal(bridge.hostname(first.serviceDir), null);
});
