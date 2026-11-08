import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrate } from '../src/core/schema.js';

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'mybrain-'));
  return openNodeDb(join(dir, 'test.db'));
}

test('migrate creates tables', async () => {
  const db = await fresh();
  await migrate(db);
  const names = (await db.all("SELECT name FROM sqlite_master WHERE type='table'")).map(r => r.name);
  for (const t of ['notes', 'tags', 'links', 'settings', 'focus_sessions', 'pantry', 'recipes', 'scenarios', 'skills', 'practice', 'cards', 'albums', 'photos', 'journal']) assert.ok(names.includes(t), t);
});

test('migrate is idempotent when run twice', async () => {
  const db = await fresh();
  await migrate(db);
  await migrate(db);
  const [{ user_version }] = await db.all('PRAGMA user_version');
  assert.equal(user_version, 8);
});

test('batch rolls back everything when one statement fails', async () => {
  const db = await fresh();
  await migrate(db);
  await assert.rejects(db.batch([
    { sql: "INSERT INTO notes(title, body, created, updated) VALUES (?, '', 1, 1)", params: ['A'] },
    { sql: 'INSERT INTO nope VALUES (1)' },
  ]));
  assert.equal((await db.all('SELECT * FROM notes')).length, 0);
});

test('run returns lastInsertId', async () => {
  const db = await fresh();
  await migrate(db);
  const r = await db.run("INSERT INTO notes(title, body, created, updated) VALUES ('A', '', 1, 1)");
  assert.equal(r.lastInsertId, 1);
  assert.equal(r.changes, 1);
});

test('note titles are unique ignoring case', async () => {
  const db = await fresh();
  await migrate(db);
  await db.run("INSERT INTO notes(title, title_key, body, created, updated) VALUES ('Foo', 'foo', '', 1, 1)");
  await assert.rejects(db.run("INSERT INTO notes(title, title_key, body, created, updated) VALUES ('FOO', 'foo', '', 1, 1)"));
});

test('migrate upgrades a v1 database, folding non-ASCII titles', async () => {
  const db = await fresh();
  await db.batch([
    { sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT \'\', created INTEGER NOT NULL, updated INTEGER NOT NULL)' },
    { sql: 'CREATE UNIQUE INDEX notes_title_ci ON notes(lower(title))' },
    { sql: 'CREATE TABLE tags (note_id INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (note_id, tag))' },
    { sql: 'CREATE TABLE links (from_type TEXT NOT NULL, from_id INTEGER NOT NULL, to_type TEXT NOT NULL, to_id INTEGER NOT NULL, PRIMARY KEY (from_type, from_id, to_type, to_id))' },
    { sql: "INSERT INTO notes(title, body, created, updated) VALUES ('Élan', 'x', 1, 1)" },
  ]);
  await db.run('PRAGMA user_version = 1');
  await migrate(db);
  const [{ user_version }] = await db.all('PRAGMA user_version');
  assert.equal(user_version, 8);
  assert.equal((await db.all('SELECT title_key FROM notes'))[0].title_key, 'élan');
  await assert.rejects(db.run("INSERT INTO notes(title, title_key, body, created, updated) VALUES ('élan', 'élan', '', 1, 1)"));
});
