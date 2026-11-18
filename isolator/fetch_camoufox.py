#!/usr/bin/env python3
"""Download and SHA-256 verify the latest official Linux release of daijro/camoufox."""

import hashlib
import json
import os
import subprocess
import urllib.request

RELEASE_API = "https://api.github.com/repos/daijro/camoufox/releases/latest"
OUT_DIR = "/opt/camoufox"
ZIP_PATH = "/tmp/camoufox.zip"


def http_get(url, dest=None):
    req = urllib.request.Request(url, headers={"User-Agent": "capri-tor-isolator-builder"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        if dest is None:
            return resp.read()
        with open(dest, "wb") as f:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
    return None


def main():
    release = json.loads(http_get(RELEASE_API).decode("utf-8"))
    tag = release.get("tag_name")
    assets = release.get("assets") or []
    asset = next((a for a in assets if str(a.get("name", "")).endswith("lin.x86_64.zip")), None)
    if not asset:
        names = [a.get("name") for a in assets]
        raise RuntimeError(f"No lin.x86_64.zip asset in release {tag}: {names}")

    name = asset["name"]
    url = asset["browser_download_url"]
    expected_digest = asset.get("digest") or ""
    if expected_digest.startswith("sha256:"):
        expected_sha256 = expected_digest.split(":", 1)[1].strip().lower()
    else:
        expected_sha256 = ""

    print(f"[fetch_camoufox] release={tag} asset={name} size={asset.get('size')} digest={expected_digest or 'none'}")
    http_get(url, ZIP_PATH)

    h = hashlib.sha256()
    total = 0
    with open(ZIP_PATH, "rb") as f:
        while True:
            buf = f.read(1024 * 1024)
            if not buf:
                break
            h.update(buf)
            total += len(buf)
    actual_sha256 = h.hexdigest().lower()
    print(f"[fetch_camoufox] downloaded={total} bytes sha256={actual_sha256}")

    if expected_sha256:
        if actual_sha256 != expected_sha256:
            raise RuntimeError(f"SHA-256 mismatch: expected {expected_sha256}, got {actual_sha256}")
        sha_verified = True
    else:
        sha_verified = False
        print("[fetch_camoufox] WARNING: no sha256 digest field published on GitHub release asset")

    os.makedirs(OUT_DIR, exist_ok=True)
    subprocess.run(["unzip", "-q", ZIP_PATH, "-d", OUT_DIR], check=True)
    os.remove(ZIP_PATH)

    info = {
        "tag_name": tag,
        "asset_name": name,
        "size": total,
        "sha256_actual": actual_sha256,
        "sha256_published": expected_sha256 or None,
        "sha256_verified": sha_verified,
    }
    with open(os.path.join(OUT_DIR, "RELEASE_INFO.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, indent=2)
    print(f"[fetch_camoufox] extracted to {OUT_DIR}: {json.dumps(info)}")


if __name__ == "__main__":
    main()
