// Stage 2.7a: the Library — styles and writing voices, modelled on Gemini → Library → Styles.
// A modal of its own (not inside slash-menu.js): grid of styles, a style card with its sections
// (references, objects, instructions, colours, fonts, voice, tools) and a tab of writing voices.
// All user text goes in through textContent / value, never innerHTML.

const host = window.host;
const TYPE_LABELS = { brand: 'Бренд', persona: 'Личность', mascot: 'Маскот' };
const PRIVACY_LABELS = { cloudAllowed: 'Можно в облако', localOnly: 'Только локально' };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c) node.append(c);
  return node;
}

const initials = (name) => String(name || '?').trim().split(/[\s()_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

let root = null;
let state = { tab: 'styles', lib: null, styleId: null, voiceId: null, toast: '' };

function toast(text, isError = false) {
  const t = root?.querySelector('.sl-toast');
  if (!t) return;
  t.textContent = text;
  t.classList.toggle('sl-toast-error', isError);
  t.classList.add('sl-toast-show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('sl-toast-show'), 3800);
}

async function call(fn, payload, okText) {
  try {
    let res = await fn(payload);
    if (res?.confirmRequired) {
      if (!window.confirm(res.message || 'Подтвердить?')) return null;
      res = await fn({ ...payload, confirm: true });
    }
    if (res?.canceled) return null;
    if (!res?.ok) { toast(res?.error || 'Не получилось.', true); return null; }
    if (okText) toast(okText);
    return res;
  } catch (err) {
    toast(String(err?.message || err), true);
    return null;
  }
}

async function reload() {
  state.lib = await host.stylesLibrary();
  render();
}

// ---------------------------------------------------------------- styles grid

function renderGrid() {
  const lib = state.lib;
  const active = lib.active?.style;
  const grid = el('div', { class: 'sl-grid' },
    el('button', { class: 'sl-tile sl-tile-new', onclick: () => openWizard() },
      el('span', { class: 'sl-plus', text: '+' }),
      el('span', { class: 'sl-tile-new-text', text: 'Создайте стиль для бренда, личности или маскота' })),
    ...lib.styles.map((s) => el('button', { class: `sl-tile${active === s.id ? ' sl-tile-active' : ''}`, onclick: () => { state.styleId = s.id; render(); } },
      s.coverThumb ? el('img', { class: 'sl-tile-img', src: s.coverThumb, alt: '' }) : el('span', { class: 'sl-tile-initials', text: initials(s.name) }),
      el('span', { class: 'sl-tile-name', text: `@${s.id}` }),
      active === s.id ? el('span', { class: 'sl-tile-badge', text: 'активен' }) : null)),
  );
  return el('div', { class: 'sl-body' },
    el('div', { class: 'sl-section-head' }, el('h3', { text: 'Стили' }),
      el('span', { class: 'sl-hint', text: `Папка: ${lib.dir}` })),
    grid);
}

// ---------------------------------------------------------------- style card

function section(title, action, ...body) {
  return el('section', { class: 'sl-card' },
    el('div', { class: 'sl-card-head' }, el('h4', { text: title }), action || null),
    ...body);
}

function iconBtn(label, onclick, title) {
  return el('button', { class: 'sl-icon-btn', title: title || label, 'aria-label': title || label, onclick, text: label });
}

function imagesBlock(style, kind, emptyText) {
  const items = kind === 'refs' ? style.refThumbs : style.objectThumbs;
  if (!items?.length) {
    return el('button', { class: 'sl-empty', onclick: () => pickAssets(style.id, kind) }, el('span', { text: emptyText }));
  }
  return el('div', { class: 'sl-thumbs' }, ...items.map((it) => el('div', { class: 'sl-thumb' },
    el('img', { src: it.thumb, alt: '' }),
    el('button', { class: 'sl-thumb-x', title: 'Убрать в корзину стилей', 'aria-label': 'Убрать', onclick: () => removeAsset(style.id, it.file), text: '×' }))));
}

async function pickAssets(id, kind) {
  const res = await call(host.stylesAssetPick, { id, kind }, 'Добавлено.');
  if (res) await reload();
}

async function removeAsset(id, file) {
  const res = await call(host.stylesAssetRemove, { id, file }, 'Убрано в корзину стилей.');
  if (res) await reload();
}

async function saveField(id, patch, okText = 'Сохранено.') {
  const res = await call(host.stylesSave, { id, ...patch }, okText);
  if (res) await reload();
  return res;
}

function editableText(style, field, placeholder, rows = 6) {
  const area = el('textarea', { class: 'sl-input sl-textarea', rows, placeholder });
  area.value = style[field] || '';
  const save = el('button', { class: 'sl-btn', text: 'Сохранить', onclick: () => saveField(style.id, { [field]: area.value }) });
  return el('div', { class: 'sl-edit' }, area, save);
}

function paletteBlock(style) {
  const chips = el('div', { class: 'sl-palette' }, ...style.palette.map((hex) => el('span', { class: 'sl-chip', title: hex },
    el('span', { class: 'sl-swatch', style: `background:${hex}` }), el('span', { text: hex }))));
  const input = el('input', { class: 'sl-input', placeholder: '#D97757, #7A1F2B, …' });
  input.value = style.palette.join(', ');
  return el('div', {},
    style.palette.length ? chips : el('p', { class: 'sl-muted', text: 'Палитра пустая.' }),
    el('div', { class: 'sl-row' }, input,
      el('button', { class: 'sl-btn', text: 'Сохранить', onclick: () => saveField(style.id, { palette: input.value }) }),
      el('button', { class: 'sl-btn sl-btn-tonal', text: 'Из картинок', onclick: async () => {
        const res = await call(host.stylesPalette, { id: style.id, apply: true, count: 6 }, 'Палитра собрана из картинок.');
        if (res) await reload();
      } })));
}

function fontsBlock(style) {
  const mk = (role, ph) => { const i = el('input', { class: 'sl-input', placeholder: ph }); i.value = style.fonts[role] || ''; return i; };
  const h = mk('heading', 'Заголовки (например, Playfair Display)');
  const b = mk('body', 'Основной текст (например, Inter)');
  const a = mk('accent', 'Акценты');
  return el('div', { class: 'sl-stack' }, h, b, a,
    el('button', { class: 'sl-btn', text: 'Сохранить', onclick: () => saveField(style.id, { fonts: { heading: h.value, body: b.value, accent: a.value } }) }));
}

function identityBlock(style) {
  const type = el('select', { class: 'sl-input' }, ...Object.entries(TYPE_LABELS).map(([v, t]) => el('option', { value: v, text: t })));
  type.value = style.type;
  const privacy = el('select', { class: 'sl-input' }, ...Object.entries(PRIVACY_LABELS).map(([v, t]) => el('option', { value: v, text: t })));
  privacy.value = style.privacy;
  const medium = el('select', { class: 'sl-input' }, el('option', { value: 'illustration', text: 'Иллюстрация' }), el('option', { value: 'photo', text: 'Фото' }));
  medium.value = style.medium;
  const voice = el('select', { class: 'sl-input' }, el('option', { value: '', text: 'Без своего образа письма' }),
    ...state.lib.voices.map((v) => el('option', { value: v.id, text: `${v.name} (@${v.id})` })));
  voice.value = style.voice || '';
  const desc = el('input', { class: 'sl-input', placeholder: 'Коротко: кто это и для чего стиль' });
  desc.value = style.description;
  const person = el('input', { class: 'sl-input', placeholder: 'Чей это образ (для «Личности»)' });
  person.value = style.person;
  const consent = el('input', { class: 'sl-input', placeholder: 'Согласие: кто, когда, на что' });
  consent.value = style.consent;
  const personaRows = el('div', { class: 'sl-stack', hidden: style.type !== 'persona' }, person, consent);
  type.addEventListener('change', () => { personaRows.hidden = type.value !== 'persona'; });
  const label = (t, node) => el('label', { class: 'sl-label' }, el('span', { text: t }), node);
  return el('div', { class: 'sl-stack' },
    label('Описание', desc),
    el('div', { class: 'sl-row sl-row-wrap' }, label('Тип', type), label('Приватность', privacy), label('Картинки', medium), label('Образ письма', voice)),
    personaRows,
    el('button', { class: 'sl-btn', text: 'Сохранить', onclick: () => saveField(style.id, {
      description: desc.value, type: type.value, privacy: privacy.value, medium: medium.value, voice: voice.value, person: person.value, consent: consent.value,
    }) }));
}

function imageWordsBlock(style) {
  const pos = el('textarea', { class: 'sl-input sl-textarea', rows: 2, placeholder: 'Слова для генерации картинок (манера, свет, фактура)' });
  pos.value = style.imagePrompt;
  const neg = el('textarea', { class: 'sl-input sl-textarea', rows: 2, placeholder: 'Чего избегать' });
  neg.value = style.imageNegative;
  return el('div', { class: 'sl-stack' }, pos, neg,
    el('button', { class: 'sl-btn', text: 'Сохранить', onclick: () => saveField(style.id, { imagePrompt: pos.value, imageNegative: neg.value }) }));
}

function toolsBlock(style) {
  const prompt = el('input', { class: 'sl-input', placeholder: 'Что нарисовать (для ComfyUI и Gemini)' });
  const out = el('div', { class: 'sl-tool-out' });
  const run = async (tool, extra = {}) => {
    out.replaceChildren(el('span', { class: 'sl-muted', text: 'Работаю…' }));
    const res = await call(host.stylesApply, { id: style.id, tool, prompt: prompt.value, ...extra });
    out.replaceChildren();
    if (!res) return;
    if (res.thumb) out.append(el('img', { class: 'sl-result-img', src: res.thumb, alt: '' }), el('p', { class: 'sl-muted', text: res.file }));
    else if (res.outputPath) out.append(el('p', { text: `Готово: ${res.outputPath}` }));
    else if (res.answer) out.append(el('p', { text: res.note || '' }), el('pre', { class: 'sl-pre', text: res.answer }));
    else if (res.theme) out.append(el('pre', { class: 'sl-pre', text: JSON.stringify(res.theme, null, 2) }));
    else out.append(el('p', { text: tool === 'penpot' ? `В Penpot добавлено: цветов ${res.colors}, текстовых стилей ${res.typographies}.` : 'Готово.' }));
  };
  const pathInput = el('input', { class: 'sl-input', placeholder: 'Путь к файлу: .md/.txt для DOCX, картинка для апскейла' });
  return el('div', { class: 'sl-stack' },
    el('div', { class: 'sl-row' }, prompt,
      el('button', { class: 'sl-btn', text: 'ComfyUI', title: 'Нарисовать локально', onclick: () => run('image') }),
      el('button', { class: 'sl-btn sl-btn-tonal', text: 'Gemini', title: 'Нарисовать в веб-Gemini (Nano Banana)', disabled: style.privacy === 'localOnly', onclick: () => run('gemini-image') })),
    el('div', { class: 'sl-row' }, pathInput,
      el('button', { class: 'sl-btn sl-btn-tonal', text: 'DOCX', onclick: () => run('docx', { inputPath: pathInput.value }) }),
      el('button', { class: 'sl-btn sl-btn-tonal', text: 'Апскейл', onclick: () => run('upscale', { inputPath: pathInput.value }) })),
    el('div', { class: 'sl-row' },
      el('button', { class: 'sl-btn sl-btn-tonal', text: 'В Penpot', title: 'Цвета и шрифты — в открытый файл Penpot', onclick: () => run('penpot') }),
      el('button', { class: 'sl-btn sl-btn-tonal', text: 'Тема слайдов', onclick: () => run('slides') })),
    out);
}

function renderStyle() {
  const style = state.lib.styles.find((s) => s.id === state.styleId);
  if (!style) { state.styleId = null; return renderGrid(); }
  const isActive = state.lib.active?.style === style.id;
  return el('div', { class: 'sl-body' },
    el('div', { class: 'sl-style-head' },
      el('div', {},
        el('h2', { class: 'sl-style-title', text: style.name }),
        el('p', { class: 'sl-muted', text: `@${style.id} · ${TYPE_LABELS[style.type]} · ${PRIVACY_LABELS[style.privacy]}` }),
        el('div', { class: 'sl-row' },
          el('button', { class: 'sl-btn sl-btn-primary', text: 'Настроить пошагово', onclick: () => openWizard(style) }),
          el('button', { class: 'sl-btn sl-btn-tonal', text: isActive ? 'Выключить' : 'Сделать активным', onclick: async () => {
            const res = await call(host.stylesActive, { style: isActive ? '' : style.id }, isActive ? 'Стиль выключен.' : 'Стиль включён для всех чатов.');
            if (res) await reload();
          } }),
          el('button', { class: 'sl-btn sl-btn-danger', text: 'В корзину', onclick: async () => {
            const res = await call(host.stylesRemove, { id: style.id }, 'Стиль убран в корзину стилей.');
            if (res) { state.styleId = null; await reload(); }
          } }))),
      style.coverThumb ? el('img', { class: 'sl-cover', src: style.coverThumb, alt: '' }) : el('div', { class: 'sl-cover sl-cover-initials', text: initials(style.name) })),
    section('Референсы', iconBtn('+', () => pickAssets(style.id, 'refs'), 'Добавить референсы'), imagesBlock(style, 'refs', 'Добавьте изображения, чтобы задать настроение и стиль')),
    section('Объекты', iconBtn('+', () => pickAssets(style.id, 'objects'), 'Добавить объекты'), imagesBlock(style, 'objects', 'Добавьте то, что не меняется: логотип, персонажа, товар')),
    section('Инструкции', null, editableText(style, 'instructions', 'Как использовать объекты и стиль, что запрещено', 7)),
    section('Цвета', null, paletteBlock(style)),
    section('Шрифты', null, fontsBlock(style)),
    section('Тип, приватность, образ письма', null, identityBlock(style)),
    section('Слова для картинок', null, imageWordsBlock(style)),
    section('Применить в инструменте', null, toolsBlock(style)));
}

// ---------------------------------------------------------------- step-by-step setup

function openWizard(existing = null) {
  const steps = [
    { key: 'name', q: 'Как назвать стиль?', ph: 'Например: Claude (Бригада)', skipIfExisting: true },
    { key: 'type', q: 'Кто это?', options: TYPE_LABELS },
    { key: 'person', q: 'Чей это образ? Укажи человека и есть ли его согласие.', ph: 'Иван Петров, согласие 23.11 на посты', when: (d) => d.type === 'persona' },
    { key: 'description', q: 'Коротко: для чего этот стиль?', ph: 'Маскот бригады: портреты, стикеры, посты от его лица' },
    { key: 'privacy', q: 'Можно ли отдавать стиль облачным моделям?', options: PRIVACY_LABELS },
    { key: 'pictures', q: 'Добавь картинки: объекты (то, что не меняется) и референсы (настроение). Палитру соберу из них сама.', pictures: true },
    { key: 'fonts', q: 'Шрифты: заголовки и основной текст (можно пропустить).', ph: 'Playfair Display, Inter' },
    { key: 'instructions', q: 'Правила стиля: что обязательно и что запрещено.', ph: 'Без желтизны и «масла», ровные контуры, плоский матовый цвет…', area: true },
  ];
  const data = existing ? { ...existing } : { type: 'mascot', privacy: 'cloudAllowed' };
  let i = 0;
  let id = existing?.id || '';
  const backdrop = el('div', { class: 'sl-wizard-backdrop' });
  const box = el('div', { class: 'sl-wizard', role: 'dialog', 'aria-modal': 'true' });
  backdrop.append(box);
  root.append(backdrop);
  const close = async () => { backdrop.remove(); await reload(); };

  const next = async (value) => {
    const step = steps[i];
    if (step.key === 'name' && !id) {
      const res = await call(host.stylesSave, { name: value, type: data.type, privacy: data.privacy });
      if (!res) return;
      id = res.style.id;
    } else if (step.key === 'fonts') {
      const [heading = '', body = ''] = String(value || '').split(',').map((s) => s.trim());
      if (heading || body) await call(host.stylesSave, { id, fonts: { heading, body } });
    } else if (step.key === 'person') {
      const [person, ...rest] = String(value || '').split(',');
      if (!await call(host.stylesSave, { id, type: 'persona', person: person.trim(), consent: rest.join(',').trim() })) return;
    } else if (!step.pictures && value !== undefined) {
      if (step.key === 'type' && value === 'persona') { data.type = value; }
      else if (!await call(host.stylesSave, { id, [step.key]: value })) return;
      data[step.key] = value;
    }
    i += 1;
    show();
  };

  const show = () => {
    while (i < steps.length && ((steps[i].skipIfExisting && id) || (steps[i].when && !steps[i].when(data)))) i += 1;
    if (i >= steps.length) { toast('Стиль настроен.'); state.styleId = id; close(); return; }
    const step = steps[i];
    const body = [];
    let read = () => undefined;
    if (step.options) {
      const sel = el('div', { class: 'sl-choice' }, ...Object.entries(step.options).map(([v, t]) => el('button', {
        class: `sl-btn${data[step.key] === v ? ' sl-btn-primary' : ' sl-btn-tonal'}`, text: t, onclick: () => next(v),
      })));
      body.push(sel);
    } else if (step.pictures) {
      body.push(el('div', { class: 'sl-row' },
        el('button', { class: 'sl-btn sl-btn-tonal', text: 'Объекты…', onclick: () => call(host.stylesAssetPick, { id, kind: 'objects' }, 'Объекты добавлены.') }),
        el('button', { class: 'sl-btn sl-btn-tonal', text: 'Референсы…', onclick: () => call(host.stylesAssetPick, { id, kind: 'refs' }, 'Референсы добавлены.') }),
        el('button', { class: 'sl-btn sl-btn-tonal', text: 'Палитра из картинок', onclick: () => call(host.stylesPalette, { id, apply: true }, 'Палитра собрана.') })));
    } else {
      const input = step.area ? el('textarea', { class: 'sl-input sl-textarea', rows: 5, placeholder: step.ph }) : el('input', { class: 'sl-input', placeholder: step.ph });
      if (data[step.key] && typeof data[step.key] === 'string') input.value = data[step.key];
      read = () => input.value.trim();
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !step.area) next(read()); });
      body.push(input);
      setTimeout(() => input.focus(), 0);
    }
    box.replaceChildren(
      el('p', { class: 'sl-muted', text: `Шаг ${i + 1} из ${steps.length}` }),
      el('h3', { text: step.q }),
      ...body,
      el('div', { class: 'sl-row sl-row-end' },
        el('button', { class: 'sl-btn sl-btn-text', text: 'Закрыть', onclick: close }),
        step.options ? null : el('button', { class: 'sl-btn sl-btn-text', text: step.key === 'name' ? '' : 'Пропустить', hidden: step.key === 'name', onclick: () => { i += 1; show(); } }),
        step.options ? null : el('button', { class: 'sl-btn sl-btn-primary', text: 'Дальше', onclick: () => next(read()) })));
  };
  show();
}

// ---------------------------------------------------------------- voices

function renderVoices() {
  const lib = state.lib;
  const activeVoice = lib.active?.voice;
  const name = el('input', { class: 'sl-input', placeholder: 'Новый образ письма: имя' });
  const list = el('div', { class: 'sl-voice-list' }, ...lib.voices.map((v) => el('button', {
    class: `sl-voice-item${state.voiceId === v.id ? ' sl-voice-item-on' : ''}`, onclick: () => { state.voiceId = v.id; render(); },
  }, el('span', { text: v.name }), el('span', { class: 'sl-muted', text: `@${v.id}${activeVoice === v.id ? ' · активен' : ''}` }))));
  const voice = lib.voices.find((v) => v.id === state.voiceId);
  let detail = el('p', { class: 'sl-muted', text: 'Образ письма — как писать. Работает с любой моделью: включи его здесь, или напиши @имя в сообщении, или /образ имя.' });
  if (voice) {
    const card = el('textarea', { class: 'sl-input sl-textarea', rows: 14, placeholder: 'Карточка голоса: соберётся из образцов локальной моделью или пиши руками' });
    card.value = voice.card;
    const privacy = el('select', { class: 'sl-input' }, ...Object.entries(PRIVACY_LABELS).map(([v, t]) => el('option', { value: v, text: t })));
    privacy.value = voice.privacy;
    const sample = el('textarea', { class: 'sl-input sl-textarea', rows: 4, placeholder: 'Вставь живой текст-образец (сообщение, пост, письмо)' });
    detail = el('div', { class: 'sl-stack' },
      el('h3', { text: voice.name }),
      el('p', { class: 'sl-muted', text: `@${voice.id} · образцов: ${voice.samples.length} · карточка: ${{ empty: 'пустая', draft: 'черновик модели', manual: 'правлена вручную' }[voice.cardStatus] || voice.cardStatus}` }),
      el('div', { class: 'sl-row' },
        el('button', { class: 'sl-btn sl-btn-tonal', text: activeVoice === voice.id ? 'Выключить' : 'Сделать активным', onclick: async () => {
          if (await call(host.stylesActive, { voice: activeVoice === voice.id ? '' : voice.id }, 'Готово.')) await reload();
        } }),
        el('button', { class: 'sl-btn sl-btn-danger', text: 'В корзину', onclick: async () => {
          if (await call(host.stylesVoiceRemove, { id: voice.id }, 'Образ письма убран в корзину.')) { state.voiceId = null; await reload(); }
        } })),
      el('label', { class: 'sl-label' }, el('span', { text: 'Приватность' }), privacy),
      sample,
      el('div', { class: 'sl-row' },
        el('button', { class: 'sl-btn sl-btn-tonal', text: 'Добавить образец', onclick: async () => {
          if (await call(host.stylesVoiceSample, { id: voice.id, text: sample.value }, 'Образец добавлен.')) await reload();
        } }),
        el('button', { class: 'sl-btn sl-btn-tonal', text: 'Образцы из файлов…', onclick: async () => {
          if (await call(host.stylesVoiceSamplePick, { id: voice.id }, 'Образцы добавлены.')) await reload();
        } }),
        el('button', { class: 'sl-btn sl-btn-primary', text: 'Собрать карточку', title: 'Локальная модель прочитает образцы', onclick: async (e) => {
          e.currentTarget.disabled = true;
          toast('Локальная модель читает образцы…');
          if (await call(host.stylesVoiceCard, { id: voice.id }, 'Карточка собрана: проверь и поправь.')) await reload();
          else e.currentTarget.disabled = false;
        } })),
      card,
      el('button', { class: 'sl-btn', text: 'Сохранить карточку и приватность', onclick: async () => {
        if (await call(host.stylesVoiceSave, { id: voice.id, card: card.value, privacy: privacy.value }, 'Сохранено.')) await reload();
      } }));
  }
  return el('div', { class: 'sl-body sl-voices' },
    el('div', { class: 'sl-voice-side' },
      el('div', { class: 'sl-row' }, name, el('button', { class: 'sl-btn', text: 'Создать', onclick: async () => {
        const res = await call(host.stylesVoiceSave, { name: name.value }, 'Образ письма создан.');
        if (res) { state.voiceId = res.voice.id; await reload(); }
      } })),
      list),
    el('div', { class: 'sl-voice-detail' }, detail));
}

// ---------------------------------------------------------------- shell

function render() {
  if (!root || !state.lib) return;
  const panel = root.querySelector('.sl-panel');
  // Visual styles are a later stage: until the stylesVisual flag is on, the window holds only writing voices.
  const visual = state.lib.visual !== false;
  if (!visual) { state.tab = 'voices'; state.styleId = null; }
  const back = state.styleId && state.tab === 'styles'
    ? el('button', { class: 'sl-icon-btn', 'aria-label': 'Назад', title: 'Назад', text: '←', onclick: () => { state.styleId = null; render(); } })
    : null;
  const tabs = !visual ? null : el('div', { class: 'sl-tabs', role: 'tablist' },
    ...[['styles', 'Стили'], ['voices', 'Образы письма']].map(([id, t]) => el('button', {
      class: `sl-tab${state.tab === id ? ' sl-tab-on' : ''}`, role: 'tab', 'aria-selected': String(state.tab === id), text: t,
      onclick: () => { state.tab = id; state.styleId = null; render(); },
    })));
  const header = el('div', { class: 'sl-header' }, back, el('h2', { text: visual ? 'Библиотека' : 'Образы письма' }), tabs,
    el('button', { class: 'sl-icon-btn sl-close', 'aria-label': 'Закрыть', title: 'Закрыть', text: '×', onclick: closeStylesLibrary }));
  const body = state.tab === 'voices' ? renderVoices() : (state.styleId ? renderStyle() : renderGrid());
  panel.replaceChildren(header, body);
}

export async function openStylesLibrary({ tab = 'styles', styleId = null } = {}) {
  if (!host?.stylesLibrary) return;
  closeStylesLibrary();
  state = { tab, lib: null, styleId, voiceId: null };
  root = el('div', { class: 'sl-backdrop', onclick: (e) => { if (e.target === root) closeStylesLibrary(); } },
    el('div', { class: 'sl-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Библиотека стилей' }),
    el('div', { class: 'sl-toast', role: 'status' }));
  document.body.append(root);
  document.addEventListener('keydown', onKey);
  await reload();
}

function onKey(e) {
  if (e.key === 'Escape' && root && !root.querySelector('.sl-wizard-backdrop')) closeStylesLibrary();
}

export function closeStylesLibrary() {
  document.removeEventListener('keydown', onKey);
  root?.remove();
  root = null;
}
