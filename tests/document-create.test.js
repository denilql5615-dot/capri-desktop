'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { createDocument } = require('../src/main/document-create');

function withTempArtifactsDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-doc-test-'));
  const prev = process.env.CAPRI_ARTIFACTS_DIR;
  process.env.CAPRI_ARTIFACTS_DIR = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (prev === undefined) delete process.env.CAPRI_ARTIFACTS_DIR;
      else process.env.CAPRI_ARTIFACTS_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

test('createDocument writes text, code, json, and csv formats directly to artifactsDir', () => withTempArtifactsDir(async (dir) => {
  const md = await createDocument({ format: 'md', title: 'Отчёт', content: '# Заголовок\nТекст' });
  assert.equal(md.ok, true);
  assert.equal(path.dirname(md.path), path.resolve(dir));
  assert.equal(fs.readFileSync(md.path, 'utf8'), '# Заголовок\nТекст');

  const csv = await createDocument({
    format: 'csv',
    title: 'Таблица',
    rows: [['Имя', 'Балл'], ['Альтаир', 100]],
  });
  assert.equal(csv.ok, true);
  assert.equal(fs.readFileSync(csv.path, 'utf8'), 'Имя,Балл\r\nАльтаир,100');

  const json = await createDocument({ format: 'json', title: 'Config', content: { ok: true } });
  assert.equal(json.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(json.path, 'utf8')), { ok: true });
}));

test('createDocument validates SVG against <script> and on* attributes', () => withTempArtifactsDir(async () => {
  const badScript = await createDocument({
    format: 'svg',
    title: 'bad1',
    content: '<svg><script>alert(1)</script></svg>',
  });
  assert.equal(badScript.ok, false);
  assert.match(badScript.error, /script/i);

  const badOn = await createDocument({
    format: 'svg',
    title: 'bad2',
    content: '<svg onload="alert(1)"></svg>',
  });
  assert.equal(badOn.ok, false);

  const good = await createDocument({
    format: 'svg',
    title: 'good',
    content: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  });
  assert.equal(good.ok, true);
  assert.equal(fs.existsSync(good.path), true);
}));

test('createDocument generates valid .xlsx and .pptx via Python stdlib scripts', () => withTempArtifactsDir(async () => {
  const xlsx = await createDocument({
    format: 'xlsx',
    title: 'Бюджет',
    rows: [['Статья', 'Сумма'], ['Сервер', 1200], ['Домен', 500]],
  });
  assert.equal(xlsx.ok, true, xlsx.error);
  assert.equal(path.extname(xlsx.path), '.xlsx');
  assert.ok(fs.statSync(xlsx.path).size > 200);

  const pptx = await createDocument({
    format: 'pptx',
    title: 'План',
    slides: [
      { title: 'Слайд 1', bullets: ['Пункт А', 'Пункт Б'] },
      { title: 'Слайд 2', bullets: ['Итоги'] },
    ],
  });
  assert.equal(pptx.ok, true, pptx.error);
  assert.equal(path.extname(pptx.path), '.pptx');
  assert.ok(fs.statSync(pptx.path).size > 500);

  // Verify both archives with Python zipfile
  const pyBin = process.platform === 'win32' ? 'py' : 'python3';
  const check = await new Promise((resolve, reject) => {
    execFile(pyBin, [
      '-c',
      `import zipfile, sys; z1=zipfile.ZipFile(sys.argv[1]); z2=zipfile.ZipFile(sys.argv[2]); print('xl/workbook.xml' in z1.namelist(), 'xl/worksheets/sheet1.xml' in z1.namelist(), 'ppt/presentation.xml' in z2.namelist(), 'ppt/slides/slide2.xml' in z2.namelist())`,
      xlsx.path,
      pptx.path,
    ], (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
  assert.equal(check, 'True True True True');
}));

test('createDocument delegates docx/pdf to pcToolsEngine.convertDocument and handles unsupported format', () => withTempArtifactsDir(async () => {
  const calls = [];
  const mockPcTools = {
    async convertDocument({ inputPath, targetFormat, outDir }) {
      calls.push({ inputPath, targetFormat, outDir });
      const stem = path.basename(inputPath, path.extname(inputPath));
      const outPath = path.join(outDir, `${stem}.${targetFormat}`);
      fs.writeFileSync(outPath, 'converted');
      return { ok: true, outputPath: outPath, bytes: 9 };
    },
  };

  const docx = await createDocument({ format: 'docx', title: 'Memo', content: '# Hi' }, { pcToolsEngine: mockPcTools });
  assert.equal(docx.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].targetFormat, 'docx');

  const bad = await createDocument({ format: 'exe', title: 'Nope', content: '' });
  assert.equal(bad.ok, false);
}));
