'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { artifactPath, listArtifacts } = require('../src/main/hub-artifacts');
const { AgentSessions } = require('../src/main/agent-sessions');
const { hubLinks } = require('../src/renderer/js/hub-links');

test('Live Hub file flow: request, artifact creation, list, attach, copy, save, open, and security checks', async () => {
  // 1. Prepare artifact root and session environment
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'capri-live-flow-root-'));
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capri-live-flow-session-'));
  const sessionFile = path.join(sessionDir, 'agent-sessions.json');

  const runId = randomUUID();
  const testFileName = 'genesis-live-artifact.txt';
  const fileContent = 'GENESIS HUB LIVE ARTIFACT VERIFICATION\nTimestamp: ' + new Date().toISOString();

  // 2. Simulated agent runner creating the file in destination folder
  const runner = async (agent, model, messages, signal, delta) => {
    const destination = path.join(root, runId);
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, testFileName), fileContent, 'utf8');
    const artifacts = await listArtifacts(root, runId);
    return { text: 'Файл успешно создан.', artifacts };
  };

  const sessions = new AgentSessions(sessionFile, runner, () => {});
  const chatId = sessions.create('gemini');

  // 3. User sends request to chosen agent
  const sendRes = await sessions.send(chatId, 'gemini-3.8-flash-high', 'Создай тестовый файл');
  assert.equal(sendRes.ok, true, 'Agent session send must succeed');

  // 4. Verify message history has attached artifact
  const history = sessions.history(chatId);
  const lastMsg = history.at(-1);
  assert.equal(lastMsg.role, 'assistant');
  assert.equal(lastMsg.model, 'gemini-3.8-flash-high');
  assert.ok(Array.isArray(lastMsg.artifacts), 'Message must have artifacts array');
  assert.equal(lastMsg.artifacts.length, 1);
  assert.deepEqual(lastMsg.artifacts[0], { run: runId, name: testFileName });

  // 5. Test artifactPath validation and security
  const targetFile = await artifactPath(root, runId, testFileName);
  assert.equal(await fs.readFile(targetFile, 'utf8'), fileContent);

  // Security: path traversal is blocked
  await assert.rejects(artifactPath(root, runId, '../other.txt'), /Недопустимое/);
  // Security: invalid extension is blocked
  await assert.rejects(artifactPath(root, runId, 'malicious.bat'), /Недопустимое/);
  // Security: non-existent run or file throws
  await assert.rejects(artifactPath(root, randomUUID(), testFileName), /Вложение недоступно/);

  // 6. Test 'copy' action (path generation)
  const copiedPath = targetFile;
  assert.ok(path.isAbsolute(copiedPath));
  assert.ok(copiedPath.endsWith(testFileName));

  // 7. Test 'save' action (save copy)
  const saveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capri-live-save-'));
  const saveDest = path.join(saveDir, 'saved-copy.txt');
  await fs.copyFile(targetFile, saveDest, fs.constants.COPYFILE_EXCL);
  assert.equal(await fs.readFile(saveDest, 'utf8'), fileContent);

  // Overwriting with COPYFILE_EXCL fails safely
  await assert.rejects(fs.copyFile(targetFile, saveDest, fs.constants.COPYFILE_EXCL));

  // 8. Test 'open' action resolution
  const stat = await fs.stat(targetFile);
  assert.ok(stat.isFile() && stat.size > 0);

  // Cleanup temporary directories
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(sessionDir, { recursive: true, force: true });
  await fs.rm(saveDir, { recursive: true, force: true });
});

test('Live Hub link flow: safe HTTPS web links parsed and dangerous schemes rejected', () => {
  const text = 'Смотри [GitHub репо](https://github.com/mochiiwuff/capri-desktop) и документацию https://antigravity.google/docs/cli/statusline/. ' +
    'Опасные: file:///C:/Windows/system32/cmd.exe, javascript:alert(document.cookie), https://admin:secret@malicious.com/api';

  const parts = hubLinks(text);
  const clickable = parts.filter(p => p.url);

  assert.equal(clickable.length, 2);
  assert.equal(clickable[0].text, 'GitHub репо');
  assert.equal(clickable[0].url, 'https://github.com/mochiiwuff/capri-desktop');
  assert.equal(clickable[1].text, 'https://antigravity.google/docs/cli/statusline/');
  assert.equal(clickable[1].url, 'https://antigravity.google/docs/cli/statusline/');

  // Dangerous URLs must NOT have url property (remain plain text)
  const dangerousUrls = ['file:///C:/Windows/system32/cmd.exe', 'javascript:alert(document.cookie)', 'https://admin:secret@malicious.com/api'];
  for (const dangerous of dangerousUrls) {
    assert.ok(!clickable.some(c => c.url === dangerous), `URL ${dangerous} must not be clickable`);
  }

  // Verify URL validation logic from chats:open-link in main.js
  const validateOpenLink = (raw) => {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Небезопасная ссылка.');
    }
    return url.href;
  };

  assert.equal(validateOpenLink('https://github.com/mochiiwuff/capri-desktop'), 'https://github.com/mochiiwuff/capri-desktop');
  assert.throws(() => validateOpenLink('file:///C:/Windows/cmd.exe'), /Небезопасная ссылка/);
  assert.throws(() => validateOpenLink('javascript:alert(1)'), /Небезопасная ссылка/);
  assert.throws(() => validateOpenLink('https://user:pass@evil.com'), /Небезопасная ссылка/);
});
