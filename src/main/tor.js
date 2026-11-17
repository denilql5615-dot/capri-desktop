'use strict';

// Her second browser node: Tor. tor.exe (Tor Expert Bundle, signature checked at install) runs on this PC as
// a SOCKS proxy on 127.0.0.1 only; her own Camoufox profile "TOR" sends everything through it (DNS too),
// with WebRTC off, no history, nothing kept on exit, HTTPS only. It runs beside your MAIN window, with its
// own control port, so both can work at once. Rules that don't bend:
//   - a request asked "through Tor" goes through Tor or not at all: never through MAIN, never plain;
//   - before each job her Tor window proves it is on Tor (check.torproject.org says IsTor), or nothing is sent;
//   - nothing about it is written down: not in her search log, not in her chats.

const fs = require('fs');
const net = require('net');
const path = require('path');

const ONION_DDG = 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/html/?q={q}';
// Ahmia: a search engine over onion sites themselves, which filters out abuse material; its own onion address
const AHMIA = 'http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion';
const CHECK_URL = 'https://check.torproject.org/api/ip';

// "в даркнете", "по дарквебу", "в говносетях", "сетевая помойка": onion sites, searched with Ahmia, over Tor
const DARK_WORD = /(?<!\p{L})(?:дарк\s?веб\p{L}*|дарк\s?нет\p{L}*|darkweb|dark\s+web|darknet|говносет\p{L}*|сетев\p{L}*\s+помойк\p{L}*)(?!\p{L})/iu;
const DARK_PHRASE = /(?<!\p{L})(?:в|во|по|на|через|in|on)?\s*(?:дарк\s?веб\p{L}*|дарк\s?нет\p{L}*|darkweb|dark\s+web|darknet|говносет\p{L}*|сетев\p{L}*\s+помойк\p{L}*)(?!\p{L})/giu;
// a v3 onion address, with its path if given: read as it is
const ONION_LINK = /(?:https?:\/\/)?[a-z2-7]{56}\.onion(?:\/[^\s"'<>]*)?/i;
const wantsDark = (text) => DARK_WORD.test(String(text || ''));
const onionLink = (text) => {
  const m = String(text || '').match(ONION_LINK);
  return m ? (/^https?:\/\//i.test(m[0]) ? m[0] : `http://${m[0]}`) : null;
};

// "через тор", "по тору", "в торе", "tor", "onion", "онион": the request says Tor
const TOR_WORD = /(?<!\p{L})(?:тор|тора|торе|тору|тором|tor)(?!\p{L})|\.onion(?!\p{L})|(?<!\p{L})(?:онион\p{L}*|onion)(?!\p{L})/iu;
const TOR_PHRASE = /(?<!\p{L})(?:через|по|в|во|используя|с\s+помощью|via|through|over|using)?\s*(?:тор|тора|торе|тору|тором|tor)(?!\p{L})|(?<!\p{L})(?:анонимно|anonymously)(?!\p{L})/giu;
// Strict explicit Tor command (requires a preposition or colon, unlike bare "Tor" in tech discussions)
const TOR_COMMAND = /(?<!\p{L})(?:(?:через|по|в|во|используя|с\s+помощью|via|through|over|using)\s+(?:тор|тора|торе|тору|тором|tor|онион\p{L}*|onion)(?![\p{L}]|\.(?:js|ts|mjs|cjs|md|json)\b)|(?:анонимно|anonymously)(?!\p{L})|(?:tor|тор)\s*:)/iu;

const wantsTor = (text) => TOR_WORD.test(String(text || '')) || wantsDark(text);
const wantsTorCommand = (text) => TOR_COMMAND.test(String(text || '')) || wantsDark(text);
/** The request without its "через тор" / "в даркнете": what is actually searched. */
const withoutTor = (text) => String(text || '').replace(TOR_PHRASE, ' ').replace(DARK_PHRASE, ' ').replace(/\s+/g, ' ').trim();

function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Tor running and connected: started (hidden, on its own) if its SOCKS port is closed, then waited for
 * until its log says "Bootstrapped 100%". Throws if it doesn't get there in time.
 */
async function ensure({ exe, torrc, logFile, socksPort = 9050, timeoutMs = 120000, spawn, open = portOpen } = {}) {
  if (await open(socksPort)) return { started: false };
  if (!exe || !fs.existsSync(exe)) throw new Error(`нет tor.exe (${exe || 'путь не задан'})`);
  const from = logFile && fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  (spawn || ((e, args) => require('child_process').spawn(e, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()))(exe, ['-f', torrc]);
  for (let waited = 0; waited < timeoutMs; waited += 1000) {
    await pause(1000);
    if (logFile && fs.existsSync(logFile)) {
      const fd = fs.openSync(logFile, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const buf = Buffer.alloc(Math.max(0, size - from));
        fs.readSync(fd, buf, 0, buf.length, from);
        if (/Bootstrapped 100%/.test(buf.toString('utf8'))) return { started: true };
      } finally { fs.closeSync(fd); }
    } else if (!logFile && await open(socksPort)) {
      return { started: true };
    }
  }
  throw new Error('Tor не подключился за отведённое время');
}

/** The prefs of her TOR profile (user.js: this profile is hers, made for Tor only). */
function prefs(socksPort = 9050) {
  const p = {
    // everything through Tor, DNS too; no direct fallback, no exceptions
    'network.proxy.type': 1,
    'network.proxy.socks': '127.0.0.1',
    'network.proxy.socks_port': socksPort,
    'network.proxy.socks_version': 5,
    'network.proxy.socks_remote_dns': true,
    'network.proxy.no_proxies_on': '',
    'network.proxy.failover_direct': false,
    'network.trr.mode': 5,
    'network.dns.disablePrefetch': true,
    'network.prefetch-next': false,
    'network.predictor.enabled': false,
    'network.http.speculative-parallel-limit': 0,
    'network.captive-portal-service.enabled': false,
    'network.connectivity-service.enabled': false,
    // no real address leaking out
    'media.peerconnection.enabled': false,
    'geo.enabled': false,
    // nothing kept
    'places.history.enabled': false,
    'browser.formfill.enable': false,
    'signon.rememberSignons': false,
    'browser.cache.disk.enable': false,
    'privacy.sanitize.sanitizeOnShutdown': true,
    'privacy.clearOnShutdown.cookies': true,
    'privacy.clearOnShutdown.history': true,
    'privacy.clearOnShutdown.cache': true,
    'privacy.clearOnShutdown.formdata': true,
    'privacy.clearOnShutdown.sessions': true,
    'privacy.clearOnShutdown.offlineApps': true,
    'privacy.clearOnShutdown.downloads': true,
    'privacy.clearOnShutdown_v2.historyFormDataAndDownloads': true,
    'privacy.clearOnShutdown_v2.cookiesAndStorage': true,
    'privacy.clearOnShutdown_v2.cache': true,
    'browser.sessionstore.resume_from_crash': false,
    'browser.startup.page': 0,
    // HTTPS only (onion addresses aren't upgraded)
    'dom.security.https_only_mode': true,
    // no calls home
    'browser.safebrowsing.malware.enabled': false,
    'browser.safebrowsing.phishing.enabled': false,
    'browser.safebrowsing.downloads.remote.enabled': false,
    'toolkit.telemetry.enabled': false,
    'datareporting.healthreport.uploadEnabled': false,
    'browser.newtabpage.enabled': false,
    'browser.search.suggest.enabled': false,
    'browser.urlbar.suggest.searches': false,
  };
  return Object.entries(p).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n') + '\n';
}

/** Her TOR profile folder with its prefs (written each time, so they can't drift). */
function ensureProfile(dir, socksPort = 9050) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'user.js'), `// Capri's TOR profile: everything through Tor on 127.0.0.1:${socksPort}. Rewritten by Capri.\n${prefs(socksPort)}`, 'utf8');
  return dir;
}

module.exports = { ensure, ensureProfile, prefs, wantsTor, wantsTorCommand, wantsDark, withoutTor, onionLink, portOpen, ONION_DDG, AHMIA, CHECK_URL };
