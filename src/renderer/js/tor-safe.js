'use strict';

(() => {
  const params = new URLSearchParams(window.location.search);
  let mode = params.get('mode') === 'create' ? 'create' : 'open';
  let unlockedEntries = [];
  let selectedId = null;

  const statusBadge = document.getElementById('statusBadge');
  const safeDirEl = document.getElementById('safeDir');
  const createView = document.getElementById('createView');
  const openView = document.getElementById('openView');
  const createForm = document.getElementById('createForm');
  const passNew = document.getElementById('passNew');
  const passConfirm = document.getElementById('passConfirm');
  const createMsg = document.getElementById('createMsg');
  const goOpenBtn = document.getElementById('goOpenBtn');

  const unlockForm = document.getElementById('unlockForm');
  const passUnlock = document.getElementById('passUnlock');
  const openMsg = document.getElementById('openMsg');
  const lockBtn = document.getElementById('lockBtn');
  const destroyBtn = document.getElementById('destroyBtn');
  const workspace = document.getElementById('workspace');
  const entryList = document.getElementById('entryList');
  const entryDetail = document.getElementById('entryDetail');

  function setMessage(el, text, isError = false) {
    el.textContent = text || '';
    el.classList.toggle('is-error', Boolean(isError));
  }

  function clearUnlocked() {
    unlockedEntries = [];
    selectedId = null;
    passUnlock.value = '';
    passNew.value = '';
    passConfirm.value = '';
    entryList.replaceChildren();
    entryDetail.replaceChildren();
    workspace.hidden = true;
    lockBtn.hidden = true;
  }

  function appendBlock(parent, title, text) {
    const h = document.createElement('div');
    h.className = 'safe__section-title';
    h.textContent = title;
    const body = document.createElement('div');
    body.textContent = text;
    parent.append(h, body);
  }

  function renderSelected() {
    const item = unlockedEntries.find((e) => e.id === selectedId) || unlockedEntries[0];
    entryDetail.replaceChildren();
    if (!item) {
      entryDetail.textContent = 'Сейф пуст.';
      return;
    }
    selectedId = item.id;
    if (item.unreadable) {
      appendBlock(entryDetail, 'Недоступно', `Файл ${item.file} не расшифрован текущим ключом.`);
      return;
    }
    appendBlock(entryDetail, `Запрос (${item.node} · ${item.created_at || '—'})`, item.query || '—');
    appendBlock(entryDetail, 'Ответ', item.answer || '—');

    if (item.sources?.length) {
      const lines = item.sources.map((s) => `[${s.n}] ${s.title || ''}\n    ${s.url || ''}`).join('\n');
      appendBlock(entryDetail, 'Источники (обезврежены)', lines);
    }
    if (item.pages?.length) {
      const pageLines = item.pages.map((p) => {
        const flags = p.flags?.length ? ` [${p.flags.join(', ')}]` : '';
        return `--- ${p.title || ''} (${p.url_defanged || ''})${flags} ---\n${p.text || ''}`;
      }).join('\n\n');
      appendBlock(entryDetail, 'Прочитанные страницы', pageLines);
    }
  }

  function renderEntries() {
    entryList.replaceChildren();
    if (!unlockedEntries.length) {
      workspace.hidden = false;
      renderSelected();
      return;
    }
    for (const entry of unlockedEntries) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'safe__item' + (entry.id === selectedId ? ' is-active' : '');
      const meta = document.createElement('span');
      meta.className = 'safe__item-meta';
      meta.textContent = entry.unreadable
        ? `${entry.file} · нечитаем`
        : `${entry.node || 'tor'} · ${String(entry.created_at || '').slice(0, 19).replace('T', ' ')}`;
      const title = document.createElement('span');
      title.textContent = entry.unreadable ? '(другой ключ)' : (entry.query || '(без запроса)').slice(0, 60);
      btn.append(meta, title);
      btn.addEventListener('click', () => {
        selectedId = entry.id;
        renderEntries();
        renderSelected();
      });
      entryList.appendChild(btn);
    }
    workspace.hidden = false;
    renderSelected();
  }

  async function refreshState() {
    const st = await window.torSafe.getState();
    safeDirEl.textContent = st.dir || '';
    if (!st.dirAllowed) {
      statusBadge.textContent = 'ПУТЬ ЗАПРЕЩЁН (ТОЛЬКО D:)';
    } else if (st.hasKey) {
      statusBadge.textContent = `КЛЮЧ СОЗДАН · ЗАПИСЕЙ: ${st.count}`;
    } else {
      statusBadge.textContent = 'КЛЮЧ НЕ СОЗДАН';
    }
    destroyBtn.hidden = !(st.hasIdentity || st.hasRecipient);
    createView.hidden = mode !== 'create';
    openView.hidden = mode !== 'open';
  }

  goOpenBtn.addEventListener('click', () => {
    clearUnlocked();
    setMessage(createMsg, '');
    mode = 'open';
    refreshState();
  });

  createForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const p1 = passNew.value;
    const p2 = passConfirm.value;
    passNew.value = '';
    passConfirm.value = '';
    if (p1 !== p2) {
      setMessage(createMsg, 'Фразы не совпадают.', true);
      return;
    }
    try {
      setMessage(createMsg, 'Генерирую ключ…');
      await window.torSafe.createKey(p1);
      setMessage(createMsg, 'Ключ создан. Закрытый ключ зашифрован парольной фразой.');
      await refreshState();
      mode = 'open';
      await refreshState();
    } catch (err) {
      setMessage(createMsg, err?.message || 'Не удалось создать ключ.', true);
    }
  });

  unlockForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const phrase = passUnlock.value;
    passUnlock.value = '';
    if (!phrase) return;
    try {
      setMessage(openMsg, 'Расшифровываю…');
      const entries = await window.torSafe.unlock(phrase);
      unlockedEntries = Array.isArray(entries) ? entries : [];
      selectedId = unlockedEntries[0]?.id || null;
      lockBtn.hidden = false;
      renderEntries();
      setMessage(openMsg, `Открыто записей: ${unlockedEntries.length}. На диске открытый текст не сохранён.`);
    } catch (err) {
      clearUnlocked();
      setMessage(openMsg, err?.message || 'Ошибка расшифровки.', true);
    }
  });

  lockBtn.addEventListener('click', () => {
    clearUnlocked();
    setMessage(openMsg, 'Сейф закрыт, память очищена.');
  });

  destroyBtn.addEventListener('click', async () => {
    const res = await window.torSafe.destroyKey();
    if (res?.destroyed) {
      clearUnlocked();
      setMessage(openMsg, 'Ключи удалены из каталога сейфа. Без внешней резервной копии ключа записи .age больше нельзя расшифровать.');
      await refreshState();
    }
  });

  window.addEventListener('beforeunload', () => clearUnlocked());
  refreshState();
})();
