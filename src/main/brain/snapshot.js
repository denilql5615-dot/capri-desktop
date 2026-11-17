'use strict';

// Input boundary: Router.decide produces JSON-like plain data. structuredClone copies it without
// freezing the source and rejects functions/non-cloneables (caught inside the observer try/catch);
// WeakSet guards cyclic test objects while recursively freezing arrays and plain objects.
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) deepFreeze(value[i], seen);
    return Object.freeze(value);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  } else {
    throw new TypeError('observer snapshot must contain only plain data');
  }
  return Object.freeze(value);
}

const freezeSnapshot = (value) => deepFreeze(structuredClone(value));

module.exports = { deepFreeze, freezeSnapshot };
