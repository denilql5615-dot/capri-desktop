// Talking to her out loud: Ctrl+Alt+V opens her chat and the microphone, what you say goes to
// Whisper (main.js > speech.js) and into her chat as if typed; her answers are said by VoiceStudio.
// The microphone is open only while you talk, and the recording is never kept.

const RATE = 16000;
const SILENCE_MS = 1300;  // quiet this long after speaking: you're done
const NO_SPEECH_MS = 6000; // nothing said at all: she stops listening
const MAX_MS = 30000;

// 16-bit PCM mono WAV, what Whisper's server reads
export function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

// linear resample: the mic's context may not honour the rate asked for
export function resample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio, i0 = Math.floor(x), f = x - i0;
    out[i] = input[i0] * (1 - f) + (input[Math.min(i0 + 1, input.length - 1)] ?? 0) * f;
  }
  return out;
}

const rms = (b) => { let s = 0; for (let i = 0; i < b.length; i++) s += b[i] * b[i]; return Math.sqrt(s / Math.max(1, b.length)); };

// when you're done talking: an adaptive noise floor, then a pause
export class Endpointer {
  constructor() { this.floor = 0.01; this.heard = false; this.silent = 0; this.elapsed = 0; }
  push(level, ms) {
    this.elapsed += ms;
    const speech = level > Math.max(0.02, this.floor * 3);
    if (speech) { this.heard = true; this.silent = 0; } else { this.floor = this.floor * 0.95 + level * 0.05; this.silent += ms; }
    if (this.elapsed >= MAX_MS) return true;
    return this.heard ? this.silent >= SILENCE_MS : this.elapsed >= NO_SPEECH_MS;
  }
}

export class Listen {
  constructor({ host, chat, panel }) {
    this.host = host;
    this.chat = chat;
    this.panel = panel;
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.chunks = [];
    this.audio = null; // what she's saying now
    this.said = 0;     // which of her answers is being said (a newer one cuts it off)
    this.voice = { stt: true, tts: true };
  }

  get active() { return Boolean(this.stream); }

  configure(cfg) { if (cfg?.voice) this.voice = cfg.voice; }

  // Ctrl+Alt+V: on, or off if you're already talking
  async toggle() {
    if (this.active) return this.finish();
    if (!this.voice.stt) return;
    this.hush();
    if (!this.chat.open) await this.chat.start();
    if (!this.chat.open || this.chat.turn) return; // her setup came up instead, or she's still answering
    try {
      await this.open();
    } catch {
      this.hint('Микрофон недоступен. Проверь, что он подключён и разрешён в Windows.');
      return;
    }
    this.hint('Слушаю… (Ctrl+Alt+V — закончить)');
  }

  async open() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    this.ctx = new AudioContext({ sampleRate: RATE });
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(2048, 1, 1);
    this.chunks = [];
    const ep = new Endpointer();
    this.node.onaudioprocess = (e) => {
      const d = new Float32Array(e.inputBuffer.getChannelData(0));
      this.chunks.push(d);
      if (ep.push(rms(d), (d.length / this.ctx.sampleRate) * 1000)) this.finish();
    };
    src.connect(this.node);
    this.node.connect(this.ctx.destination);
  }

  async close() {
    const rate = this.ctx?.sampleRate ?? RATE;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
    this.node = this.stream = this.ctx = null;
    const chunks = this.chunks;
    this.chunks = [];
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total < RATE / 4) return null; // under a quarter of a second: nothing said
    const all = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    return encodeWav(resample(all, rate, RATE), RATE);
  }

  async finish() {
    if (!this.active) return;
    const wav = await this.close();
    this.hint(null);
    if (!wav || !this.chat.open) return;
    this.hint('Расшифровываю…');
    const res = await this.host.transcribe(wav);
    this.hint(null);
    if (!res.ok) return this.hint(res.error);
    if (!res.text) return this.hint('Не расслышала. Ещё раз: Ctrl+Alt+V.');
    this.chat.send(res.text);
  }

  // her answer, out loud (only the latest: a new one, or you talking, cuts it off)
  async say(text) {
    if (!this.voice.tts) return;
    const turn = ++this.said;
    const mp3 = await this.host.speak(text);
    if (!mp3 || turn !== this.said) return;
    this.hush(false);
    const url = URL.createObjectURL(new Blob([mp3], { type: 'audio/mpeg' }));
    const audio = new Audio(url);
    audio.onended = audio.onerror = () => URL.revokeObjectURL(url);
    this.audio = audio;
    audio.play().catch(() => URL.revokeObjectURL(url));
  }

  hush(cancel = true) {
    if (cancel) this.said++;
    this.audio?.pause();
    this.audio = null;
  }

  // what the mic is doing, in her chat's input
  hint(text) {
    const input = this.panel.chatInput;
    if (!input) return;
    if (this.placeholder === undefined) this.placeholder = input.placeholder;
    input.placeholder = text ?? this.placeholder;
  }
}
