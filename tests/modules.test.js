import test from 'node:test';
import assert from 'node:assert/strict';
import { registerModule, listModules } from '../src/shell/modules.js';
import '../src/shell/builtin.js';
import '../src/modules/secondbrain/index.js';
import '../src/modules/focus/index.js';
import '../src/modules/cooking/index.js';

test('listModules returns seven modules in order', () => {
  assert.deepEqual(listModules().map(m => m.id),
    ['secondbrain', 'focus', 'cooking', 'money', 'skills', 'photos', 'journal']);
});

test('built modules are ready and the rest are coming soon', () => {
  assert.deepEqual(listModules().filter(m => m.ready).map(m => m.id), ['secondbrain', 'focus', 'cooking']);
});

test('registering a duplicate id throws', () => {
  assert.throws(() => registerModule({ id: 'focus', name: 'x', icon: 'x', ready: false, render() {} }), /duplicate module/);
});

test('every module has a name and icon', () => {
  for (const m of listModules()) assert.ok(m.name && m.icon, m.id);
});
