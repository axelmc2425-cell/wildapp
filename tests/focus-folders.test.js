import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeFolder, folderProblem } from '../src/modules/focus/folders.js';
import { checkEntry } from '../src/modules/focus/entry.js';
import { validItem, validateItems, MAX_ITEMS_PER_WINDOW } from '../src/modules/focus/limits.js';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/folder-vectors.json', import.meta.url), 'utf8'));
const win = (o = {}) => ({ id: 'w', starts: 1, ends: 2, lock: 'none', mode: 'block', sites: [], apps: [], ...o });
const FORBIDDEN = "That folder is part of Windows and can't be blocked.";
const MALFORMED = 'Pick a folder with the Browse folder button.';

test('folder_vectors_match_rust_fixture', () => {
  for (const x of vectors.ok) {
    assert.equal(folderProblem(x), null, `raw ok ${JSON.stringify(x)}`);
    assert.equal(folderProblem(normalizeFolder(x) ?? x), null, `ok ${JSON.stringify(x)}`);
  }
  for (const x of vectors.malformed) assert.equal(folderProblem(normalizeFolder(x) ?? x), 'malformed', `malformed ${JSON.stringify(x)}`);
  for (const x of vectors.forbidden) assert.equal(folderProblem(normalizeFolder(x) ?? x), 'forbidden', `forbidden ${JSON.stringify(x)}`);
});

test('normalizeFolder', () => {
  assert.equal(normalizeFolder('C:/Games/Foo/'), 'C:\\Games\\Foo');
  assert.equal(normalizeFolder('C:\\a\\.\\b'), 'C:\\a\\b');
  assert.equal(normalizeFolder('C:\\a\\..\\b'), null);
  assert.equal(normalizeFolder('C:\\Games\\\\'), null);
  assert.equal(normalizeFolder('C:\\'), 'C:\\');
  assert.equal(normalizeFolder('Games'), null);
  assert.equal(normalizeFolder('\\\\server\\share'), null);
  assert.equal(normalizeFolder('C:\\a*'), null);
});

test('checkEntry folder', () => {
  assert.deepEqual(checkEntry('folder', 'C:/Games/Foo/'), { ok: true, value: 'C:\\Games\\Foo', changed: true });
  assert.deepEqual(checkEntry('folder', 'C:\\Games\\Foo'), { ok: true, value: 'C:\\Games\\Foo', changed: false });
  assert.deepEqual(checkEntry('folder', 'C:\\Windows\\System32'), { ok: false, message: FORBIDDEN });
  assert.deepEqual(checkEntry('folder', 'C:\\'), { ok: false, message: FORBIDDEN });
  assert.deepEqual(checkEntry('folder', 'Games'), { ok: false, message: MALFORMED });
  assert.deepEqual(checkEntry('folder', 'C:\\a\\..\\b'), { ok: false, message: MALFORMED });
  assert.deepEqual(checkEntry('folder', '  '), { ok: false, message: 'Type something first.' });
});

test('validItem folder', () => {
  assert.equal(validItem('folder', 'C:\\Games\\Foo'), true);
  assert.equal(validItem('folder', 'C:\\Windows'), false);
  assert.equal(validItem('folder', 'nope'), false);
  assert.equal(validItem('folder', 5), false);
});

test('validateItems checks app_folders and counts them', () => {
  assert.deepEqual(validateItems(win({ app_folders: ['C:\\Games'] })), { ok: true });
  assert.deepEqual(validateItems(win({ app_folders: ['C:\\Windows'] })), { ok: false, reason: 'bad-item' });
  assert.deepEqual(validateItems(win({ app_folders: ['C:\\a\\..\\b'] })), { ok: false, reason: 'bad-item' });
  assert.deepEqual(validateItems(win({ app_folders: 'C:\\x' })), { ok: false, reason: 'bad-item' });
  const apps = Array.from({ length: MAX_ITEMS_PER_WINDOW }, (_, i) => `a${i}.exe`);
  assert.deepEqual(validateItems(win({ apps, app_folders: ['C:\\Games'] })), { ok: false, reason: 'too-many' });
});
