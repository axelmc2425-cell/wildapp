import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrate } from '../src/core/schema.js';
import { createNote } from '../src/modules/secondbrain/notes.js';
import { registerSearchProvider, searchAll, notesSearchProvider } from '../src/core/search.js';

async function fresh() {
  const db = await openNodeDb(join(mkdtempSync(join(tmpdir(), 'mybrain-')), 't.db'));
  await migrate(db);
  registerSearchProvider('notes', notesSearchProvider);
  return db;
}

test('searchAll puts title matches before body matches', async () => {
  const db = await fresh();
  await createNote(db, { title: 'Groceries', body: 'buy apple pie' });
  await createNote(db, { title: 'Apple', body: 'a fruit' });
  const hits = await searchAll(db, 'apple');
  assert.deepEqual(hits.map(h => h.title), ['Apple', 'Groceries']);
  assert.equal(hits[0].module, 'secondbrain');
});

test('a query of "%" matches only a literal percent sign', async () => {
  const db = await fresh();
  await createNote(db, { title: 'Plain', body: 'nothing here' });
  await createNote(db, { title: 'Sale', body: '50% off' });
  assert.deepEqual((await searchAll(db, '%')).map(h => h.title), ['Sale']);
});

test('empty query returns []', async () => {
  const db = await fresh();
  await createNote(db, { title: 'A' });
  assert.deepEqual(await searchAll(db, '   '), []);
});

test('snippet shows text around the match', async () => {
  const db = await fresh();
  await createNote(db, { title: 'Long', body: 'x'.repeat(200) + ' needle ' + 'y'.repeat(200) });
  const [hit] = await searchAll(db, 'needle');
  assert.ok(hit.snippet.includes('needle'));
  assert.ok(hit.snippet.length <= 120);
});
