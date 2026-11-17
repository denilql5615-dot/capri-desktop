'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tor = require('../src/main/tor');

function moduleUrl(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/from '(\.\/[^']+)'/g,
    (_, relative) => `from '${moduleUrl(path.resolve(path.dirname(file), relative))}'`);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

test('chat: a search that says Tor goes to her Tor node, without the Tor words; others do not', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  const { torAsked } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/chat.js')));
  assert.equal(torAsked('найди через тор курс биткоина'), 'курс биткоина');
  assert.equal(torAsked('Капри, поищи по тору новости про DPI'), 'новости про dpi');
  assert.equal(torAsked('find via tor amneziawg config'), 'amneziawg config');
  assert.equal(torAsked('найди в интернете через тор погода'), 'погода');
  assert.ok(torAsked('узнай анонимно через tor кто такой Сатоши'));
  assert.equal(torAsked('найди в интернете погоду'), null); // no Tor: the usual search
  assert.equal(torAsked('найди торт рецепт'), null); // "торт" isn't Tor
  assert.equal(torAsked('найди луковый суп рецепт'), null); // "луковый" isn't Tor either
  assert.equal(torAsked('что такое тор'), null); // a question about Tor, not a search through it
});

test('chat: darknet words search onion sites (Ahmia) over Tor; an onion link is read as it is', async () => {
  const { torHow } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/chat.js')));
  assert.deepEqual(torHow('найди в даркнете утечку базы X'), { query: 'утечку базы x', dark: true, onion: null });
  assert.deepEqual(torHow('поищи по дарквебу форум про DPI'), { query: 'форум про dpi', dark: true, onion: null });
  assert.equal(torHow('найди в говносетях что-нибудь про bitcoin mixer').dark, true);
  assert.equal(torHow('посмотри в сетевой помойке обсуждение X').dark, true);
  assert.equal(torHow('найди через тор новости').dark, false); // plain Tor: the web, anonymously
  const link = 'juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion';
  const r = torHow(`прочитай ${link}/about и скажи что там`);
  assert.equal(r.onion, `${link}/about`);
  assert.equal(r.dark, true);
  assert.equal(torHow('что такое даркнет'), null); // a question about it, not a search in it
});

test('tor.wantsTor / withoutTor (main side) agree with the chat', () => {
  assert.ok(tor.wantsDark('найди в даркнете'));
  assert.equal(tor.onionLink('глянь juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/x'), 'http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/x');
  assert.ok(tor.wantsTor('через тор'));
  assert.ok(tor.wantsTor('открой abc.onion'));
  assert.ok(tor.wantsTor('поищи через онион'));
  assert.ok(tor.wantsTor('check onion routing'));
  assert.ok(!tor.wantsTor('торговля и торт'));
  assert.ok(!tor.wantsTor('луковый суп и луковица'));
  assert.equal(tor.withoutTor('новости через тор сегодня'), 'новости сегодня');
  // Strict explicit command detector: blocks prepositional commands/darknet, allows bare discussion of "Tor"
  assert.ok(tor.wantsTorCommand('найди через тор'));
  assert.ok(tor.wantsTorCommand('search via tor'));
  assert.ok(tor.wantsTorCommand('по тору и over tor'));
  assert.ok(tor.wantsTorCommand('поищи в даркнете'));
  assert.ok(!tor.wantsTorCommand('как устроен Tor и модуль tor.js'));
  assert.ok(!tor.wantsTorCommand('луковый суп'));
});

test('TOR profile prefs: everything through Tor with remote DNS, no direct fallback, WebRTC off, nothing kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-tor-'));
  tor.ensureProfile(dir, 9050);
  const p = fs.readFileSync(path.join(dir, 'user.js'), 'utf8');
  for (const line of [
    'user_pref("network.proxy.type", 1);',
    'user_pref("network.proxy.socks", "127.0.0.1");',
    'user_pref("network.proxy.socks_port", 9050);',
    'user_pref("network.proxy.socks_remote_dns", true);',
    'user_pref("network.proxy.failover_direct", false);',
    'user_pref("network.trr.mode", 5);',
    'user_pref("media.peerconnection.enabled", false);',
    'user_pref("places.history.enabled", false);',
    'user_pref("privacy.sanitize.sanitizeOnShutdown", true);',
    'user_pref("dom.security.https_only_mode", true);',
  ]) assert.ok(p.includes(line), line);
});

test('tor.ensure: running → nothing started; closed → started and waited for "Bootstrapped 100%"', async () => {
  let spawned = 0;
  assert.deepEqual(await tor.ensure({ exe: 'x', socksPort: 1, open: async () => true, spawn: () => { spawned++; } }), { started: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-torlog-'));
  const exe = path.join(dir, 'tor.exe');
  fs.writeFileSync(exe, '');
  const log = path.join(dir, 'notice.log');
  fs.writeFileSync(log, 'old Bootstrapped 100% from before\n'); // an earlier run doesn't count
  const r = tor.ensure({ exe, torrc: 'rc', logFile: log, open: async () => false, timeoutMs: 5000,
    spawn: (e, args) => { spawned++; assert.deepEqual(args, ['-f', 'rc']); setTimeout(() => fs.appendFileSync(log, 'Bootstrapped 100% (done)\n'), 300); } });
  assert.deepEqual(await r, { started: true });
  assert.equal(spawned, 1);
  await assert.rejects(tor.ensure({ exe: path.join(dir, 'nope.exe'), open: async () => false }), /нет tor\.exe/);
});
