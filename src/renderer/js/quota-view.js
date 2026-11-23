const host = window.host;
const number = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function bar(group, kind, full) {
  const data = group.bars.find((item) => item.kind === kind);
  const label = data?.label || `${group.label} ${kind === 'week' ? 'Неделя' : group.id === 'web-gemini' ? 'Текущий лимит' : '5 часов'}`;
  const value = data ? `${number.format(data.remaining)}%` : 'Нет данных';
  const node = element('div', 'quota-bar');
  const caption = element('div', 'quota-bar__caption');
  caption.append(element('span', '', label), element('span', 'quota-bar__value', value));
  node.append(caption);
  if (data) {
    const meter = element('meter', 'quota-bar__meter');
    meter.min = 0;
    meter.max = 100;
    meter.value = data.remaining;
    meter.setAttribute('aria-label', label);
    node.append(meter);
    if (data.resetsAt) {
      const reset = `Сброс ${date.format(data.resetsAt)}`;
      node.title = reset;
      if (full) node.append(element('small', 'quota-note', reset));
    }
  } else {
    node.append(element('div', 'quota-bar__track'));
  }
  return node;
}

function groupBars(group, full = false) {
  const block = element('section', 'quota-group');
  block.setAttribute('aria-label', group.label);
  block.append(...group.kinds.map((kind) => bar(group, kind, full)));
  if (group.checkedAt) {
    const stale = group.stale || Date.now() - group.checkedAt > 30 * 60e3;
    const checked = `${stale ? 'Устарело · ' : ''}Проверено ${date.format(group.checkedAt)}`;
    block.title = checked;
    if (full || stale) block.append(element('small', 'quota-note', checked));
  }
  return block;
}

function subscribe(render) {
  let latest = -1;
  const apply = (snapshot) => {
    if (snapshot && snapshot.at >= latest) {
      latest = snapshot.at;
      render(snapshot);
    }
  };
  host.onQuotasUpdate(apply);
  host.quotasSnapshot().then(apply).catch(() => {});
  return apply;
}

export function mountQuotaStrip(header, { local = false } = {}) {
  const root = element('aside', 'quota-strip');
  root.setAttribute('aria-label', 'Лимиты облаков');
  root.hidden = true;
  const direct = element('div', 'quota-strip__direct');
  const swarm = element('details', 'quota-swarm');
  const narrow = matchMedia('(max-width: 720px)');
  const resize = () => { swarm.open = !narrow.matches; };
  resize();
  narrow.addEventListener('change', resize);
  const summary = element('summary', 'quota-swarm__summary');
  const agents = element('div', 'quota-swarm__groups');
  swarm.append(summary, agents);
  root.append(direct, swarm);
  header.after(root);

  let snapshot;
  let selected = null;
  let context = {};
  let revision = 0;
  const render = () => {
    if (!snapshot) return;
    const active = new Set(snapshot.active);
    const groups = new Set([
      selected,
      ...(local ? (snapshot.activity?.chat || []) : []),
      ...(snapshot.activity?.companion || []).filter((group) => !active.has(group)),
    ]);
    const shown = snapshot.groups.filter((group) => groups.has(group.id));
    const swarmGroups = snapshot.groups.filter((group) => active.has(group.id) && !groups.has(group.id));
    root.hidden = !shown.length && !swarmGroups.length;
    direct.hidden = !shown.length;
    direct.replaceChildren(...shown.map((group) => groupBars(group)));
    swarm.hidden = !swarmGroups.length;
    summary.textContent = `Рой · ${swarmGroups.map((group) => group.label).join(', ')}`;
    agents.replaceChildren(...swarmGroups.map((group) => groupBars(group)));
  };
  const apply = subscribe((next) => { snapshot = next; render(); });

  const plate = header.closest('.hud__plate');
  const update = async () => {
    if (local) return;
    const ticket = ++revision;
    const next = await host.quotasShown({
      ...context,
      visible: !plate?.hidden && document.visibilityState === 'visible',
    }).catch(() => null);
    if (next && ticket === revision) {
      selected = next.selected;
      apply(next);
      render();
    }
  };
  if (plate) new MutationObserver(update).observe(plate, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', update);
  return {
    select(agent, model) {
      context = { agent, model };
      void update();
    },
  };
}

export function mountQuotaWindow(list, button) {
  const apply = subscribe((snapshot) => list.replaceChildren(...snapshot.groups.map((group) => groupBars(group, true))));
  const setVisible = () => host.quotasShown({ all: true, visible: document.visibilityState === 'visible' }).catch(() => {});
  async function refresh() {
    button.disabled = true;
    button.textContent = 'Обновление…';
    try { apply(await host.quotasRefresh()); } catch { /* Keep the last snapshot. */ }
    finally {
      button.disabled = false;
      button.textContent = 'Обновить';
    }
  }
  document.addEventListener('visibilitychange', setVisible);
  void setVisible();
  button.onclick = refresh;
  void refresh();
}
