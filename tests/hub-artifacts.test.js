'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { artifactPath, listArtifacts, saveUpload, extractDocumentText } = require('../src/main/hub-artifacts');

test('phone uploads preserve same-name files and reject traversal and malformed data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'capri-hub-upload-'));
  const id = randomUUID();
  const name = 'photo.png';
  const data = Buffer.alloc(128 * 1024, 42);
  const file = { name, data: data.toString('base64') };
  const first = await saveUpload(root, id, [file]);
  const second = await saveUpload(root, id, [{ name, data: 'eA==' }]);
  assert.notEqual(first, second);
  assert.deepEqual(await fs.readFile(first), data);
  await assert.rejects(saveUpload(root, '../escape', [file]), /Недопустимое/);
  await assert.rejects(saveUpload(root, id, [{ ...file, name: '../photo.png' }]), /Недопустимое/);
  await assert.rejects(saveUpload(root, id, [{ ...file, data: 'eA==!' }]), /Недопустимое/);
});

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

test('extractDocumentText reads text/csv directly and extracts office documents via markitdown', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'capri-hub-extract-'));
  const txtFile = path.join(root, 'notes.md');
  await fs.writeFile(txtFile, '# План ALTA\n\nБаланс экономики.');
  const direct = await extractDocumentText(txtFile);
  assert.equal(direct.text, '# План ALTA\n\nБаланс экономики.');
  assert.equal(direct.extractedFile, null);
});
