import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrate } from '../src/core/schema.js';
import {
  createNote, saveNote, getNote, findNoteByTitle, listNotes, deleteNote, backlinks, unresolvedLinks,
} from '../src/modules/secondbrain/notes.js';

async function fresh() {
  const db = await openNodeDb(join(mkdtempSync(join(tmpdir(), 'mybrain-')), 't.db'));
  await migrate(db);
  return db;
}

test('createNote rejects a title that differs only by case', async () => {
  const db = await fresh();
  await createNote(db, { title: 'Foo' });
  await assert.rejects(createNote(db, { title: 'FOO' }), /duplicate title/);
});

test('createNote rejects an empty title', async () => {
  const db = await fresh();
  await assert.rejects(createNote(db, { title: '   ' }), /empty title/);
});

test('saving a note linking [[Foo]] creates a backlink on Foo', async () => {
  const db = await fresh();
  const foo = await createNote(db, { title: 'Foo' });
  const a = await createNote(db, { title: 'A' });
  await saveNote(db, a.id, { body: 'see [[Foo]]' });
  assert.deepEqual((await backlinks(db, foo.id)).map(n => n.title), ['A']);
});

test('link resolution is case-insensitive', async () => {
  const db = await fresh();
  const foo = await createNote(db, { title: 'Foo' });
  const a = await createNote(db, { title: 'A' });
  await saveNote(db, a.id, { body: 'see [[foo]]' });
  assert.equal((await backlinks(db, foo.id)).length, 1);
});

test('creating "Bar" later links notes that already mention [[Bar]]', async () => {
  const db = await fresh();
  const a = await createNote(db, { title: 'A', body: 'needs [[Bar]]' });
  assert.deepEqual(await unresolvedLinks(a.body, db), ['Bar']);
  const bar = await createNote(db, { title: 'Bar' });
  assert.deepEqual((await backlinks(db, bar.id)).map(n => n.title), ['A']);
  assert.deepEqual(await unresolvedLinks(a.body, db), []);
});

test('renaming a note to a mentioned title links the mentioning notes', async () => {
  const db = await fresh();
  await createNote(db, { title: 'A', body: 'needs [[Bar]]' });
  const x = await createNote(db, { title: 'X' });
  await saveNote(db, x.id, { title: 'Bar' });
  assert.deepEqual((await backlinks(db, x.id)).map(n => n.title), ['A']);
});

test('a self-link is not its own backlink', async () => {
  const db = await fresh();
  const a = await createNote(db, { title: 'A' });
  await saveNote(db, a.id, { body: 'me [[A]]' });
  assert.deepEqual(await backlinks(db, a.id), []);
});

test('deleteNote removes links both ways and the link shows as unresolved', async () => {
  const db = await fresh();
  const foo = await createNote(db, { title: 'Foo' });
  const a = await createNote(db, { title: 'A' });
  await saveNote(db, a.id, { body: 'see [[Foo]]' });
  await deleteNote(db, foo.id);
  assert.equal(await getNote(db, foo.id), null);
  assert.deepEqual(await unresolvedLinks('see [[Foo]]', db), ['Foo']);
  assert.equal((await db.all('SELECT * FROM links')).length, 0);
  await deleteNote(db, a.id);
  assert.equal((await db.all('SELECT * FROM tags')).length, 0);
});

test('listNotes filters by tag and newest first', async () => {
  const db = await fresh();
  const a = await createNote(db, { title: 'A', body: '#x' });
  await createNote(db, { title: 'B', body: '#y' });
  await createNote(db, { title: 'C', body: '#x' });
  assert.deepEqual((await listNotes(db, { tag: 'x' })).map(n => n.title), ['C', 'A']);
  assert.deepEqual(a.tags, ['x']);
});

test('saving with a clashing title leaves the old row intact', async () => {
  const db = await fresh();
  await createNote(db, { title: 'Taken' });
  const a = await createNote(db, { title: 'A', body: 'orig #t' });
  await assert.rejects(saveNote(db, a.id, { title: 'taken', body: 'new' }), /duplicate title/);
  const again = await getNote(db, a.id);
  assert.equal(again.title, 'A');
  assert.equal(again.body, 'orig #t');
  assert.deepEqual(again.tags, ['t']);
});

test('findNoteByTitle is case-insensitive', async () => {
  const db = await fresh();
  await createNote(db, { title: 'Foo' });
  assert.equal((await findNoteByTitle(db, 'fOO')).title, 'Foo');
  assert.equal(await findNoteByTitle(db, 'nope'), null);
});

test('removing a link from the body removes the backlink', async () => {
  const db = await fresh();
  const foo = await createNote(db, { title: 'Foo' });
  const a = await createNote(db, { title: 'A', body: '[[Foo]]' });
  await saveNote(db, a.id, { body: 'nothing' });
  assert.deepEqual(await backlinks(db, foo.id), []);
});
