import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPaste, addEntries, canSave, removeLast, MAX_ENTRIES } from '../src/modules/focus/ui/editor-logic.js';

const empty = () => ({ sites: [], apps: [] });

test('splitPaste splits sites on commas, newlines and whitespace', () => {
  assert.deepEqual(splitPaste('site', 'https://www.Reddit.com/r/x, youtube.com\nX.com'), ['https://www.Reddit.com/r/x', 'youtube.com', 'X.com']);
  assert.deepEqual(splitPaste('site', '  \n , '), []);
});

test('splitPaste keeps spaces inside app names', () => {
  assert.deepEqual(splitPaste('app', 'League of Legends.exe\nsteam.exe'), ['League of Legends.exe', 'steam.exe']);
  assert.deepEqual(splitPaste('app', 'a.exe, b.exe'), ['a.exe', 'b.exe']);
});

test('addEntries normalizes, notes changes and collapses duplicates', () => {
  const r = addEntries(empty(), 'site', ['https://www.Reddit.com/r/x', 'youtube.com', 'X.com', 'reddit.com']);
  assert.deepEqual(r.state.sites, ['reddit.com', 'youtube.com', 'x.com']);
  assert.deepEqual(r.errors, []);
  assert.ok(r.notes.includes('Will be saved as reddit.com'));
  assert.ok(!r.notes.some(n => n.includes('youtube')));
});

test('addEntries keeps spaces in app names and does not mutate input', () => {
  const s = empty();
  const r = addEntries(s, 'app', ['League of Legends.exe', 'steam.exe']);
  assert.deepEqual(r.state.apps, ['league of legends.exe', 'steam.exe']);
  assert.deepEqual(s, empty());
});

test('a bad entry yields an error and no chip', () => {
  const r = addEntries(empty(), 'site', ['not a domain', 'ok.com']);
  assert.deepEqual(r.state.sites, ['ok.com']);
  assert.deepEqual(r.errors, [{ value: 'not a domain', message: "That doesn't look like a website address." }]);
  const a = addEntries(empty(), 'app', ['C:\\Games\\']);
  assert.deepEqual(a.state.apps, []);
  assert.equal(a.errors[0].message, "Use the program's file name, like steam.exe.");
});

test('the 512-entry cap refuses extra entries', () => {
  const pieces = Array.from({ length: 600 }, (_, i) => `site${i}.com`);
  const r = addEntries(empty(), 'site', pieces);
  assert.equal(r.state.sites.length, MAX_ENTRIES);
  assert.ok(r.errors.some(e => e.message === 'A list can hold up to 512 entries.'));
  const r2 = addEntries(r.state, 'app', ['x.exe']);
  assert.deepEqual(r2.state.apps, []);
  assert.equal(r2.errors[0].message, 'A list can hold up to 512 entries.');
});

test('canSave needs a trimmed name and at least one entry', () => {
  assert.equal(canSave({ name: 'A', sites: ['a.com'], apps: [] }), true);
  assert.equal(canSave({ name: 'A', sites: [], apps: ['a.exe'] }), true);
  assert.equal(canSave({ name: '   ', sites: ['a.com'], apps: [] }), false);
  assert.equal(canSave({ name: 'A', sites: [], apps: [] }), false);
});

test('removeLast drops the last chip and is a no-op when empty', () => {
  assert.deepEqual(removeLast({ sites: ['a.com', 'b.com'], apps: [] }, 'site').sites, ['a.com']);
  const e = empty();
  assert.deepEqual(removeLast(e, 'app'), e);
  assert.deepEqual(removeLast(e, 'site'), e);
});
