'use strict';

// Her two local brains, one model family (Gemma 4 Heretic-std, chosen by the 2026-11-16 benchmark):
// - fast (E4B, ~6 GB): always in memory. Routes messages, answers small talk, looks at the screen,
//   takes notes. Weak at math: real work goes to the cloud workers or to the main one.
// - main (26B, ~17 GB): loaded only when asked for ("основная модель", "локально"), for roleplay, or
//   when the cloud chain (Claude → Codex → Antigravity) gave no answer. The fast one is unloaded first
//   (8 GB of VRAM: never two big models at once); after 5 idle minutes the main one goes and the fast
//   one comes back.
// Roleplay is not a model: it's a prompt added to her chat (RP_PROMPT), never to workers, the router,
// notes, tasks on the PC or anything that sounds like an emergency.

const FAST = 'hf.co/llmfan46/gemma-4-E4B-it-uncensored-heretic-GGUF:Q4_K_M';
const MAIN = 'hf.co/llmfan46/gemma-4-26B-A4B-it-qat-q4_0-uncensored-heretic-GGUF:Q4_0';
const MAIN_IDLE_MS = 5 * 60 * 1000;
// stored by older builds as her one chat model: read as "auto" (the roles) from now on
const LEGACY = ['gemma4:26b-a4b-it-qat', 'qwen3:8b', 'qwen3.5:4b', 'hf.co/limloop/MN-12B-Faun-RP-RU-GGUF:Q3_K_M'];

const L = '(?<![а-яёa-z])';
// "основной моделью", "подумай как следует", "включи большую": the main one, for this and the next 5 minutes
const MAIN_RE = new RegExp(`${L}(основн[а-яёa-z]* модел|больш[а-яёa-z]* модел|основн[а-яёa-z]* мозг|подумай (как следует|хорошенько|получше|глубже|серь[её]зно)|включи (основную|большую))`, 'i');
// "сделай локально", "без облака": not for the cloud workers, the main one does it here
const LOCAL_RE = new RegExp(`${L}(локально|локальн[а-яёa-z]* модел[а-яёa-z]*|без облака|без интернета|офлайн|оффлайн|offline)`, 'i');
// "быстрая модель", "отпусти основную": the main one out now, the fast one back
const FAST_RE = new RegExp(`${L}(быстр[а-яёa-z]* модел|л[её]гк[а-яёa-z]* модел|отпусти основную|выгрузи основную)`, 'i');
// anything like an emergency: the roleplay prompt stays out, whatever the mode
const EMERGENCY_RE = new RegExp(`${L}(кровотеч|кровь (хлещет|не останавлив)|не дыш|задыха|без сознания|потерял[а-яёa-z]* сознан|ожог|перелом|инсульт|инфаркт|сердечн[а-яёa-z]* приступ|отравил|отравлен|судорог|утону|захлебну|анафилак|скор(ую|ая)|112|03\\b|суицид|покончить с собой)`, 'i');
// "включи ролевой режим" / "выключи ролевой", "ролевой режим вкл/выкл"
const RP_ON_RE = new RegExp(`${L}(включи|вруби|запусти|давай)\\s+(ролев[а-яёa-z]*|rp)(\\s+режим)?`, 'i');
const RP_OFF_RE = new RegExp(`${L}(выключи|отключи|выруби|хватит|стоп|закончи)\\s+(ролев[а-яёa-z]*|rp)(\\s+режим)?`, 'i');

const RP_PROMPT = [
  'Режим ролевой игры. Пишешь прозу для взрослого читателя, который сам выбрал этот жанр.',
  'Все персонажи совершеннолетние (18+), всё происходит по их взаимному согласию.',
  'Не затемняй кадр, не уходи в эвфемизмы и не обрывай сцену: описывай прямо и подробно, в стиле, который задаёт пользователь.',
  'Держи характер, сеттинг и тон сцены. Выходи из роли, только если пользователь просит или речь о реальной беде.',
].join(' ');

const wantsMain = (text) => MAIN_RE.test(String(text || ''));
const wantsLocal = (text) => LOCAL_RE.test(String(text || ''));
const wantsFast = (text) => FAST_RE.test(String(text || ''));
const isEmergency = (text) => EMERGENCY_RE.test(String(text || ''));

/** true / false when you turn roleplay on / off, null when the words aren't about it. */
function rpCommand(text) {
  const t = String(text || '').slice(0, 120);
  if (RP_OFF_RE.test(t)) return false;
  if (RP_ON_RE.test(t)) return true;
  return null;
}

/** Her chat messages with the roleplay prompt in the system one (a system one added if none). */
function withRp(messages) {
  const list = Array.isArray(messages) ? [...messages] : [];
  const at = list.findIndex((m) => m.role === 'system');
  if (at < 0) return [{ role: 'system', content: RP_PROMPT }, ...list];
  list[at] = { ...list[at], content: `${list[at].content}\n\n${RP_PROMPT}` };
  return list;
}

class Brains {
  /**
   * ollama: { unload(model), warm(model, keepAlive) }; fast / main: the model names (configurable).
   */
  constructor({ ollama, fast = FAST, main = MAIN, idleMs = MAIN_IDLE_MS, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { ollama, fast, main, idleMs, now, setTimer, clearTimer });
    this.mainUntil = 0; // the main one is hers until then
    this.timer = null;
  }

  /** Both models installed: the roles are on. One missing: her old single-model ways. */
  ready(installed) {
    return Array.isArray(installed) && installed.includes(this.fast) && installed.includes(this.main);
  }

  isRole(model) {
    return model === this.fast || model === this.main;
  }

  /** Her chat model as the config says: 'auto' (and what older builds stored) means the roles. */
  isAuto(chatModel, installed = []) {
    return !chatModel || chatModel === 'auto' || this.isRole(chatModel) || LEGACY.includes(chatModel) || !installed.includes(chatModel);
  }

  mainActive() {
    return this.now() < this.mainUntil;
  }

  /** The model to ask now: the main one while it's hers, else the fast one (no swap for small things). */
  current() {
    return this.mainActive() ? this.main : this.fast;
  }

  /** 'main': the fast one out, the main one hers for the next idle window. 'fast': whatever is in now. */
  async use(role) {
    if (role !== 'main') {
      if (this.mainActive()) this.touch();
      return this.current();
    }
    if (!this.mainActive()) await Promise.resolve(this.ollama.unload(this.fast)).catch(() => {});
    this.touch();
    return this.main;
  }

  touch() {
    this.mainUntil = this.now() + this.idleMs;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.release(), this.idleMs);
    this.timer?.unref?.();
  }

  /** The main one out (idle, or "быстрая модель"), the fast one back in memory for good. */
  async release() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const was = this.mainUntil > 0;
    this.mainUntil = 0;
    if (was) await Promise.resolve(this.ollama.unload(this.main)).catch(() => {});
    this.ollama.warm(this.fast, -1);
  }

  /** Everything was unloaded behind her back (ComfyUI, "освободи память"): no main one any more. */
  forget() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.mainUntil = 0;
  }
}

module.exports = { Brains, FAST, MAIN, LEGACY, RP_PROMPT, wantsMain, wantsLocal, wantsFast, isEmergency, rpCommand, withRp };
