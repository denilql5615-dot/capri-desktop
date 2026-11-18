'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kiwix = require('../src/main/kiwix');

const CATALOG = `<feed><entry><name>wikipedia_en_all</name><title>Wikipedia</title><language>eng</language><link type="text/html" href="/content/wikipedia_en_all_mini_2026-06" /></entry>
<entry><name>ted_mul</name><title>TED</title><language>eng,ara</language><link type="text/html" href="/content/ted_mul_ted-ed_2026-09" /></entry>
<entry><name>wikipedia_ru_all</name><title>Википедия</title><language>rus</language><link type="text/html" href="/content/wikipedia_ru_all_nopic_2026-10" /></entry></feed>`;
const RESULTS = `<rss><channel><item><title>Water purification</title><link>/content/wikipedia_en_all_mini_2026-06/Water_purification</link>
<description><b>Water</b> purification is the process&apos;s best</description><book><title>Wikipedia</title></book><wordCount>294</wordCount></item></channel></rss>`;

test('kiwix: full dated book names from the catalog; search names the books of exactly that language', async () => {
  let asked = '';
  const fetchImpl = async (u) => {
    if (u.includes('/catalog/')) return { ok: true, text: async () => CATALOG };
    asked = u;
    return { ok: true, text: async () => RESULTS };
  };
  const books = await kiwix.catalog({ url: 'http://k', fetchImpl });
  assert.deepEqual(books.map((b) => b.name), ['wikipedia_en_all_mini_2026-06', 'ted_mul_ted-ed_2026-09', 'wikipedia_ru_all_nopic_2026-10']);
  const r = await kiwix.search('water purification', { lang: 'en', url: 'http://k2', fetchImpl });
  assert.match(asked, /books\.name=wikipedia_en_all_mini_2026-06/);
  assert.doesNotMatch(asked, /ted_mul|wikipedia_ru/); // a many-language library breaks its search: left out
  assert.deepEqual(r[0], { title: 'Water purification', link: '/content/wikipedia_en_all_mini_2026-06/Water_purification', book: 'Wikipedia', snippet: "Water purification is the process's best", words: 294 });
});

test('kiwix: read needs a /content link; an error page is told', async () => {
  await assert.rejects(kiwix.read('https://evil.example/x'), /нужна ссылка/);
  const fetchImpl = async () => ({ ok: true, text: async () => '<article><p>Boil water for at least one minute to kill pathogens before drinking.</p></article>' });
  assert.match(await kiwix.read('/content/b/A', { url: 'http://k', fetchImpl }), /Boil water/);
  const bad = async (u) => (u.includes('/catalog/') ? { ok: true, text: async () => CATALOG } : { ok: false, status: 400, text: async () => '<error>Invalid</error><detail>No such book: x</detail>' });
  await assert.rejects(kiwix.search('x', { books: ['x'], url: 'http://k3', fetchImpl: bad }), /No such book/);
});

test('kiwix: read keeps valid percent-encoding, encodes raw Unicode/spaces, stays under /content', async () => {
  const urls = [];
  const fetchImpl = async (u) => (urls.push(u), { ok: true, text: async () => '<p>ok</p>' });
  await kiwix.read('/content/b/C%2B%2B_%3A_x%20y', { url: 'http://k:8090', fetchImpl });
  await kiwix.read('/content/b/Привет мир', { url: 'http://k:8090', fetchImpl });
  assert.equal(urls[0], 'http://k:8090/content/b/C%2B%2B_%3A_x%20y');
  assert.equal(urls[1], 'http://k:8090/content/b/%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82%20%D0%BC%D0%B8%D1%80');
  await assert.rejects(kiwix.read('/content/b/../../x', { url: 'http://k', fetchImpl }), /нужна ссылка/);
  await assert.rejects(kiwix.read('/content/b/%2e%2e/%2E%2E/x', { url: 'http://k', fetchImpl }), /нужна ссылка/);
  await kiwix.read('/content/b/A?x=1#sec', { url: 'http://k:8090', fetchImpl });
  assert.equal(urls[2], 'http://k:8090/content/b/A?x=1#sec');
  await assert.rejects(kiwix.read('/content/..?x', { url: 'http://k', fetchImpl }), /нужна ссылка/);
  await assert.rejects(kiwix.read('/content/..\\x', { url: 'http://k', fetchImpl }), /нужна ссылка/);
  assert.equal(urls.length, 3);
  await kiwix.read('/content/b/C%2B%2B%3F_y?x=1#sec', { url: 'http://k:8090/kiwix/', fetchImpl });
  assert.equal(urls[3], 'http://k:8090/kiwix/content/b/C%2B%2B%3F_y?x=1#sec');
  await assert.rejects(kiwix.read('/content/../x', { url: 'http://k:8090/kiwix/', fetchImpl }), /нужна ссылка/);
  assert.equal(urls.length, 4);
});

test('kiwix: local search stays local, and only availability errors retry on the home server', async () => {
  const home = 'http://home-nomad';
  const requests = [];
  let localStatus = 200;
  const fetchImpl = async (address) => {
    const url = new URL(address);
    requests.push(url.origin);
    const status = url.origin === kiwix.LOCAL_URL ? localStatus : 200;
    if (status === 0) throw new TypeError('fetch failed');
    return { ok: status === 200, status, text: async () => '<rss><channel></channel></rss>' };
  };
  const search = () => kiwix.fromLocalFirst((url) => kiwix.search('test', { books: ['book'], url, fetchImpl }), home);

  assert.deepEqual(await search(), []);
  assert.deepEqual(requests.splice(0), [kiwix.LOCAL_URL]);
  for (const status of [0, 503]) {
    localStatus = status;
    assert.deepEqual(await search(), []);
    assert.deepEqual(requests.splice(0), [kiwix.LOCAL_URL, home]);
  }
  localStatus = 404;
  await assert.rejects(search, /kiwix search: 404/);
  assert.deepEqual(requests, [kiwix.LOCAL_URL]);
});
