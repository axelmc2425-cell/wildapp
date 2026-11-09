import test from 'node:test';
import assert from 'node:assert/strict';
import { registerModule, listModules, runStartHooks } from '../src/shell/modules.js';
import '../src/modules/focus/index.js';

// The start-hook tests need several modules; register throwaway ones (they sort after focus).
for (const id of ['t-a', 't-b', 't-c']) registerModule({ id, name: id, icon: 'x', ready: true, render() {} });
const hookMods = () => listModules().filter(m => m.id.startsWith('t-'));

test('Focus Room is the first real module', () => {
  assert.deepEqual(listModules().map(m => m.id).filter(id => !id.startsWith('t-')), ['focus']);
});

test('the sidebar lists Focus Room as ready (not soon)', () => {
  const focus = listModules().find(m => m.id === 'focus');
  assert.equal(focus.name, 'Focus Room');
  assert.equal(focus.ready, true);
});

test('importing the focus module in Node registers focus', () => {
  assert.equal(listModules().filter(m => m.id === 'focus').length, 1);
});

test('registering the focus module twice still throws duplicate', () => {
  assert.throws(() => registerModule({ id: 'focus', name: 'x', icon: 'x', ready: false, render() {} }), /duplicate module/);
});

test('every module has a name and icon', () => {
  for (const m of listModules()) assert.ok(m.name && m.icon, m.id);
});

test('runStartHooks calls each onStart in module order', async () => {
  const calls = [];
  const ctx = { tag: 'ctx' };
  const mods = listModules();
  const saved = mods.map(m => m.onStart);
  mods.forEach((m, i) => { m.onStart = async (c) => { await null; calls.push([m.id, c]); }; });
  try {
    await runStartHooks(ctx);
  } finally {
    mods.forEach((m, i) => { if (saved[i]) m.onStart = saved[i]; else delete m.onStart; });
  }
  assert.deepEqual(calls.map(c => c[0]), mods.map(m => m.id));
  assert.ok(calls.every(c => c[1] === ctx));
});

test('a throwing onStart is logged and does not stop later hooks', async () => {
  const mods = hookMods();
  const saved = mods.map(m => m.onStart);
  const ran = [];
  mods[0].onStart = () => { throw new Error('boom'); };
  mods[1].onStart = async () => { throw new Error('async boom'); };
  mods[2].onStart = () => { ran.push(mods[2].id); };
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a);
  try {
    await runStartHooks({});
  } finally {
    console.error = orig;
    mods.forEach((m, i) => { if (saved[i]) m.onStart = saved[i]; else delete m.onStart; });
  }
  assert.deepEqual(ran, [mods[2].id]);
  assert.equal(logged.length, 2);
});

function patchHooks(hooks) {
  const mods = hookMods();
  const saved = mods.map(m => m.onStart);
  mods.forEach((m, i) => { if (hooks[i]) m.onStart = hooks[i]; else delete m.onStart; });
  return () => mods.forEach((m, i) => { if (saved[i]) m.onStart = saved[i]; else delete m.onStart; });
}

test('a hook that never settles does not block later hooks or the result', async () => {
  const ran = [];
  const restore = patchHooks([() => new Promise(() => {}), () => { ran.push('second'); }]);
  const orig = console.error; const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try { await runStartHooks({}, { timeoutMs: 20 }); } finally { console.error = orig; restore(); }
  assert.deepEqual(ran, ['second']);
  assert.ok(logged.some(l => /still running; continuing/.test(l)));
});

test('a slow hook within the timeout finishes before the next one starts', async () => {
  const order = [];
  const restore = patchHooks([
    async () => { await new Promise(r => setTimeout(r, 30)); order.push('first-done'); },
    () => { order.push('second-start'); },
  ]);
  try { await runStartHooks({}, { timeoutMs: 2000 }); } finally { restore(); }
  assert.deepEqual(order, ['first-done', 'second-start']);
});

test('a hook rejecting after being abandoned causes no unhandled rejection', async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  const restore = patchHooks([() => new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 60))]);
  const orig = console.error; const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    await runStartHooks({}, { timeoutMs: 10 });
    await new Promise(r => setTimeout(r, 120));
  } finally { console.error = orig; restore(); process.off('unhandledRejection', onUnhandled); }
  assert.equal(unhandled, 0);
  assert.ok(logged.some(l => /module start hook failed/.test(l)));
});
