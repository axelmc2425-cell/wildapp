import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPaste, addEntries, canSave, removeLast, folderLabel, MAX_ENTRIES } from '../src/modules/focus/ui/editor-logic.js';

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

test('addEntries adds folders, collapses duplicates and keeps the picked case', () => {
  const r = addEntries({ ...empty(), folders: [] }, 'folder', ['C:/Games/Foo/', 'C:\\Games\\Foo']);
  assert.deepEqual(r.state.folders, ['C:\\Games\\Foo']);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(addEntries(empty(), 'folder', ['D:\\Stuff']).state.folders, ['D:\\Stuff']);
});

test('addEntries reports forbidden and malformed folders', () => {
  const r = addEntries({ ...empty(), folders: [] }, 'folder', ['C:\\Windows\\System32']);
  assert.deepEqual(r.state.folders, []);
  assert.equal(r.errors[0].message, "That folder is part of Windows and can't be blocked.");
  assert.equal(addEntries(empty(), 'folder', ['games']).errors[0].message, 'Pick a folder with the Browse folder button.');
});

test('folders count toward the entry cap', () => {
  const sites = Array.from({ length: MAX_ENTRIES - 1 }, (_, i) => `s${i}.com`);
  const r = addEntries({ sites, apps: [], folders: [] }, 'folder', ['C:\\A', 'C:\\B']);
  assert.deepEqual(r.state.folders, ['C:\\A']);
  assert.match(r.errors[0].message, /512/);
});

test('canSave accepts a list with only folders', () => {
  assert.equal(canSave({ name: 'x', sites: [], apps: [], folders: ['C:\\A'] }), true);
  assert.equal(canSave({ name: 'x', sites: [], apps: [], folders: [] }), false);
  assert.equal(canSave({ name: 'x', sites: [], apps: ['a.exe'] }), true);
});

test('removeLast removes the last folder', () => {
  const s = { sites: [], apps: [], folders: ['C:\\A', 'C:\\B'] };
  assert.deepEqual(removeLast(s, 'folder').folders, ['C:\\A']);
  assert.equal(removeLast({ sites: [], apps: [], folders: [] }, 'folder').folders.length, 0);
});

test('folderLabel is the last path segment', () => {
  assert.equal(folderLabel('C:\\Games\\Foo'), 'Foo');
  assert.equal(folderLabel('D:\\'), 'D:');
});

test('a duplicate of an existing entry gets a plain message; repeats in one paste stay silent', () => {
  const s = { sites: ['a.com'], apps: ['x.exe'], folders: ['C:\\Games\\Foo'] };
  assert.deepEqual(addEntries(s, 'site', ['A.com']).errors.map(e => e.message), ['Already in this list.']);
  assert.deepEqual(addEntries(s, 'app', ['x.exe']).errors.map(e => e.message), ['Already in this list.']);
  const r = addEntries(s, 'folder', ['C:/Games/Foo/']);
  assert.deepEqual(r.errors.map(e => e.message), ['Already in this list.']);
  assert.deepEqual(r.state.folders, ['C:\\Games\\Foo']);
  assert.deepEqual(addEntries(empty(), 'site', ['b.com', 'b.com']).errors, []);
});

test('UNC and extended-length folder picks get the network path message', () => {
  const msg = "Network paths aren't supported. Use a folder on a drive letter.";
  assert.equal(addEntries(empty(), 'folder', ['\\\\server\\share\\x']).errors[0].message, msg);
  assert.equal(addEntries(empty(), 'folder', ['\\\\?\\C:\\Games']).errors[0].message, msg);
  assert.equal(addEntries(empty(), 'folder', ['games']).errors[0].message, 'Pick a folder with the Browse folder button.');
});
