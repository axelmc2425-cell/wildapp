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
  for (const t of ['notes', 'tags', 'links']) assert.ok(names.includes(t), t);
});

test('migrate is idempotent when run twice', async () => {
  const db = await fresh();
  await migrate(db);
  await migrate(db);
  const [{ user_version }] = await db.all('PRAGMA user_version');
  assert.equal(user_version, 1);
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
  await db.run("INSERT INTO notes(title, body, created, updated) VALUES ('Foo', '', 1, 1)");
  await assert.rejects(db.run("INSERT INTO notes(title, body, created, updated) VALUES ('FOO', '', 1, 1)"));
});
