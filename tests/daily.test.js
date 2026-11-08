import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrate } from '../src/core/schema.js';
import { dailyTitle, openDailyNote } from '../src/modules/secondbrain/daily.js';
import { listNotes } from '../src/modules/secondbrain/notes.js';

async function fresh() {
  const db = await openNodeDb(join(mkdtempSync(join(tmpdir(), 'mybrain-')), 't.db'));
  await migrate(db);
  return db;
}

test('dailyTitle uses the local date', () => {
  assert.equal(dailyTitle(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(dailyTitle(new Date(2026, 11, 31, 0, 1)), '2026-12-31');
});

test('openDailyNote called twice returns the same note', async () => {
  const db = await fresh();
  const d = new Date(2026, 5, 1);
  const a = await openDailyNote(db, d);
  const b = await openDailyNote(db, d);
  assert.equal(a.id, b.id);
  assert.equal((await listNotes(db)).length, 1);
});

test('the daily note is created from the template', async () => {
  const db = await fresh();
  const n = await openDailyNote(db, new Date(2026, 5, 1));
  assert.equal(n.title, '2026-06-01');
  assert.equal(n.body, '# 2026-06-01\n\n## Today\n\n## Notes\n');
});
