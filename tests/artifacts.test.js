'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  registerArtifact,
  getArtifact,
  publicArtifact,
  kindOf,
  mimeFor,
  extractLinks,
  artifactsDir,
} = require('../src/main/artifacts');
const { PhoneBridge } = require('../src/main/phone');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-art-test-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('artifactsDir respects CAPRI_ARTIFACTS_DIR override and creates directory', () => withTempDir((dir) => {
  const prev = process.env.CAPRI_ARTIFACTS_DIR;
  const target = path.join(dir, 'nested', 'artifacts');
  process.env.CAPRI_ARTIFACTS_DIR = target;
  try {
    const resolved = artifactsDir();
    assert.equal(resolved, path.resolve(target));
    assert.equal(fs.existsSync(resolved), true);
  } finally {
    if (prev === undefined) delete process.env.CAPRI_ARTIFACTS_DIR;
    else process.env.CAPRI_ARTIFACTS_DIR = prev;
  }
}));

test('kindOf and mimeFor map extensions accurately', () => {
  assert.equal(kindOf('photo.png'), 'image');
  assert.equal(kindOf('diagram.svg'), 'image');
  assert.equal(kindOf('clip.mp4'), 'video');
  assert.equal(kindOf('voice.mp3'), 'audio');
  assert.equal(kindOf('report.pdf'), 'pdf');
  assert.equal(kindOf('notes.docx'), 'doc');
  assert.equal(kindOf('deck.pptx'), 'slides');
  assert.equal(kindOf('table.xlsx'), 'sheet');
  assert.equal(kindOf('data.csv'), 'sheet');
  assert.equal(kindOf('app.py'), 'code');
  assert.equal(kindOf('archive.bin'), 'file');

  assert.equal(mimeFor('a.svg'), 'image/svg+xml');
  assert.equal(mimeFor('a.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(mimeFor('a.pptx'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.equal(mimeFor('a.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  for (const ext of ['.py', '.js', '.ts', '.kt', '.ps1', '.json', '.md', '.html', '.css']) {
    assert.equal(mimeFor(`file${ext}`), 'text/plain; charset=utf-8');
  }
});

test('registerArtifact, getArtifact, and publicArtifact never leak path publicly', () => withTempDir((dir) => {
  const filePath = path.join(dir, 'sample.py');
  fs.writeFileSync(filePath, 'print("hello")\n', 'utf8');

  assert.equal(registerArtifact(path.join(dir, 'missing.py')), null);
  assert.equal(registerArtifact(dir), null);

  const pub = registerArtifact(filePath, { target: 'local', domain: '127.0.0.1' });
  assert.ok(pub);
  assert.equal(pub.kind, 'code');
  assert.equal(pub.name, 'sample.py');
  assert.equal(pub.mime, 'text/plain; charset=utf-8');
  assert.equal(pub.url, `/files/${pub.id}`);
  assert.equal('path' in pub, false);

  const full = getArtifact(pub.id);
  assert.ok(full);
  assert.equal(full.path, path.resolve(filePath));
  assert.equal('path' in publicArtifact(full), false);

  fs.unlinkSync(filePath);
  assert.equal(getArtifact(pub.id), null);
}));

test('extractLinks parses markdown and bare URLs, dedupes, labels known services and kinds', () => {
  const text = [
    'Слайды: [Открыть](http://127.0.0.1:5100/deck/1).',
    'Повтор http://127.0.0.1:5100/deck/1,',
    'Penpot http://localhost:9001/proj',
    'Лента http://192.168.0.107:8082/i/',
    'Wger http://192.168.0.107:8085/',
    'PDF http://127.0.0.1:8400',
    'Comfy http://127.0.0.1:8188',
    'Notebook http://127.0.0.1:8502',
    'Kiwix http://127.0.0.1:8090',
    'Repo https://github.com/denilql5615-dot/capri-desktop.',
    'Onion http://exampleabcdef.onion/page',
  ].join('\n');

  const links = extractLinks(text);
  assert.equal(links.length, 10);

  assert.deepEqual(links[0], {
    url: 'http://127.0.0.1:5100/deck/1',
    domain: '127.0.0.1:5100',
    label: 'Открыть',
    kind: 'local',
  });
  assert.equal(links[1].label, 'Penpot');
  assert.equal(links[1].kind, 'local');
  assert.equal(links[2].label, 'FreshRSS');
  assert.equal(links[2].kind, 'local');
  assert.equal(links[3].label, 'Wger');
  assert.equal(links[4].label, 'Stirling-PDF');
  assert.equal(links[5].label, 'ComfyUI');
  assert.equal(links[6].label, 'OpenNotebook');
  assert.equal(links[7].label, 'Kiwix');
  assert.equal(links[8].label, 'GitHub');
  assert.equal(links[8].kind, 'web');
  assert.equal(links[9].kind, 'onion');
});

test('PhoneBridge GET /files/:id serves files with security headers, CSP for svg, and 206 Range', () => withTempDir(async (dir) => {
  const svgPath = path.join(dir, 'icon.svg');
  fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
  const svgArt = registerArtifact(svgPath);

  const vidPath = path.join(dir, 'clip.mp4');
  fs.writeFileSync(vidPath, Buffer.from('0123456789abcdef'));
  const vidArt = registerArtifact(vidPath);

  const bridge = new PhoneBridge({
    token: () => 'test-token',
    chat: async () => ({ text: 'ok' }),
    control: () => ({}),
    applyControl: () => ({}),
    event: () => {},
    speak: async () => null,
    sprites: () => null,
    status: async () => ({}),
  });
  const port = await bridge.start(0, '127.0.0.1');

  const request = (urlPath, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });

  try {
    const unauth = await request(svgArt.url);
    assert.equal(unauth.status, 401);

    const svgRes = await request(svgArt.url, { 'x-capri-token': 'test-token' });
    assert.equal(svgRes.status, 200);
    assert.equal(svgRes.headers['x-content-type-options'], 'nosniff');
    assert.equal(svgRes.headers['content-security-policy'], "default-src 'none'");
    assert.match(svgRes.headers['content-disposition'], /inline; filename\*=UTF-8''icon\.svg/);

    const rangeRes = await request(vidArt.url, { 'x-capri-token': 'test-token', range: 'bytes=2-5' });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers['content-range'], 'bytes 2-5/16');
    assert.equal(rangeRes.body.toString('utf8'), '2345');
  } finally {
    await bridge.stop();
  }
}));
