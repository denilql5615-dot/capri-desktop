'use strict';

// Her voice, both ways, through local servers that speak the OpenAI audio protocol:
// what you say, written down by Whisper (D:\Capri\services\whisper-server, started here if it's
// installed and not up yet), and what she answers, said by VoiceStudio. Recordings are sent to
// those servers only and never kept.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WHISPER_DIR = process.env.CAPRI_WHISPER_DIR || 'D:\\Capri\\services\\whisper-server';
const STT_TIMEOUT_MS = 60000;
const TTS_TIMEOUT_MS = 30000;
const WHISPER_BOOT_MS = 60000; // large-v3-turbo onto the graphics card
const MAX_SPOKEN = 1200; // a long answer is read in the panel; she says the start of it

const base = (url) => String(url || '').replace(/\/+$/, '');
const isLocal = (url) => {
  try {
    return /^(127\.0\.0\.1|localhost)$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

async function post(url, init, ms) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`${res.status} ${body}`.trim());
  }
  return res;
}

/** What you said, as text (16 kHz mono WAV in). */
async function transcribe(wav, voice) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', voice.sttModel);
  if (voice.sttLang) form.append('language', voice.sttLang);
  if (voice.sttPrompt) form.append('prompt', voice.sttPrompt);
  const res = await post(`${base(voice.sttUrl)}/audio/transcriptions`, { method: 'POST', body: form }, STT_TIMEOUT_MS);
  const json = await res.json();
  return String(json.text || '').trim();
}

/** Her line, as mp3 bytes. Markdown and emoji are dropped: they'd be read out. */
async function speak(text, voice) {
  const input = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>~|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SPOKEN);
  if (!input) return null;
  const res = await post(`${base(voice.ttsUrl)}/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: voice.ttsModel, voice: voice.ttsVoice, input, response_format: 'mp3' }),
  }, TTS_TIMEOUT_MS);
  return new Uint8Array(await res.arrayBuffer());
}

/** A failed transcription in words you can act on ("fetch failed" says nothing). */
function sttError(err, voice) {
  const msg = err?.message || String(err);
  if (/fetch failed|ECONNREFUSED|timed out|aborted/i.test(msg)) {
    return isLocal(voice.sttUrl)
      ? 'Whisper не отвечает. Запусти start.bat в папке whisper-server или напиши текстом.'
      : 'Сервер распознавания речи недоступен. Проверь сеть или напиши текстом.';
  }
  return `Распознавание речи не сработало: ${msg}`;
}

// The local Whisper server, started by her so voice works without a separate window. Only for the
// default local address, and only what she started is stopped: a server you started stays up.
let whisper = null;

async function up(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

// At her start, and before each transcription: a server that went away since (another app that had
// started it quit) comes back. With `wait`, until it answers (the model takes a while to load).
async function ensureWhisper(voice, { wait = false, dir = WHISPER_DIR } = {}) {
  if (!voice.stt) return;
  let u;
  try {
    u = new URL(voice.sttUrl);
  } catch {
    return;
  }
  if (!isLocal(voice.sttUrl) || u.port !== '8765') return; // server.py's fixed address
  const health = `${u.protocol}//${u.host}/health`;
  if (await up(health)) return;
  if (!whisper) startWhisper(dir);
  for (let t = Date.now(); wait && whisper && Date.now() - t < WHISPER_BOOT_MS;) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await up(health)) return;
  }
}

function startWhisper(dir) {
  const python = path.join(dir, '.venv', 'Scripts', 'python.exe');
  const script = path.join(dir, 'server.py');
  if (!fs.existsSync(python) || !fs.existsSync(script)) return; // setup.bat never ran
  const child = spawn(python, [script], { cwd: dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let tail = '';
  child.stderr.on('data', (d) => { tail = (tail + d).slice(-600); });
  child.on('exit', (code) => {
    if (whisper === child) whisper = null;
    if (code) console.warn('[capri] local Whisper exited', code, tail.replace(/\s+/g, ' ').slice(-300));
  });
  child.on('error', (err) => {
    console.warn('[capri] local Whisper failed to start:', err.message);
    if (whisper === child) whisper = null;
  });
  whisper = child;
}

function stopWhisper() {
  const child = whisper;
  whisper = null;
  if (child && !child.killed) child.kill();
}

module.exports = { transcribe, speak, sttError, ensureWhisper, stopWhisper };
