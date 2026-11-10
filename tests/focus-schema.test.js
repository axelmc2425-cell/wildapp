import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrateFocus } from '../src/modules/focus/schema.js';

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'mybrain-'));
  return openNodeDb(join(dir, 'test.db'));
}

test('migrateFocus creates all six tables', async () => {
  const db = await fresh();
  await migrateFocus(db);
  const names = (await db.all("SELECT name FROM sqlite_master WHERE type='table'")).map(r => r.name);
  for (const t of ['focus_lists', 'focus_items', 'focus_sessions', 'focus_schedules', 'focus_usage', 'focus_partner']) {
    assert.ok(names.includes(t), t);
  }
});

test('migrateFocus is idempotent when run twice', async () => {
  const db = await fresh();
  await migrateFocus(db);
  await migrateFocus(db);
  const rows = await db.all("SELECT value FROM focus_meta WHERE key='schema_version'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, '3');
});

test("inserting a list with mode 'nope' is rejected", async () => {
  const db = await fresh();
  await migrateFocus(db);
  await assert.rejects(db.run("INSERT INTO focus_lists(name, mode) VALUES ('x', 'nope')"));
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('x', 'block')");
});

test("inserting a session with lock 'weird' is rejected", async () => {
  const db = await fresh();
  await migrateFocus(db);
  await assert.rejects(db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (1, 1, 2, 'weird')"));
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (1, 1, 2, 'frozen')");
});

test('migrates a v1 database to v2 keeping existing rows', async () => {
  const db = await fresh();
  await db.run('CREATE TABLE focus_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  await db.run('CREATE TABLE focus_lists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, mode TEXT NOT NULL)');
  await db.run("CREATE TABLE focus_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, list_id INTEGER NOT NULL, starts INTEGER NOT NULL, ends INTEGER NOT NULL, lock TEXT NOT NULL CHECK (lock IN ('none','locked','frozen')))");
  await db.run("CREATE TABLE focus_items (list_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('site','app')), value TEXT NOT NULL)");
  await db.run("INSERT INTO focus_meta(key, value) VALUES ('schema_version', '1')");
  for (const lock of ['none', 'locked', 'frozen']) {
    await db.run('INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (1, 10, 20, ?)', [lock]);
  }
  await migrateFocus(db);
  const rows = await db.all('SELECT * FROM focus_sessions ORDER BY id');
  assert.deepEqual(rows.map(r => r.lock), ['none', 'locked', 'frozen']);
  assert.ok(rows.every(r => r.unlock_delay_ms === null));
  const v = await db.all("SELECT value FROM focus_meta WHERE key='schema_version'");
  assert.equal(v[0].value, '3');
});

test('fresh database has a nullable unlock_delay_ms column', async () => {
  const db = await fresh();
  await migrateFocus(db);
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (1, 1, 2, 'none')");
  const rows = await db.all('SELECT unlock_delay_ms FROM focus_sessions');
  assert.equal(rows[0].unlock_delay_ms, null);
});

test('migrates a v2 database to v3 keeping items and allowing folder items', async () => {
  const db = await fresh();
  await migrateFocus(db);
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('x', 'block')");
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1, 'site', 'a.com')");
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1, 'app', 'b.exe')");
  await db.run("DROP TABLE focus_items");
  await db.run("CREATE TABLE focus_items (list_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('site','app')), value TEXT NOT NULL)");
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1, 'site', 'a.com')");
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1, 'app', 'b.exe')");
  await assert.rejects(db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1, 'folder', 'C:\\x')"));
  await db.run("UPDATE focus_meta SET value = '2' WHERE key = 'schema_version'");
  await migrateFocus(db);
  const rows = await db.all('SELECT kind, value FROM focus_items ORDER BY rowid');
  assert.deepEqual(rows.map(r => [r.kind, r.value]), [['site', 'a.com'], ['app', 'b.exe']]);
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1, 'folder', 'C:\\x')");
  await assert.rejects(db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1, 'nope', 'x')"));
  const v = await db.all("SELECT value FROM focus_meta WHERE key='schema_version'");
  assert.equal(v[0].value, '3');
});
