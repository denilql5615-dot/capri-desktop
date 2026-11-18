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
