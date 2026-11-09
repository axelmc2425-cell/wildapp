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
  assert.equal(rows[0].value, '1');
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
