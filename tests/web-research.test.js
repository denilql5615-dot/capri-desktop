'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { research, mergeResults, pickFragments, uniqueQueries } = require('../src/main/web-research');

test('uniqueQueries keeps up to 6 distinct queries and always the question', () => {
  const qs = uniqueQueries('что такое LTS', ['node lts', 'Node LTS', 'node lts schedule', 'a', 'b', 'c', 'd']);
  assert.equal(qs.length, 6);
  assert.equal(qs.filter((q) => q.toLowerCase() === 'node lts').length, 1);
});

test('mergeResults ranks links found by more queries first and caps per host', () => {
  const merged = mergeResults([
    [{ url: 'https://a.com/1', title: 'A1' }, { url: 'https://b.com/x' }, { url: 'https://a.com/2' }, { url: 'https://a.com/3' }],
    [{ url: 'https://b.com/x#frag' }, { url: 'https://c.com/' }],
  ], { perHost: 2, limit: 10 });
  assert.equal(merged[0].url, 'https://b.com/x');
  assert.equal(merged.filter((r) => r.url.includes('a.com')).length, 2);
});

test('pickFragments keeps the relevant chunks, at most 3 per source, within the budget', () => {
  const pages = [
    { text: 'Node.js 24 стала LTS в октябре 2025 года. Поддержка LTS длится до апреля 2028.\nРецепт борща: свёкла, капуста, картофель, мясо, лук и морковь — всё варится долго.' },
    { text: 'Расписание релизов Node.js: чётные версии становятся LTS. Активная поддержка и поддержка безопасности.' },
  ];
  const picked = pickFragments(pages, 'когда заканчивается поддержка LTS Node.js', [], { budget: 2000 });
  assert.ok(picked.length >= 1);
  assert.ok(picked.every((p) => !/борщ/i.test(p.text) || /LTS/.test(p.text)));
});

test('research on main: several queries, many pages, numbered sources and fragments', async () => {
  const searched = [];
  const res = await research({ question: 'поддержка LTS Node.js', queries: ['node lts end of life', 'nodejs release schedule'] }, {
    searxSearch: async (q) => {
      searched.push(q);
      return [
        { url: 'https://nodejs.org/en/about/previous-releases', title: 'Releases' },
        { url: `https://example${searched.length}.com/lts`, title: `Ex ${searched.length}` },
      ];
    },
    fetchPage: async (url) => ({ text: `Node.js LTS support ends in April 2028 according to ${url}. `.repeat(12) }),
  });
  assert.equal(res.ok, true);
  assert.equal(searched.length, 3);
  assert.ok(res.stats.read >= 3);
  assert.match(res.output, /Источники:\n\[1\]/);
  assert.match(res.output, /Фрагменты:/);
  assert.match(res.output, /\[n\]/);
});

test('research on tor uses only the isolator and never the open-web helpers', async () => {
  let openWeb = 0;
  const res = await research({ question: 'onion форумы про приватность', queries: ['privacy forum onion'], node: 'tor' }, {
    searxSearch: async () => { openWeb += 1; return []; },
    fetchPage: async () => { openWeb += 1; return { text: '' }; },
    isolatorSearch: async ({ query }) => ({
      results: [{ url: 'hxxp://abc[.]onion/a', title: `r ${query}` }, { url: 'hxxp://def[.]onion/b', title: 'r2' }],
      pages: [{ url: 'hxxp://abc[.]onion/a', title: 'A', text: 'privacy forum discussion about onion privacy tools. '.repeat(10) }],
    }),
    isolatorRead: async (urls) => ({ pages: urls.map((u) => ({ url: u, title: 'B', text: 'more privacy notes onion forum. '.repeat(10) })) }),
  });
  assert.equal(openWeb, 0);
  assert.equal(res.ok, true);
});

test('research on tor without the isolator refuses instead of going around Tor', async () => {
  const res = await research({ question: 'x', node: 'tor' }, { searxSearch: async () => [] });
  assert.equal(res.ok, false);
  assert.match(res.output, /мимо Tor/);
});
