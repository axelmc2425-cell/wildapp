import test from 'node:test';
import assert from 'node:assert/strict';
import { getModule, runStartHooks } from '../src/shell/modules.js';
import '../src/modules/focus/index.js';

// A db whose every call returns a promise that never settles, so controller.load() hangs.
const hungDb = new Proxy({}, { get: () => () => new Promise(() => {}) });

test('focus onStart returns before load() finishes', async () => {
  const done = await Promise.race([
    getModule('focus').onStart({ db: hungDb }).then(() => 'returned'),
    new Promise(r => setTimeout(() => r('timeout'), 500)),
  ]);
  assert.equal(done, 'returned');
});

test('runStartHooks resolves promptly even if the focus load never settles', async () => {
  const t0 = Date.now();
  await runStartHooks({ db: hungDb });
  assert.ok(Date.now() - t0 < 1000);
});
