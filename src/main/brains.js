'use strict';

const { isAuxiliaryModel } = require('./phone-model');

// Her two local brains, one model family (Gemma 4 Heretic-std, chosen by the 2026-11-16 benchmark):
// - fast (E4B, ~6 GB): always in memory. Routes messages, answers small talk, looks at the screen,
//   takes notes. Weak at math: real work goes to the cloud workers or to the main one.
// - main (26B, ~17 GB): loaded only when asked for ("основная модель", "локально"), for roleplay, or
//   when the cloud chain (Claude → Codex → Antigravity) gave no answer. The fast one is unloaded first
//   (8 GB of VRAM: never two big models at once). Keep the selected model until a switch.
// Roleplay is not a model: it's a prompt added to her chat (RP_PROMPT), never to workers, the router,
// notes, tasks on the PC or anything that sounds like an emergency.

const FAST = 'capri-e4b-stage9-v2:latest';
const MAIN = 'hf.co/llmfan46/gemma-4-26B-A4B-it-qat-q4_0-uncensored-heretic-GGUF:Q4_0';
const VISION = 'hf.co/llmfan46/gemma-4-E4B-it-uncensored-heretic-GGUF:Q4_K_M';
const VISION_BUSY = 'Локальная модель занята. Повтори запрос после её ответа.';
const ANALYSIS_PREDICT = 2048;
const ANALYSIS_CHARS = 4000;
// stored by older builds as her one chat model: read as "auto" (the roles) from now on
const LEGACY = ['gemma4:26b-a4b-it-qat', 'qwen3:8b', 'qwen3.5:4b', 'hf.co/limloop/MN-12B-Faun-RP-RU-GGUF:Q3_K_M'];

const L = '(?<![а-яёa-z])';
// "основной моделью", "подумай как следует", "включи большую": the main one, for this and the next 5 minutes
const MAIN_RE = new RegExp(`${L}(основн[а-яёa-z]* модел|больш[а-яёa-z]* модел|основн[а-яёa-z]* мозг|подумай (как следует|хорошенько|получше|глубже|серь[её]зно)|включи (основную|большую))`, 'i');
// "сделай локально", "без облака": not for the cloud workers, the main one does it here
const LOCAL_RE = new RegExp(`${L}(локально|локальн[а-яёa-z]* модел[а-яёa-z]*|без облака|без интернета|офлайн|оффлайн|offline)`, 'i');
// "быстрая модель", "отпусти основную": the main one out now, the fast one back
const FAST_RE = new RegExp(`${L}(быстр[а-яёa-z]* модел|л[её]гк[а-яёa-z]* модел|отпусти основную|выгрузи основную)`, 'i');
// "режим аналитика", "разбери документ", "длинная задача", "подробный разбор", "подробный отчёт"
const ANALYSIS_RE = new RegExp(
  `${L}(режим[а-яё]*\\s+аналитик[а-яё]*|разбер[а-яё]*\\s+(?:этот\\s+|эту\\s+|данный\\s+)?документ[а-яё]*|длинн[а-яё]*\\s+задач[а-яё]*|подробн[а-яё]*\\s+(?:разбор|отч[её]т)[а-яё]*)`,
  'i',
);
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
const wantsAnalysis = (text) => ANALYSIS_RE.test(String(text || ''));
const isEmergency = (text) => EMERGENCY_RE.test(String(text || ''));

/** Long-task ("аналитик") activation predicate for ordinary local Ollama auto-role turns. */
function analysisMode(cfg, { rolesReady = false, auto = false, tor = false, text = '' } = {}) {
  const said = typeof text === 'string' ? text : '';
  if (cfg?.provider !== 'ollama' || !rolesReady || !auto || cfg?.rp === true || tor || !said || wantsFast(said)) {
    return { active: false, numPredict: undefined };
  }
  const active = wantsAnalysis(said) || said.length > ANALYSIS_CHARS;
  return active ? { active: true, numPredict: ANALYSIS_PREDICT } : { active: false, numPredict: undefined };
}

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
  constructor({ ollama, fast = FAST, main = MAIN } = {}) {
    Object.assign(this, { ollama, fast, main });
    this.selected = fast;
    this.mainRuns = 0;
    this.visionRunning = false;
    this.transition = null;
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
    return this.mainRuns > 0 || this.selected === this.main;
  }

  get auxiliary() {
    return this.isRole(this.selected) ? null : this.selected;
  }

  /** The model to ask now: the main one while it's hers, else the fast one (no swap for small things). */
  current() {
    return this.selected;
  }

  async see(messages, signal, numPredict = 500) {
    if (this.visionRunning || this.transition || this.mainActive() || this.auxiliary) throw new Error(VISION_BUSY);
    this.visionRunning = true;
    try {
      const loaded = await this.ollama.loadedModels(signal);
      if (!loaded || loaded.some((model) => model !== this.fast)) throw new Error(VISION_BUSY);
      const restore = loaded.includes(this.fast);
      if (restore && !(await this.ollama.unload(this.fast))) throw new Error(VISION_BUSY);
      try {
        return await this.ollama.chat({ model: VISION, messages, numCtx: 2048, numPredict }, () => {}, signal);
      } finally {
        const released = await this.ollama.unload(VISION);
        if (restore && released) await this.ollama.warm(this.fast, -1);
      }
    } finally {
      this.visionRunning = false;
    }
  }

  async withModel(model, run, signal) {
    if (this.visionRunning || this.transition || this.mainRuns) throw new Error(VISION_BUSY);
    this.visionRunning = true;
    try {
      const loaded = await this.ollama.loadedModels(signal);
      if (!loaded || loaded.some((name) => !this.isRole(name) && !isAuxiliaryModel(name) && name !== this.selected && name !== model)) {
        throw new Error('В Ollama занята память другой моделью.');
      }
      for (const name of loaded.filter((name) => name !== model)) {
        if (!(await this.ollama.unload(name))) throw new Error('Не удалось освободить память Ollama.');
        if (this.selected === name) this.forget();
      }
      signal?.throwIfAborted();
      this.selected = model;
      return await run();
    } finally {
      this.visionRunning = false;
    }
  }

  /** 'main' selects 26B. 'fast' keeps the model already selected. */
  async use(role) {
    if (this.visionRunning) throw new Error(VISION_BUSY);
    if (this.transition) {
      await this.transition;
      return this.use(role);
    }
    if (role !== 'main') return this.current();
    if (!this.mainActive()) {
      this.transition = Promise.resolve().then(async () => {
        if (!(await this.ollama.unload(this.selected))) throw new Error('Текущая модель не выгрузилась. Переключение остановлено.');
        this.selected = this.main;
      });
      try {
        await this.transition;
      } finally {
        this.transition = null;
      }
      return this.main;
    }
    return this.main;
  }

  async runMain(run) {
    this.mainRuns++;
    try {
      return await run();
    } finally {
      this.mainRuns--;
    }
  }

  /** "быстрая модель": unload the selected heavy model and warm E4B. */
  async release() {
    if (this.visionRunning || this.mainRuns) return false;
    if (this.transition) {
      await this.transition;
      return this.release();
    }
    this.transition = Promise.resolve().then(async () => {
      if (this.selected !== this.fast && !(await this.ollama.unload(this.selected))) return false;
      this.forget();
      await this.ollama.warm(this.fast, -1);
      return true;
    });
    try {
      return await this.transition;
    } finally {
      this.transition = null;
    }
  }

  /** Everything was unloaded behind her back (ComfyUI, "освободи память"): no main one any more. */
  forget() {
    this.selected = this.fast;
  }
}

module.exports = { Brains, FAST, MAIN, VISION, VISION_BUSY, LEGACY, RP_PROMPT, ANALYSIS_PREDICT, ANALYSIS_CHARS, wantsMain, wantsLocal, wantsFast, wantsAnalysis, analysisMode, isEmergency, rpCommand, withRp };
