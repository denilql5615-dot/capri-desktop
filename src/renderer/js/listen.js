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

// Her name at the start of what you said ("Капри, открой ютуб", "эй капри"): null if it isn't there, else
// { rest } (what you asked, '' for her name alone). Also as speech-to-text spells it.
const NAME_RE = /^\s*(?:(?:эй|хей|слушай|послушай|алло|привет|ну|окей|ок|hey|hi|hello|ok)[,\s]+){0,2}(?:капри|капре|кэпри|капрэй|каприй|каприя|капря|каприша|каприз|кабри|кэбри|гапри|капр|capri|kapri|capry|cabri)(?![а-яёa-z])[\s,.!?:—-]*/i;
export function parseWake(text) {
  const m = NAME_RE.exec(String(text || ''));
  return m ? { rest: text.slice(m[0].length).trim() } : null;
}

// Your answer to her question, said: 'hour', 'yes', 'no' or null (something else)
export function parseAnswer(text) {
  const t = String(text || '').toLowerCase().replace(/[.,!?…]/g, ' ').trim();
  if (/(на ?ч[аеё]с|часик)(?![а-яё])/.test(t)) return 'hour'; // "давай на час", heard as "девайна чес" too
  if (/^(нет|не надо|не нужно|не|стоп|отмена|отмени|no|stop)(?![а-яёa-z])/.test(t)) return 'no';
  if (/^(да|давай|можно|ага|угу|конечно|разрешаю|делай|ок|окей|yes|ok)(?![а-яёa-z])/.test(t)) return 'yes';
  return null;
}

// A wake-word command that must work even while her current task has the chat locked.
export function parseControl(text) {
  const t = String(text || '').toLowerCase().replace(/[.,!?…]/g, ' ').trim();
  return /^(стоп|стой|остановись|останови|отмени|хватит|прекрати|заверши|вырубай|stop|cancel)(?:\s+(?:задачу|работу|выполнение|это))?$/.test(t) ? 'stop' : null;
}

export function parseModelCommand(text) {
  const t = String(text || '').trim();
  const ru = /^(?:переключись|переключи|смени|поставь|выбери|используй|включи|перейди|давай)(?:\s+модель)?(?:\s+на)?(?:\s+модель)?\s+(.+)$/i.exec(t);
  const en = /^(?:switch|change|use)(?:\s+model)?(?:\s+to)?\s+(.+)$/i.exec(t);
  return (ru?.[1] || en?.[1] || '').replace(/[.!?…]+$/, '').replace(/\s+(?:модель|model)$/i, '').trim() || null;
}

// Speech in a stream that's always on: a segment from the first loud bit (and a little before it) until a
// pause, handed over as WAV. For her name, so: short.
const WAKE = { preMs: 640, silenceMs: 700, minMs: 350, maxMs: 8000 };
export class Segmenter {
  constructor(onSegment) {
    this.onSegment = onSegment;
    this.floor = 0.01;
    this.pre = [];      // the last moments before speech, so its first syllable isn't cut
    this.cur = null;    // { chunks, ms, silent } while you speak
  }

  push(chunk, ms) {
    const level = rms(chunk);
    const loud = level > Math.max(0.02, this.floor * 3);
    if (!this.cur) {
      if (!loud) {
        this.floor = this.floor * 0.95 + level * 0.05;
        this.pre.push(chunk);
        while (this.pre.length * ms > WAKE.preMs) this.pre.shift();
        return;
      }
      this.cur = { chunks: [...this.pre, chunk], ms: ms * (this.pre.length + 1), speech: ms, silent: 0 };
      this.pre = [];
      return;
    }
    const c = this.cur;
    c.chunks.push(chunk);
    c.ms += ms;
    if (loud) {
      c.speech += ms;
      c.silent = 0;
    } else {
      c.silent += ms;
    }
    if (c.silent >= WAKE.silenceMs || c.ms >= WAKE.maxMs) {
      this.cur = null;
      if (c.speech >= WAKE.minMs) this.onSegment(c.chunks);
    }
  }
}

const join = (chunks) => {
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
};

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
    this.quietUntil = 0; // her own voice, and a moment after it: not you
    this.voice = { stt: true, tts: true, wake: false };
    this.wake = null;  // { stream, ctx, node } while she listens for her name
    this.hearing = false; // a segment of it is with Whisper
  }

  get active() { return Boolean(this.stream); }

  configure(cfg) {
    if (cfg?.voice) this.voice = cfg.voice;
    if (this.voice.wake && this.voice.stt) this.startWake();
    else this.stopWake();
  }

  // ---- her name, heard ("Капри, …"), and your answers to her questions, said
  async startWake() {
    if (this.wake) return;
    this.wake = {}; // taken: a second call while the mic opens does nothing
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      const ctx = new AudioContext({ sampleRate: RATE });
      const node = ctx.createScriptProcessor(2048, 1, 1);
      const seg = new Segmenter((chunks) => this.heard(encodeWav(resample(join(chunks), ctx.sampleRate, RATE), RATE)));
      node.onaudioprocess = (e) => {
        // not while you talk to her with Ctrl+Alt+V, nor while she's talking
        if (this.active || performance.now() < this.quietUntil || this.audio) return;
        const d = new Float32Array(e.inputBuffer.getChannelData(0));
        seg.push(d, (d.length / ctx.sampleRate) * 1000);
      };
      ctx.createMediaStreamSource(stream).connect(node);
      node.connect(ctx.destination);
      if (!this.wake) { // turned off meanwhile
        stream.getTracks().forEach((t) => t.stop());
        ctx.close();
        return;
      }
      this.wake = { stream, ctx, node };
      this.host.wakeTrace?.('ready');
    } catch {
      this.wake = null;
      this.host.wakeTrace?.('mic-error');
    }
  }

  stopWake() {
    const w = this.wake;
    this.wake = null;
    w?.node?.disconnect();
    w?.stream?.getTracks().forEach((t) => t.stop());
    w?.ctx?.close().catch(() => {});
  }

  async heard(wav) {
    this.host.wakeTrace?.('segment');
    if (this.hearing) {
      this.host.wakeTrace?.('stt-busy');
      return;
    }
    this.hearing = true;
    try {
      const pending = Boolean(this.chat.pending);
      const res = await this.host.transcribe(wav, { wake: true });
      if (!res.ok || !res.text) {
        this.host.wakeTrace?.(res.ok ? 'stt-empty' : 'stt-error');
        return;
      }
      this.host.wakeTrace?.('stt-ok');
      const wake = parseWake(res.text);
      if (wake && parseControl(wake.rest) === 'stop') {
        this.host.wakeTrace?.('stop');
        this.hush();
        this.chat.stopTurn();
        return;
      }
      // her question waiting: your answer needs no name ("да", "на час", "нет")
      if (this.chat.pending) {
        const answer = parseAnswer(wake?.rest ?? res.text);
        if (answer) this.chat.answerPending(answer);
        return;
      }
      if (pending) return;
      if (!wake || this.chat.turn) {
        this.host.wakeTrace?.(wake ? 'chat-busy' : 'no-name');
        return;
      }
      if (!wake.rest) return this.toggle(); // her name alone: she listens
      const wantedModel = parseModelCommand(wake.rest);
      if (wantedModel) {
        const changed = await this.host.switchModel(wantedModel);
        if (!this.chat.open) await this.chat.start();
        const line = changed.ok
          ? `Переключила модель на ${changed.model}.`
          : changed.error || `Не нашла установленную модель «${wantedModel}».`;
        if (this.chat.open) this.chat.interject(line, [], null);
        this.say(line);
        return;
      }
      if (!this.chat.open) await this.chat.start();
      if (this.chat.open && !this.chat.turn) {
        this.host.wakeTrace?.('accepted');
        this.chat.send(wake.rest);
      }
    } finally {
      this.hearing = false;
    }
  }

  // Ctrl+Alt+V: on, or off if you're already talking
  async toggle() {
    if (this.active) return this.finish();
    if (!this.voice.stt) return;
    this.hush();
    if (!this.chat.open) await this.chat.start();
    // her setup came up instead, or she's still answering (unless she's asking you something: say it)
    if (!this.chat.open || (this.chat.turn && !this.chat.pending)) return;
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
    if (this.chat.pending) {
      const answer = parseAnswer(res.text);
      return answer ? this.chat.answerPending(answer) : this.hint('Скажи «да», «на час» или «нет».');
    }
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
    const done = () => {
      URL.revokeObjectURL(url);
      if (this.audio === audio) this.audio = null;
      this.quietUntil = performance.now() + 500; // the room still rings with her for a moment
    };
    audio.onended = audio.onerror = done;
    this.audio = audio;
    audio.play().catch(done);
  }

  hush(cancel = true) {
    if (cancel) this.said++;
    this.audio?.pause();
    if (this.audio) this.quietUntil = performance.now() + 500;
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
