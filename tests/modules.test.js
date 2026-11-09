import test from 'node:test';
import assert from 'node:assert/strict';
import { registerModule, listModules, runStartHooks } from '../src/shell/modules.js';
import '../src/shell/builtin.js';
import '../src/modules/secondbrain/index.js';
import '../src/modules/focus/index.js';

test('listModules returns seven modules in order', () => {
  assert.deepEqual(listModules().map(m => m.id),
    ['secondbrain', 'focus', 'cooking', 'money', 'skills', 'photos', 'journal']);
});

test('secondbrain and focus are ready, the rest are soon', () => {
  assert.deepEqual(listModules().filter(m => m.ready).map(m => m.id), ['secondbrain', 'focus']);
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
  const mods = listModules();
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
