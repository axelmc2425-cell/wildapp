import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkEntry } from '../src/modules/focus/entry.js';
import { validItem } from '../src/modules/focus/limits.js';
import { STARTERS } from '../src/modules/focus/starters.js';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/item-vectors.json', import.meta.url), 'utf8'));
const EMPTY = 'Type something first.';
const BAD_SITE = "That doesn't look like a website address.";
const BAD_APP = "Use the program's file name, like steam.exe.";

test('site entries are normalized and flagged when changed', () => {
  assert.deepEqual(checkEntry('site', 'https://www.Reddit.com/r/x?y=1:8080'), { ok: true, value: 'reddit.com', changed: true });
  assert.deepEqual(checkEntry('site', 'reddit.com'), { ok: true, value: 'reddit.com', changed: false });
  assert.deepEqual(checkEntry('site', 'Reddit.com'), { ok: true, value: 'reddit.com', changed: false });
});

test('bad site entries get friendly messages', () => {
  for (const s of ['not a domain', 'localhost', '10.0.0.1']) {
    assert.deepEqual(checkEntry('site', s), { ok: false, message: BAD_SITE }, s);
  }
  for (const s of ['', '   ']) assert.deepEqual(checkEntry('site', s), { ok: false, message: EMPTY });
});

test('app entries', () => {
  assert.deepEqual(checkEntry('app', 'League of Legends.exe'), { ok: true, value: 'league of legends.exe', changed: false });
  assert.deepEqual(checkEntry('app', 'C:\\Games\\Steam.EXE'), { ok: true, value: 'steam.exe', changed: true });
  for (const s of ['a/b', 'x:y']) assert.deepEqual(checkEntry('app', s), { ok: false, message: BAD_APP }, s);
  assert.deepEqual(checkEntry('app', ''), { ok: false, message: EMPTY });
});

test('app inputs with no file name are rejected', () => {
  for (const s of ['C:\\Games\\', '.exe', '\\', '   .exe']) {
    assert.deepEqual(checkEntry('app', s), { ok: false, message: BAD_APP }, JSON.stringify(s));
  }
  assert.deepEqual(checkEntry('app', 'a.exe'), { ok: true, value: 'a.exe', changed: false });
});

test('starters pass checkEntry unchanged and have unique names', () => {
  assert.deepEqual(STARTERS.map((s) => s.name), ['Social media', 'News', 'Games']);
  assert.equal(new Set(STARTERS.map((s) => s.name)).size, STARTERS.length);
  for (const s of STARTERS) {
    for (const [kind, list] of [['site', s.sites], ['app', s.apps]]) {
      for (const v of list) {
        const r = checkEntry(kind, v);
        assert.ok(r.ok && !r.changed && r.value === v, `${kind} ${v}`);
      }
    }
  }
});

test('item vectors: never ok with a value validItem rejects; invalid vectors are rejected or repaired', () => {
  for (const v of vectors) {
    const r = checkEntry(v.kind, v.value);
    const label = `${v.kind} ${JSON.stringify(v.value)}`;
    if (r.ok) assert.ok(validItem(v.kind, r.value), label);
    if (v.valid) assert.ok(r.ok, label);
    else assert.ok(!r.ok || r.value !== v.value, label);
  }
});
