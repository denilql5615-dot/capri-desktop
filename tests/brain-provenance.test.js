'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOwner } = require('../src/main/brain/provenance');

test('root defaults to unknown, explicit classes are kept, bad input throws', () => {
  const o = createOwner();
  assert.equal(o.classify(o.root()), 'unknown');
  for (const c of ['ordinary', 'unknown', 'tor', 'dark']) assert.equal(o.classify(o.root(c)), c);
  for (const bad of ['Ordinary', 'tor ', '', null, 1, {}, ['ordinary']]) {
    assert.throws(() => o.root(bad), TypeError);
  }
});

test('handles are frozen opaque objects without fields', () => {
  const o = createOwner();
  const h = o.root('ordinary');
  assert.ok(Object.isFrozen(h));
  assert.equal(Object.getPrototypeOf(h), null);
  assert.deepEqual(Reflect.ownKeys(h), []);
  assert.throws(() => { 'use strict'; h.classification = 'tor'; }, TypeError);
  assert.equal(o.classify(h), 'ordinary');
});

test('forged, missing, string, clone and JSON values fail closed', () => {
  const o = createOwner();
  const real = o.root('ordinary');
  const forged = [
    undefined, null, 'ordinary', 1, true, {}, [], () => {},
    { classification: 'ordinary' }, { ordinary: true, privacy: 'ordinary' },
    Object.create(real), { ...real }, structuredClone({ ...real }),
    JSON.parse(JSON.stringify({ classification: 'ordinary' })),
    new Proxy({}, { get: () => 'ordinary', has: () => true }),
  ];
  for (const f of forged) {
    assert.equal(o.classify(f), null);
    assert.equal(o.isOrdinary(f), false);
    assert.throws(() => o.derive(f), TypeError);
  }
  assert.equal(o.isOrdinary(real), true);
});

test('prototype pollution does not confer authority', () => {
  const o = createOwner();
  Object.prototype.classification = 'ordinary';
  try {
    assert.equal(o.classify({}), null);
    assert.equal(o.isOrdinary({ classification: 'ordinary' }), false);
    assert.equal(o.classify(o.root('tor')), 'tor');
  } finally {
    delete Object.prototype.classification;
  }
});

test('tokens from another owner are not trusted', () => {
  const a = createOwner();
  const b = createOwner();
  const ha = a.root('ordinary');
  assert.equal(b.classify(ha), null);
  assert.equal(b.isOrdinary(ha), false);
  assert.throws(() => b.derive(ha), TypeError);
  assert.equal(a.isOrdinary(ha), true);
});

test('authentication never reads getters or invokes proxy traps', () => {
  const o = createOwner();
  const trap = () => { throw new Error('untrusted property accessed'); };
  const getter = Object.defineProperty({}, 'privacy', { get: trap });
  const proxy = new Proxy(o.root('ordinary'), {
    get: trap, has: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
  });
  for (const fake of [getter, proxy]) {
    assert.equal(o.classify(fake), null);
    assert.equal(o.isOrdinary(fake), false);
    assert.throws(() => o.derive(fake), TypeError);
  }
});

test('children never become softer than parent', () => {
  const o = createOwner();
  for (const c of ['unknown', 'tor', 'dark']) {
    const parent = o.root(c);
    assert.equal(o.classify(o.derive(parent)), c);
    assert.equal(o.classify(o.derive(parent, 'ordinary')), c);
    assert.equal(o.isOrdinary(o.derive(o.derive(parent, 'ordinary'), 'ordinary')), false);
  }
  assert.equal(o.classify(o.derive(o.root('tor'), 'dark')), 'tor');
  assert.equal(o.classify(o.derive(o.root('tor'), 'unknown')), 'tor');
  assert.equal(o.classify(o.derive(o.root('dark'), 'unknown')), 'dark');
  assert.equal(o.classify(o.derive(o.root('dark'), 'tor')), 'dark');
  assert.equal(o.classify(o.derive(o.root('unknown'), 'tor')), 'tor');
  assert.throws(() => o.derive(o.root('tor'), 'nope'), TypeError);
});

test('ordinary parent may be tightened, and ordinary roots are independent', () => {
  const o = createOwner();
  const ord = o.root('ordinary');
  assert.equal(o.classify(o.derive(ord)), 'ordinary');
  assert.equal(o.classify(o.derive(ord, 'tor')), 'tor');
  assert.equal(o.classify(ord), 'ordinary');
  const tor = o.root('tor');
  assert.equal(o.isOrdinary(o.root('ordinary')), true);
  assert.equal(o.isOrdinary(tor), false);
  assert.notEqual(o.root('ordinary'), ord);
});

test('owner API is frozen and module is side-effect free', () => {
  const o = createOwner();
  assert.ok(Object.isFrozen(o));
  assert.deepEqual(Object.keys(o).sort(), ['classify', 'derive', 'isOrdinary', 'root']);
  const src = require('node:fs').readFileSync(require.resolve('../src/main/brain/provenance'), 'utf8');
  assert.equal(/require\(|import |Date\.|Math\.random|process\./.test(src), false);
});
