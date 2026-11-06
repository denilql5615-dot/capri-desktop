'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { artifactPath, listArtifacts } = require('../src/main/hub-artifacts');

test('Hub only attaches nonempty allowed files produced in the specific run directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'capri-hub-output-'));
  const run = randomUUID();
  const dir = path.join(root, run);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'result.txt'), 'output');
  await fs.writeFile(path.join(dir, 'empty.txt'), '');
  await fs.writeFile(path.join(dir, 'unsafe.exe'), 'bytes');
  await fs.writeFile(path.join(root, 'previous.txt'), 'previous');
  assert.deepEqual(await listArtifacts(root, run), [{ run, name: 'result.txt' }]);
  await assert.rejects(artifactPath(root, run, '../previous.txt'), /Недопустимое/);
});
