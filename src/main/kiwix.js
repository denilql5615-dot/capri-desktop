'use strict';

// The root of her knowledge forest: Project NOMAD's offline libraries (Kiwix ZIM, ~95 GB on the home server)
// through kiwix-serve's HTTP — full-text search and article text. Nothing is copied: the corpus stays on
// the server; she searches it and reads what she needs. kiwix-serve searches one language at a time.

const { textOf } = require('./web');

const DEFAULT_URL = 'http://192.168.0.108:8090';
const LANGS = { en: 'eng', ru: 'rus', eng: 'eng', rus: 'rus' };

const decode = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
const strip = (s) => decode(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const tag = (xml, name) => (String(xml).match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1] || '';

/** The libraries: [{ name, title, lang, content }] (content: the /content/<book> path). */
async function catalog({ url = DEFAULT_URL, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${url}/catalog/v2/entries?count=-1`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`kiwix catalog ${res.status}`);
  const xml = await res.text();
  // search wants the full dated name (the content path's last part), not the short <name>
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const content = (e.match(/<link[^>]*type="text\/html"[^>]*href="([^"]+)"/) || [])[1] || '';
    return { name: content.split('/').pop(), short: strip(tag(e, 'name')), title: strip(tag(e, 'title')), lang: strip(tag(e, 'language')), content };
  }).filter((b) => b.content);
}

let cache = null;
async function cachedCatalog(opts) {
  if (cache && cache.url === opts.url && Date.now() - cache.at < 60 * 60 * 1000) return cache.books;
  const books = await catalog(opts);
  cache = { url: opts.url, at: Date.now(), books };
  return books;
}

/**
 * Full-text search: [{ title, link, book, snippet, words }]. lang: 'en' | 'ru' (one at a time), or books: [names]
 * (book names from the catalog, e.g. 'ifixit_en_all'; a dated content name also works).
 */
async function search(pattern, { lang = 'en', books = null, limit = 10, start = 0, url = DEFAULT_URL, fetchImpl = fetch } = {}) {
  const q = String(pattern || '').trim().slice(0, 200);
  if (!q) return [];
  // its own language filter refuses when a many-language library (TED) is in the set: the books of exactly
  // that language are named instead, from the catalog
  let names = books && books.length ? books : null;
  if (!names) {
    const want = LANGS[lang] || lang;
    names = (await cachedCatalog({ url, fetchImpl })).filter((b) => b.lang === want).map((b) => b.name);
    if (!names.length) throw new Error(`в NOMAD нет библиотек на языке «${lang}»`);
  }
  const which = names.map((b) => `books.name=${encodeURIComponent(b)}`).join('&');
  const res = await fetchImpl(`${url}/search?${which}&pattern=${encodeURIComponent(q)}&pageLength=${Math.min(50, limit)}&start=${start}&format=xml`, { signal: AbortSignal.timeout(30000) });
  const xml = await res.text();
  if (!res.ok || /<error>/.test(xml)) throw new Error(`kiwix search: ${strip(tag(xml, 'detail')) || res.status}`);
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
    title: strip(tag(it, 'title')),
    link: strip(tag(it, 'link')),
    book: strip(tag(tag(it, 'book'), 'title')),
    snippet: strip(tag(it, 'description')).slice(0, 400),
    words: Number(strip(tag(it, 'wordCount'))) || null,
  }));
}

/** An article's readable text (a /content/... link from search), up to `chars`. */
async function read(link, { chars = 12000, url = DEFAULT_URL, fetchImpl = fetch } = {}) {
  const path = String(link || '');
  if (!/^\/content\//.test(path)) throw new Error('нужна ссылка вида /content/<книга>/<статья>');
  const res = await fetchImpl(`${url}${encodeURI(decodeURI(path))}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`kiwix read ${res.status}`);
  return textOf(await res.text()).slice(0, chars);
}

module.exports = { catalog, search, read, DEFAULT_URL };
