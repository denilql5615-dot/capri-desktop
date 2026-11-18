#!/usr/bin/env python3
"""One-shot Tor isolator job: strict fail-closed Tor SOCKS5 routing + headless Camoufox over WebDriver BiDi."""

import base64
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import time
import urllib.parse

CAMOUFOX_BIN = "/opt/camoufox/camoufox"
BIDI_PORT = 9222
PROFILE_DIR = "/tmp/profile"
DEFAULT_GW_IP = "172.25.0.2"
TOR_CHECK_URL = "https://check.torproject.org/api/ip"
ONION_DDG = "https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/html/?q={q}"
AHMIA_BASE = "http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion"

MAX_RESULTS = 10
MAX_PAGES = 5
MAX_PAGE_CHARS = 20000

CHALLENGE_RE = re.compile(
    r"(just a moment|attention required|verify you are human|are you a robot|captcha|access denied|"
    r"checking your browser|one moment|please wait|один момент|подождите|подтвердите, что вы не робот|"
    r"проверка браузера|проверяем|выполняется проверка)",
    re.I,
)
LOGIN_WALL_RE = re.compile(
    r"(^|\.)(facebook|instagram|threads|linkedin|tiktok|pinterest)\.com$|"
    r"(^|\.)(x|twitter)\.com$|(^|\.)vk\.com$",
    re.I,
)


class BiDiClient:
    """Minimal RFC 6455 WebSocket + WebDriver BiDi client using stdlib sockets."""

    def __init__(self, host, port, path="/session", timeout=20.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode("ascii"))
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("WebSocket handshake EOF")
            buf += chunk
        head, rest = buf.split(b"\r\n\r\n", 1)
        if b"101" not in head.split(b"\r\n", 1)[0]:
            raise RuntimeError(f"WebSocket handshake failed: {head.decode('latin1', 'replace')}")
        self.rx = bytearray(rest)
        self.next_id = 1

    def _recv_exact(self, n):
        while len(self.rx) < n:
            chunk = self.sock.recv(max(4096, n - len(self.rx)))
            if not chunk:
                raise RuntimeError("WebSocket EOF")
            self.rx.extend(chunk)
        out = bytes(self.rx[:n])
        del self.rx[:n]
        return out

    def _send_frame(self, opcode, data):
        mask = os.urandom(4)
        length = len(data)
        header = bytearray([0x80 | opcode])
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        header.extend(mask)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(bytes(header) + masked)

    def _recv_msg(self):
        chunks = []
        while True:
            b1, b2 = self._recv_exact(2)
            fin = bool(b1 & 0x80)
            opcode = b1 & 0x0F
            length = b2 & 0x7F
            if length == 126:
                (length,) = struct.unpack("!H", self._recv_exact(2))
            elif length == 127:
                (length,) = struct.unpack("!Q", self._recv_exact(8))
            if b2 & 0x80:
                mask = self._recv_exact(4)
                raw = self._recv_exact(length)
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(raw))
            else:
                payload = self._recv_exact(length)
            if opcode == 0x8:
                raise RuntimeError("WebSocket closed")
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            chunks.append(payload)
            if fin:
                return b"".join(chunks).decode("utf-8", "replace")

    def call(self, method, params=None, timeout=30.0):
        cid = self.next_id
        self.next_id += 1
        self.sock.settimeout(timeout)
        self._send_frame(0x1, json.dumps({"id": cid, "method": method, "params": params or {}}).encode("utf-8"))
        deadline = time.monotonic() + timeout
        while True:
            rem = deadline - time.monotonic()
            if rem <= 0:
                raise TimeoutError(f"BiDi timeout calling {method}")
            self.sock.settimeout(rem)
            msg = json.loads(self._recv_msg())
            if msg.get("id") == cid:
                if msg.get("type") == "error":
                    raise RuntimeError(f"{msg.get('error')}: {msg.get('message')}")
                return msg.get("result")

    def close(self):
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


def tcp_probe(host, port, family=socket.AF_INET, timeout=2.5):
    t0 = time.monotonic()
    s = socket.socket(family, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return {"reachable": True, "ms": round((time.monotonic() - t0) * 1000)}
    except Exception as e:
        return {
            "reachable": False,
            "error": f"{type(e).__name__}: {e}",
            "errno": getattr(e, "errno", None),
            "ms": round((time.monotonic() - t0) * 1000),
        }
    finally:
        s.close()


def run_net_probes(gateway):
    out = {"ok": True, "routes": [], "probes": {}}
    try:
        with open("/proc/net/route", "r", encoding="utf-8") as f:
            out["routes"] = f.read().strip().splitlines()
    except Exception as e:
        out["routes_error"] = str(e)
    out["probes"]["torgw_9050"] = tcp_probe(DEFAULT_GW_IP, 9050)
    out["probes"]["direct_ip_1_1_1_1_80"] = tcp_probe("1.1.1.1", 80)
    out["probes"]["direct_ip_1_1_1_1_443"] = tcp_probe("1.1.1.1", 443)
    if gateway:
        for p in (80, 9050, 9339, 9340, 11434, 47823):
            out["probes"][f"gw_{gateway}_{p}"] = tcp_probe(gateway, p)
    return out


def write_tor_profile(profile_dir, socks_host):
    os.makedirs(profile_dir, exist_ok=True)
    prefs = {
        "remote.active-protocols": 1,
        "remote.prefs.recommended": False,
        "browser.startup.page": 0,
        "browser.sessionstore.resume_from_crash": False,
        "media.peerconnection.enabled": False,
        "geo.enabled": False,
        "pdfjs.disabled": True,
        "webgl.disabled": True,
        "javascript.options.wasm": False,
        "dom.security.https_only_mode": True,
        "places.history.enabled": False,
        "browser.formfill.enable": False,
        "signon.rememberSignons": False,
        "browser.cache.disk.enable": False,
        "browser.download.folderList": 2,
        "browser.download.useDownloadDir": False,
        "browser.download.always_ask_before_handling_new_types": True,
        "browser.download.manager.showWhenStarting": False,
        "browser.download.start_downloads_in_tmp_dir": False,
        "browser.download.panel.shown": False,
        "browser.download.policy.autoOpen": False,
        "browser.helperApps.neverAsk.saveToDisk": "",
        "browser.helperApps.neverAsk.openFile": "",
        "browser.safebrowsing.malware.enabled": False,
        "browser.safebrowsing.phishing.enabled": False,
        "browser.safebrowsing.downloads.remote.enabled": False,
        "toolkit.telemetry.enabled": False,
        "datareporting.healthreport.uploadEnabled": False,
        "browser.newtabpage.enabled": False,
        "browser.search.suggest.enabled": False,
        "browser.urlbar.suggest.searches": False,
        "network.captive-portal-service.enabled": False,
        "network.connectivity-service.enabled": False,
        "network.dns.disablePrefetch": True,
        "network.prefetch-next": False,
        "network.predictor.enabled": False,
        "network.http.speculative-parallel-limit": 0,
        "network.trr.mode": 5,
        "network.proxy.type": 1,
        "network.proxy.socks": socks_host,
        "network.proxy.socks_port": 9050,
        "network.proxy.socks_version": 5,
        "network.proxy.socks_remote_dns": True,
        "network.proxy.no_proxies_on": "",
        "network.proxy.failover_direct": False,
    }
    lines = [f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k, v in prefs.items()]
    with open(os.path.join(profile_dir, "user.js"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def usable_url(raw):
    try:
        u = urllib.parse.urlparse(str(raw or "").strip())
    except Exception:
        return None
    if u.scheme.lower() not in ("http", "https") or not u.hostname or "." not in u.hostname:
        return None
    host = u.hostname.lower()
    if LOGIN_WALL_RE.search(host):
        return None
    if re.search(r"(^|\.)reddit\.com$", host):
        u = u._replace(netloc="old.reddit.com")
    return urllib.parse.urlunparse(u)


def parse_duck_results(raw_items, limit):
    seen = set()
    out = []
    for r in raw_items or []:
        url = str(r.get("href") or "").strip()
        try:
            u = urllib.parse.urlparse(urllib.parse.urljoin("https://duckduckgo.com", url))
            host = (u.hostname or "").lower()
            is_ddg = host == "duckduckgo.com" or host.endswith(".duckduckgo.com") or bool(re.match(r"^duckduckgogg42\w*\.onion$", host))
            if is_ddg and u.path == "/l/":
                qs = urllib.parse.parse_qs(u.query)
                url = (qs.get("uddg") or [""])[0]
            elif is_ddg:
                continue
            target = usable_url(url)
            if not target:
                continue
            thost = (urllib.parse.urlparse(target).hostname or "").lower()
            if thost.startswith("www."):
                thost = thost[4:]
            if thost in seen:
                continue
            seen.add(thost)
        except Exception:
            continue
        title = re.sub(r"\s+", " ", str(r.get("title") or "")).strip()[:200]
        snippet = re.sub(r"\s+", " ", str(r.get("snippet") or "")).strip()[:300]
        out.append({"title": title, "url": target, "snippet": snippet})
        if len(out) >= limit:
            break
    return out


def parse_ahmia_results(raw_items, limit):
    seen = set()
    out = []
    for r in raw_items or []:
        url = ""
        try:
            u = urllib.parse.urlparse(urllib.parse.urljoin("http://ahmia.local", str(r.get("href") or "")))
            qs = urllib.parse.parse_qs(u.query)
            url = (qs.get("redirect_url") or [""])[0]
        except Exception:
            url = ""
        if not url and r.get("cite"):
            cite = str(r.get("cite") or "").strip()
            url = cite if re.match(r"^https?://", cite, re.I) else f"http://{cite}"
        try:
            p = urllib.parse.urlparse(url)
            host = (p.hostname or "").lower()
            if p.scheme.lower() not in ("http", "https") or not host.endswith(".onion") or host in seen:
                continue
            seen.add(host)
        except Exception:
            continue
        title = re.sub(r"\s+", " ", str(r.get("title") or "")).strip()[:200]
        snippet = re.sub(r"\s+", " ", str(r.get("snippet") or "")).strip()[:300]
        out.append({"title": title, "url": url, "snippet": snippet})
        if len(out) >= limit:
            break
    return out


def eval_json(client, ctx_id, expr, timeout=12.0):
    res = client.call(
        "script.evaluate",
        {
            "expression": expr,
            "target": {"context": ctx_id},
            "awaitPromise": False,
            "resultOwnership": "none",
        },
        timeout=timeout,
    )
    val = (res.get("result") or {}).get("value")
    if isinstance(val, str):
        return json.loads(val)
    return None


def read_page(client, ctx_id, target_url, timeout_s):
    if not re.match(r"^https?://", str(target_url or ""), re.I):
        return {"url": str(target_url or ""), "title": "", "text": "", "truncated": False, "blocked": False}
    try:
        nav = client.call(
            "browsingContext.navigate",
            {"context": ctx_id, "url": target_url, "wait": "complete"},
            timeout=timeout_s,
        )
        final_url = str((nav or {}).get("url") or target_url)
        if not re.match(r"^https?://", final_url, re.I):
            return {"url": target_url, "title": "", "text": "", "truncated": False, "blocked": False}

        def snap():
            data = eval_json(
                client,
                ctx_id,
                """JSON.stringify({
                  url: location.href || '',
                  title: document.title || '',
                  text: (() => {
                    const m = document.querySelector('article, main, [role=main]');
                    const body = document.body ? document.body.innerText : '';
                    const inMain = m ? m.innerText : '';
                    return inMain && inMain.length > 300 ? inMain : body;
                  })()
                })""",
            ) or {}
            title = str(data.get("title") or "").strip()
            raw_text = str(data.get("text") or "")
            clean = "\n".join(line.strip() for line in raw_text.splitlines() if len(line.strip()) > 30)
            is_check = bool(CHALLENGE_RE.search(title) or (len(clean) < 400 and CHALLENGE_RE.search(clean)))
            cur = str(data.get("url") or final_url)
            return title, clean, is_check, cur

        title, clean, is_check, cur_url = snap()
        if is_check:
            time.sleep(2.5)
            title, clean, is_check, cur_url = snap()

        if not re.match(r"^https?://", cur_url, re.I):
            cur_url = target_url
        truncated = len(clean) > MAX_PAGE_CHARS
        return {
            "url": cur_url,
            "title": title[:200],
            "text": clean[:MAX_PAGE_CHARS],
            "truncated": truncated,
            "blocked": bool(is_check),
        }
    except Exception:
        return {"url": str(target_url), "title": "", "text": "", "truncated": False, "blocked": False}


def search_ddg(client, ctx_id, query, limit, timeout_s):
    at = ONION_DDG.replace("{q}", urllib.parse.quote(query))
    client.call("browsingContext.navigate", {"context": ctx_id, "url": at, "wait": "complete"}, timeout=timeout_s)
    raw = eval_json(
        client,
        ctx_id,
        """JSON.stringify([...document.querySelectorAll('.result')].map((r) => {
          const a = r.querySelector('a.result__a');
          const s = r.querySelector('.result__snippet');
          return a ? { title: a.innerText, href: a.href, snippet: s ? s.innerText : '' } : null;
        }).filter(Boolean))""",
    ) or []
    return parse_duck_results(raw, limit)


def search_ahmia(client, ctx_id, query, limit, timeout_s):
    client.call("browsingContext.navigate", {"context": ctx_id, "url": f"{AHMIA_BASE}/", "wait": "complete"}, timeout=timeout_s)
    hidden = eval_json(
        client,
        ctx_id,
        "JSON.stringify([...document.querySelectorAll('#searchForm input[type=hidden]')].map((i) => [i.name, i.value]))",
    ) or []
    extra = "".join(f"&{urllib.parse.quote(str(k))}={urllib.parse.quote(str(v))}" for k, v in hidden)
    search_url = f"{AHMIA_BASE}/search/?q={urllib.parse.quote(query)}{extra}"
    client.call("browsingContext.navigate", {"context": ctx_id, "url": search_url, "wait": "complete"}, timeout=timeout_s)
    raw = eval_json(
        client,
        ctx_id,
        """JSON.stringify([...document.querySelectorAll('li.result')].map((li) => {
          const a = li.querySelector('h4 a');
          return a ? {
            title: a.innerText,
            href: a.getAttribute('href'),
            snippet: (li.querySelector('p') || {}).innerText || '',
            cite: (li.querySelector('cite') || {}).innerText || ''
          } : null;
        }).filter(Boolean))""",
    ) or []
    return parse_ahmia_results(raw, limit)


def run_browser_job(job):
    node = "dark" if job.get("node") == "dark" else "tor"
    mode = str(job.get("mode") or "read").strip().lower()
    if mode not in ("search", "read"):
        return {
            "v": 1,
            "ok": False,
            "isTor": False,
            "node": node,
            "fetched_at": int(time.time() * 1000),
            "results": [],
            "pages": [],
            "error": f"unsupported_mode: {mode}",
        }

    timeout_s = max(10.0, min(120.0, float(job.get("timeoutSec") or 45.0)))
    verify_tor = job.get("verifyTor", True) is not False
    gw_spec = str(job.get("socksHost") or os.environ.get("CAPRI_TOR_GW_HOST") or DEFAULT_GW_IP).strip()
    try:
        socks_ip = socket.gethostbyname(gw_spec)
    except Exception:
        socks_ip = gw_spec

    probe = tcp_probe(socks_ip, 9050, timeout=3.0)
    if not probe.get("reachable"):
        return {
            "v": 1,
            "ok": False,
            "isTor": False,
            "node": node,
            "fetched_at": int(time.time() * 1000),
            "results": [],
            "pages": [],
            "error": f"torgw_unreachable: {probe.get('error')}",
        }

    shutil.rmtree(PROFILE_DIR, ignore_errors=True)
    os.makedirs("/tmp/home", exist_ok=True)
    write_tor_profile(PROFILE_DIR, socks_host=socks_ip)

    stderr_log = "/tmp/camoufox-stderr.log"
    env = os.environ.copy()
    env["HOME"] = "/tmp/home"
    env["MOZ_HEADLESS"] = "1"

    stderr_fh = open(stderr_log, "w+", encoding="utf-8", errors="replace")
    proc = subprocess.Popen(
        [CAMOUFOX_BIN, "--headless", "--profile", PROFILE_DIR, "--remote-debugging-port", str(BIDI_PORT)],
        stdout=subprocess.DEVNULL,
        stderr=stderr_fh,
        env=env,
    )
    client = None
    try:
        ready = False
        deadline = time.monotonic() + 20.0
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"camoufox_exited_early: rc={proc.returncode}")
            try:
                client = BiDiClient("127.0.0.1", BIDI_PORT, "/session", timeout=5.0)
                ready = True
                break
            except Exception:
                time.sleep(0.15)
        if not ready:
            raise TimeoutError("bidi_listen_timeout")

        client.call("session.new", {"capabilities": {}}, timeout=15.0)
        tree = client.call("browsingContext.getTree", {}, timeout=10.0)
        contexts = tree.get("contexts") or []
        ctx_id = contexts[0]["context"] if contexts else client.call("browsingContext.create", {"type": "tab"}, timeout=10.0)["context"]

        is_tor = False
        if verify_tor:
            client.call("browsingContext.navigate", {"context": ctx_id, "url": TOR_CHECK_URL, "wait": "complete"}, timeout=timeout_s)
            tor_page = eval_json(client, ctx_id, "JSON.stringify({text: document.body ? document.body.innerText : ''})") or {}
            tor_json = json.loads(tor_page.get("text", "{}"))
            is_tor = bool(tor_json.get("IsTor"))
            if not is_tor:
                raise RuntimeError(f"not_tor: {tor_page.get('text', '')[:120]}")

        results = []
        pages = []
        if mode == "search":
            query = str(job.get("query") or "").strip()[:300]
            if not query:
                raise ValueError("empty_query")
            limit = max(1, min(MAX_RESULTS, int(job.get("limit") or 8)))
            read_n = max(0, min(MAX_PAGES, int(job.get("read") if job.get("read") is not None else 3)))
            results = search_ahmia(client, ctx_id, query, limit, timeout_s) if node == "dark" else search_ddg(client, ctx_id, query, limit, timeout_s)
            for item in results[:read_n]:
                pages.append(read_page(client, ctx_id, item["url"], timeout_s))
        else:
            raw_urls = job.get("urls") if isinstance(job.get("urls"), list) else ([job.get("url")] if job.get("url") else [])
            clean_urls = [str(u).strip() for u in raw_urls if str(u or "").strip()][:MAX_PAGES]
            if not clean_urls:
                raise ValueError("empty_url")
            for u in clean_urls:
                pages.append(read_page(client, ctx_id, u, timeout_s))

        return {
            "v": 1,
            "ok": True,
            "isTor": bool(is_tor) if verify_tor else False,
            "node": node,
            "fetched_at": int(time.time() * 1000),
            "results": results[:MAX_RESULTS],
            "pages": pages[:MAX_PAGES],
        }
    except Exception as e:
        return {
            "v": 1,
            "ok": False,
            "isTor": False,
            "node": node,
            "fetched_at": int(time.time() * 1000),
            "results": [],
            "pages": [],
            "error": f"{type(e).__name__}: {e}",
        }
    finally:
        if client is not None:
            client.close()
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:
                proc.kill()
                proc.wait(timeout=2)
        stderr_fh.close()
        shutil.rmtree(PROFILE_DIR, ignore_errors=True)
        try:
            os.remove(stderr_log)
        except Exception:
            pass


def main():
    raw = sys.stdin.read().lstrip("\ufeff").strip()
    job = json.loads(raw) if raw else {}
    if job.get("mode") == "net_probes":
        res = run_net_probes(job.get("gateway"))
    else:
        res = run_browser_job(job)
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
