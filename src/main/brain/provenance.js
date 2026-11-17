'use strict';
// Происхождение приватности задачи (brain v1, фаза 1).
// Права — это идентичность замыкания и WeakMap владельца, а не поля объекта:
// строка, копия, JSON или объект с похожими полями ничего не подтверждают.
// Это разделение API внутри процесса, а не песочница от кода с доступом к owner.
// Модуль не доказывает, что будущие маршруты задачи обычные, и не подключён к
// ingest/IPC: ответственность за корректный корень несёт доверенный вызывающий.

const RANK = Object.freeze({ ordinary: 0, unknown: 1, tor: 2, dark: 2 });

function check(value) {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(RANK, value)) {
    throw new TypeError('classification must be one of: ordinary, unknown, tor, dark');
  }
  return value;
}

function createOwner() {
  const issued = new WeakMap(); // handle -> classification; только этот владелец

  const mint = (classification) => {
    const handle = Object.freeze(Object.create(null));
    issued.set(handle, classification);
    return handle;
  };

  const own = (handle) => {
    if (handle === null || (typeof handle !== 'object')) return null;
    return issued.has(handle) ? issued.get(handle) : null;
  };

  // Корень: классификацию задаёт только доверенный владелец явно; по умолчанию unknown.
  function root(classification = 'unknown') {
    return mint(check(classification));
  }

  // Потомок не мягче родителя: запрос более мягкого класса игнорируется.
  // Подлинность родителя обязательна, иначе TypeError (закрытый отказ).
  function derive(parent, requested) {
    const base = own(parent);
    if (base === null) throw new TypeError('parent handle is not authentic');
    if (requested === undefined) return mint(base);
    const asked = check(requested);
    return mint(RANK[asked] > RANK[base] ? asked : base);
  }

  // Классификация подлинного дескриптора; null для чужого/поддельного/отсутствующего.
  function classify(handle) {
    return own(handle);
  }

  // Только текущая классификация, НЕ разрешение журналировать будущий маршрут.
  // Подлинный ordinary -> true, всё остальное -> false.
  function isOrdinary(handle) {
    return own(handle) === 'ordinary';
  }

  return Object.freeze({ root, derive, classify, isOrdinary });
}

module.exports = { createOwner, CLASSIFICATIONS: Object.freeze(Object.keys(RANK)) };
