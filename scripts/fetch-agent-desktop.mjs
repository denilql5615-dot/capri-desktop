// Fetches the pinned agent-desktop CLI (vercel-labs/agent-desktop, Apache-2.0) into vendor/agent-desktop.
// The installer ships it as a resource; Capri's `desktop` tool runs it. The archive is checked against a
// pinned SHA-256 before anything is extracted. Re-running is a no-op when the right version is in place.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '1.0.2';
const ASSET = `agent-desktop-v${VERSION}-x86_64-pc-windows-msvc.tar.gz`;
const SHA256 = '2186c76e7df197c0e67365e45d36d869f74714c56bb8a73817e2a66f3e18e222';
const URL = `https://github.com/vercel-labs/agent-desktop/releases/download/v${VERSION}/${ASSET}`;

const out = path.resolve(import.meta.dirname, '..', 'vendor', 'agent-desktop');
const stamp = path.join(out, 'VERSION');
if (fs.existsSync(path.join(out, 'agent-desktop.exe')) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === VERSION) {
  console.log(`[agent-desktop] v${VERSION} already in ${out}`);
  process.exit(0);
}

const res = await fetch(URL);
if (!res.ok) throw new Error(`[agent-desktop] download failed: HTTP ${res.status} ${URL}`);
const buf = Buffer.from(await res.arrayBuffer());
const hash = crypto.createHash('sha256').update(buf).digest('hex');
if (hash !== SHA256) throw new Error(`[agent-desktop] checksum mismatch for ${ASSET}: ${hash}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-'));
try {
  const archive = path.join(tmp, ASSET);
  fs.writeFileSync(archive, buf);
  // Windows' own bsdtar: a GNU tar from Git Bash would read "C:\..." as a remote host
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xzf', archive, '-C', tmp]);
  const exe = path.join(tmp, 'agent-desktop.exe');
  if (!fs.existsSync(exe)) throw new Error('[agent-desktop] agent-desktop.exe not found in the archive');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(exe, path.join(out, 'agent-desktop.exe'));
  fs.writeFileSync(path.join(out, 'NOTICE.txt'),
    `agent-desktop v${VERSION} — https://github.com/vercel-labs/agent-desktop\nLicensed under the Apache License, Version 2.0 (see the project's LICENSE file).\nhttps://www.apache.org/licenses/LICENSE-2.0\n`);
  fs.writeFileSync(stamp, VERSION);
  console.log(`[agent-desktop] v${VERSION} → ${out}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
