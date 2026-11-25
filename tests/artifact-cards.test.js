'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.style = {};
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n);
  }
  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }
  click() {
    this.listeners.get('click')?.();
  }
}

test('step-icons exports 24 stroke icons and returns empty string for unknown keys', async () => {
  const { iconSvg, STEP_ICONS } = await import('../src/renderer/js/step-icons.js');
  const expected = [
    'terminal', 'docker', 'server', 'phone', 'pc', 'search', 'web', 'memory',
    'book', 'news', 'play', 'design', 'slides', 'doc', 'sheet', 'image',
    'video', 'code', 'mail', 'link', 'github', 'health', 'sparkle', 'attach',
  ];
  for (const key of expected) {
    const svg = iconSvg(key);
    assert.ok(svg.startsWith('<svg ') && svg.includes('stroke="currentColor"'), `missing icon ${key}`);
  }
  assert.equal(Object.keys(STEP_ICONS).length, 24);
  assert.equal(iconSvg('nonexistent'), '');
});

test('artifact-cards pure helpers format sizes, bound lines, and classify kinds/links', async () => {
  const { formatBytes, firstLines, guessKindFromName, isSafeHttpUrl, isOnionLink } =
    await import('../src/renderer/js/artifact-cards.js');

  assert.equal(formatBytes(512), '512 Б');
  assert.equal(formatBytes(2048), '2 КБ');
  assert.equal(formatBytes(1572864), '1.5 МБ');

  const sample = Array.from({ length: 35 }, (_, i) => `line ${i + 1}`).join('\n');
  const sliced = firstLines(sample, 30);
  assert.equal(sliced.truncated, true);
  assert.equal(sliced.total, 35);
  assert.ok(sliced.preview.endsWith('line 30\n…'));

  assert.equal(guessKindFromName('diagram.svg'), 'image');
  assert.equal(guessKindFromName('clip.mp4'), 'video');
  assert.equal(guessKindFromName('deck.pptx'), 'slides');
  assert.equal(guessKindFromName('data.xlsx'), 'sheet');
  assert.equal(guessKindFromName('app.js'), 'code');

  assert.equal(isSafeHttpUrl('https://example.com/a'), true);
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(isOnionLink({ url: 'http://abc.onion/test', domain: 'abc.onion', kind: 'onion' }), true);
  assert.equal(isOnionLink({ url: 'https://example.com', domain: 'example.com', kind: 'web' }), false);
});

test('renderArtifacts renders image via <img>, video, doc/slides buttons, and non-clickable onion chips', async (t) => {
  const { renderArtifacts } = await import('../src/renderer/js/artifact-cards.js');
  global.document = { createElement: (tag) => new Element(tag) };
  t.after(() => { delete global.document; });

  const opened = [];
  const revealed = [];
  const visited = [];
  const host = {
    artifacts: {
      src: async (id) => `capri://files/${id}`,
      open: (id) => opened.push(id),
      reveal: (id) => revealed.push(id),
    },
    chatsOpenLink: (url) => visited.push(url),
  };

  const container = new Element('div');
  const wrap = renderArtifacts(
    container,
    [
      { id: 'img1', kind: 'image', name: 'chart.svg', size: 1200 },
      { id: 'vid1', kind: 'video', name: 'clip.mp4', size: 4096 },
      { id: 'ppt1', kind: 'slides', name: 'deck.pptx', size: 8192, editUrl: 'http://127.0.0.1:5100/edit/1' },
    ],
    [
      { url: 'https://example.com/docs', domain: 'example.com', label: 'Docs', kind: 'web' },
      { url: 'http://secret123.onion/page', domain: 'secret123.onion', label: 'Hidden', kind: 'onion' },
    ],
    { host },
  );

  await new Promise((r) => setTimeout(r, 10));

  assert.ok(wrap);
  const [itemsGrid, linksRow] = wrap.children;
  assert.equal(itemsGrid.children.length, 3);

  const imgEl = itemsGrid.children[0].children[0];
  assert.equal(imgEl.tagName, 'img');
  assert.equal(imgEl.src, 'capri://files/img1');
  imgEl.click();
  assert.deepEqual(opened, ['img1']);

  const videoEl = itemsGrid.children[1].children[0];
  assert.equal(videoEl.tagName, 'video');
  assert.equal(videoEl.controls, true);
  assert.equal(videoEl.preload, 'metadata');
  assert.equal(videoEl.src, 'capri://files/vid1');

  const slidesActions = itemsGrid.children[2].children[1].children;
  assert.deepEqual(slidesActions.map((b) => b.textContent), ['Открыть', 'Показать в папке', 'Редактор']);
  slidesActions[1].click();
  slidesActions[2].click();
  assert.deepEqual(revealed, ['ppt1']);
  assert.deepEqual(visited, ['http://127.0.0.1:5100/edit/1']);

  assert.equal(linksRow.children.length, 2);
  assert.equal(linksRow.children[0].tagName, 'button');
  linksRow.children[0].click();
  assert.deepEqual(visited, ['http://127.0.0.1:5100/edit/1', 'https://example.com/docs']);

  assert.equal(linksRow.children[1].tagName, 'span');
  assert.ok(linksRow.children[1].className.includes('is-onion'));
});
