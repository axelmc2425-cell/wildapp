import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutosaver } from '../src/modules/secondbrain/editor.js';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('rapid changes produce one save with the latest payload', async () => {
  const saved = [];
  const a = createAutosaver({ save: async p => { saved.push(p); }, delay: 10 });
  a.change({ id: 1, body: 'a' });
  a.change({ id: 1, body: 'ab' });
  a.change({ id: 1, body: 'abc' });
  await wait(60);
  assert.deepEqual(saved, [{ id: 1, body: 'abc' }]);
  a.dispose();
});

test('a failing save keeps the text, reports an error and retries until it works', async () => {
  const statuses = [];
  let calls = 0;
  const saved = [];
  const a = createAutosaver({
    save: async p => { calls++; if (calls < 3) throw new Error('disk busy'); saved.push(p); },
    delay: 5, retryDelay: 10,
    onStatus: (s) => statuses.push(s),
  });
  a.change({ id: 1, body: 'keep me' });
  await wait(150);
  assert.ok(statuses.includes('error'));
  assert.deepEqual(saved, [{ id: 1, body: 'keep me' }]);
  assert.equal(statuses.at(-1), 'saved');
  a.dispose();
});

test('typing during a failed save is not lost', async () => {
  let fail = true;
  const saved = [];
  const a = createAutosaver({
    save: async p => { if (fail) throw new Error('x'); saved.push(p); },
    delay: 5, retryDelay: 15,
  });
  a.change({ id: 1, body: 'one' });
  await wait(30);
  a.change({ id: 1, body: 'one two' });
  fail = false;
  await wait(100);
  assert.deepEqual(saved.at(-1), { id: 1, body: 'one two' });
  a.dispose();
});

test('flush saves immediately', async () => {
  const saved = [];
  const a = createAutosaver({ save: async p => { saved.push(p); }, delay: 10_000 });
  a.change({ id: 2, body: 'now' });
  await a.flush();
  assert.deepEqual(saved, [{ id: 2, body: 'now' }]);
  a.dispose();
});

test('dispose stops pending saves', async () => {
  const saved = [];
  const a = createAutosaver({ save: async p => { saved.push(p); }, delay: 10 });
  a.change({ id: 1, body: 'x' });
  a.dispose();
  await wait(50);
  assert.deepEqual(saved, []);
});

import { wikiQuery, applyCompletion } from '../src/modules/secondbrain/editor.js';

test('flush waits for the in-flight save and the newer pending text', async () => {
  const saved = [];
  let release;
  const a = createAutosaver({
    save: async p => { if (saved.length === 0) await new Promise(r => { release = r; }); saved.push(p.body); },
    delay: 5,
  });
  a.change({ id: 1, body: 'one' });
  await wait(25);
  a.change({ id: 1, body: 'two' });
  const f = a.flush();
  release();
  assert.equal(await f, true);
  assert.deepEqual(saved, ['one', 'two']);
  a.dispose();
});

test('flush returns false while saving keeps failing and true once everything is saved', async () => {
  let fail = true;
  const saved = [];
  const a = createAutosaver({ save: async p => { if (fail) throw new Error('x'); saved.push(p); }, delay: 5, retryDelay: 15 });
  a.change({ id: 1, body: 'a' });
  assert.equal(await a.flush(), false);
  fail = false;
  assert.equal(await a.flush(), true);
  assert.deepEqual(saved, [{ id: 1, body: 'a' }]);
  a.dispose();
});

test('a note whose save failed is kept when you move on to another note', async () => {
  let fail = true;
  const saved = [];
  const a = createAutosaver({ save: async p => { if (fail && p.id === 1) throw new Error('x'); saved.push(p); }, delay: 5, retryDelay: 15 });
  a.change({ id: 1, body: 'note1 unsaved' });
  assert.equal(await a.flush(), false);
  a.change({ id: 2, body: 'note2' });
  fail = false;
  await wait(120);
  assert.ok(saved.some(p => p.id === 1 && p.body === 'note1 unsaved'), JSON.stringify(saved));
  assert.ok(saved.some(p => p.id === 2 && p.body === 'note2'), JSON.stringify(saved));
  a.dispose();
});

test('wikiQuery finds the text typed after an open [[', () => {
  assert.deepEqual(wikiQuery('see [[Gar', 9), { start: 4, query: 'Gar' });
  assert.deepEqual(wikiQuery('see [[', 6), { start: 4, query: '' });
});

test('wikiQuery is null when the link is closed or on another line', () => {
  assert.equal(wikiQuery('see [[Garden]] more', 19), null);
  assert.equal(wikiQuery('[[Gar\nden', 9), null);
  assert.equal(wikiQuery('no links here', 5), null);
});

test('applyCompletion replaces the partial link and puts the caret after ]]', () => {
  const r = applyCompletion('see [[Gar and more', 9, 'Garden plan');
  assert.equal(r.text, 'see [[Garden plan]] and more');
  assert.equal(r.caret, 'see [[Garden plan]]'.length);
});
