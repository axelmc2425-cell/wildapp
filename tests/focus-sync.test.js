import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrateFocus } from '../src/modules/focus/schema.js';
import { syncWindows } from '../src/modules/focus/sync.js';

const H = 3600000;
const DAY = 86400000;
const utc = () => 0;
async function mk() {
  const db = await openNodeDb(join(mkdtempSync(join(tmpdir(), 'focus-sync-')), 't.db'));
  await migrateFocus(db);
  return db;
}
function rec() {
  const pushed = [];
  return { pushed, client: { pushWindows: async (w) => { pushed.push(w); return { type: 'Ok' }; } } };
}
const NOW = Date.UTC(2026, 0, 5, 12); // Monday

test('empty db pushes []', async () => {
  const db = await mk();
  const r = rec();
  assert.deepEqual(await syncWindows(db, r.client, NOW, utc), { pushed: 0, skipped: 0 });
  assert.deepEqual(r.pushed, [[]]);
});

test('session and weekly schedule; finished sessions dropped', async () => {
  const db = await mk();
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('L','block')");
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1,'site','x.com')");
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (1, ?, ?, 'locked')", [NOW - H, NOW + H]);
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (1, ?, ?, 'none')", [NOW - 3 * H, NOW - 2 * H]);
  await db.run("INSERT INTO focus_schedules(list_id, weekdays, start_time, end_time, lock) VALUES (1, '[1]', '09:00', '10:00', 'none')");
  const r = rec();
  const res = await syncWindows(db, r.client, NOW, utc);
  const ws = r.pushed[0];
  // Mondays in [Jan 5 12:00, Feb 4 12:00): Jan 12, 19, 26, Feb 2 (Jan 5 9-10 already ended)
  assert.equal(ws.length, 5);
  assert.equal(res.pushed, 5);
  assert.equal(res.skipped, 0);
  assert.equal(ws.filter((w) => w.id === 's1').length, 1);
  assert.ok(!ws.some((w) => w.id === 's2'));
  assert.equal(ws.filter((w) => w.id.startsWith('c1@')).length, 4);
  assert.deepEqual(ws.find((w) => w.id === 's1').sites, ['x.com']);
  assert.ok(ws.every((w) => w.ends > NOW && w.starts < NOW + 30 * DAY));
});

test('malformed rows and missing lists are skipped and counted', async () => {
  const db = await mk();
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('L','block')");
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (99, ?, ?, 'none')", [NOW, NOW + H]);
  await db.run("INSERT INTO focus_schedules(list_id, weekdays, start_time, end_time, lock) VALUES (1, 'not json', '09:00', '10:00', 'none')");
  await db.run("INSERT INTO focus_schedules(list_id, weekdays, start_time, end_time, lock) VALUES (1, '[1]', 'zz', '10:00', 'none')");
  await db.run("INSERT INTO focus_schedules(list_id, weekdays, start_time, end_time, lock) VALUES (1, '[1]', '09:00', '10:00', 'none')");
  const r = rec();
  const res = await syncWindows(db, r.client, NOW, utc);
  assert.equal(res.skipped, 3);
  assert.equal(res.pushed, 4);
});

async function withList() {
  const db = await mk();
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('L','block')");
  return db;
}
const addSession = (db, starts, ends, lock = 'none') =>
  db.run('INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (1, ?, ?, ?)', [starts, ends, lock]);

test('invalid sessions are skipped and counted, valid ones still push', async () => {
  const db = await withList();
  await addSession(db, NOW + H, NOW + 2 * H);
  await addSession(db, NOW + 2 * H, NOW + H);
  await addSession(db, NOW, NOW + 8 * DAY, 'locked');
  await addSession(db, NOW, NOW + DAY + H, 'frozen');
  const r = rec();
  const res = await syncWindows(db, r.client, NOW, utc);
  assert.deepEqual(res, { pushed: 1, skipped: 3 });
  assert.deepEqual(r.pushed[0].map((w) => w.id), ['s1']);
});

test('horizon and ended boundaries', async () => {
  const db = await withList();
  await addSession(db, NOW + 30 * DAY + 1, NOW + 30 * DAY + H);
  await addSession(db, NOW + 30 * DAY, NOW + 30 * DAY + H);
  await addSession(db, NOW - H, NOW);
  await addSession(db, NOW + 30 * DAY - 1, NOW + 30 * DAY + H);
  const r = rec();
  const res = await syncWindows(db, r.client, NOW, utc);
  assert.deepEqual(res, { pushed: 1, skipped: 0 });
  assert.deepEqual(r.pushed[0].map((w) => w.id), ['s4']);
});

test('out-of-range weekday skips the schedule', async () => {
  const db = await withList();
  await db.run("INSERT INTO focus_schedules(list_id, weekdays, start_time, end_time, lock) VALUES (1, '[1, 9]', '09:00', '10:00', 'none')");
  const r = rec();
  assert.deepEqual(await syncWindows(db, r.client, NOW, utc), { pushed: 0, skipped: 1 });
});
