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
  assert.equal(rows[0].value, '5');
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
  await db.run("CREATE TABLE focus_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, list_id INTEGER NOT NULL, weekdays TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, lock TEXT NOT NULL CHECK (lock IN ('none','locked','frozen')))");
  await db.run("INSERT INTO focus_meta(key, value) VALUES ('schema_version', '1')");
  for (const lock of ['none', 'locked', 'frozen']) {
    await db.run('INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (1, 10, 20, ?)', [lock]);
  }
  await migrateFocus(db);
  const rows = await db.all('SELECT * FROM focus_sessions ORDER BY id');
  assert.deepEqual(rows.map(r => r.lock), ['none', 'locked', 'frozen']);
  assert.ok(rows.every(r => r.unlock_delay_ms === null));
  const v = await db.all("SELECT value FROM focus_meta WHERE key='schema_version'");
  assert.equal(v[0].value, '5');
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
  await db.run('DROP TABLE focus_schedule_lists');
  await db.run('DROP TABLE focus_schedules');
  await db.run("CREATE TABLE focus_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, list_id INTEGER NOT NULL, weekdays TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, lock TEXT NOT NULL CHECK (lock IN ('none','locked','frozen')))");
  await db.run("UPDATE focus_meta SET value = '2' WHERE key = 'schema_version'");
  await migrateFocus(db);
  const rows = await db.all('SELECT kind, value FROM focus_items ORDER BY rowid');
  assert.deepEqual(rows.map(r => [r.kind, r.value]), [['site', 'a.com'], ['app', 'b.exe']]);
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1, 'folder', 'C:\\x')");
  await assert.rejects(db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1, 'nope', 'x')"));
  const v = await db.all("SELECT value FROM focus_meta WHERE key='schema_version'");
  assert.equal(v[0].value, '5');
});

async function v3Db() {
  const db = await fresh();
  await migrateFocus(db);
  await db.run('DROP TABLE focus_schedule_lists');
  await db.run('DROP TABLE focus_schedules');
  await db.run("CREATE TABLE focus_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, list_id INTEGER NOT NULL, weekdays TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, lock TEXT NOT NULL CHECK (lock IN ('none','locked','frozen')))");
  await db.run("INSERT INTO focus_schedules(list_id, weekdays, start_time, end_time, lock) VALUES (5, '[1,2]', '09:00', '17:00', 'none')");
  await db.run("UPDATE focus_meta SET value = '3' WHERE key = 'schema_version'");
  return db;
}

test('migrates a v3 database to v4 keeping the schedule and linking its list', async () => {
  const db = await v3Db();
  await migrateFocus(db);
  const v = await db.all("SELECT value FROM focus_meta WHERE key='schema_version'");
  assert.equal(v[0].value, '5');
  const [r] = await db.all('SELECT * FROM focus_schedules');
  assert.equal(r.name, '');
  assert.equal(r.enabled, 1);
  assert.equal(r.ends_on, null);
  assert.equal(r.unlock_delay_ms, null);
  assert.equal(r.weekdays, '[1,2]');
  const links = await db.all('SELECT schedule_id, list_id FROM focus_schedule_lists');
  assert.deepEqual(links.map(l => ({ ...l })), [{ schedule_id: r.id, list_id: 5 }]);
});

test('running migrateFocus twice on a v3 database changes nothing further', async () => {
  const db = await v3Db();
  await migrateFocus(db);
  const before = [await db.all('SELECT * FROM focus_schedules'), await db.all('SELECT * FROM focus_schedule_lists')];
  await migrateFocus(db);
  assert.deepEqual([await db.all('SELECT * FROM focus_schedules'), await db.all('SELECT * FROM focus_schedule_lists')], before);
});

test('migrating from v4 adds the limit tables and keeps schedule data', async () => {
  const db = await fresh();
  await migrateFocus(db);
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('L', 'block')");
  await db.run("INSERT INTO focus_schedules(list_id, weekdays, start_time, end_time, lock, name) VALUES (1, '[1]', '09:00', '10:00', 'none', 'S')");
  await db.run('DROP TABLE focus_limits');
  await db.run('DROP TABLE focus_limit_items');
  await db.run("UPDATE focus_meta SET value = '4' WHERE key = 'schema_version'");
  await migrateFocus(db);
  const names = (await db.all("SELECT name FROM sqlite_master WHERE type='table'")).map(r => r.name);
  assert.ok(names.includes('focus_limits') && names.includes('focus_limit_items'));
  assert.equal((await db.all('SELECT name FROM focus_schedules'))[0].name, 'S');
  assert.equal((await db.all("SELECT value FROM focus_meta WHERE key='schema_version'"))[0].value, '5');
  await db.run("INSERT INTO focus_limits(name, period, cap_secs) VALUES ('x', 'daily', 60)");
  assert.equal((await db.all('SELECT lock, enabled FROM focus_limits'))[0].lock, 'none');
});
