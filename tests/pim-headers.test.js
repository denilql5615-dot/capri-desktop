'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('PIM header helper protects and decrypts its capability with DPAPI', { skip: process.platform !== 'win32' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-pim-'));
  const configPath = path.join(dir, 'config.json');
  const helperPath = path.join(__dirname, '..', 'scripts', 'pim-headers.ps1');
  const token = 'test-capability';
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const protect = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    '-Protect',
  ], { encoding: 'utf8', input: token });
  assert.equal(protect.status, 0, protect.stderr);
  fs.writeFileSync(configPath, JSON.stringify({ pimMcpToken: protect.stdout.trim() }));
  assert.equal(fs.readFileSync(configPath, 'utf8').includes(token), false);

  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    '-ConfigPath',
    configPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { Authorization: `Bearer ${token}` });
});
