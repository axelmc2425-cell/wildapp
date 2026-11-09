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
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock, unlock_delay_ms) VALUES (1, ?, ?, 'locked', ?)", [NOW - H, NOW + H, H]);
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (1, ?, ?, 'none')", [NOW - 3 * H, NOW - 2 * H]);
  await db.run("INSERT INTO focus_schedules(list_id, weekdays, start_time, end_time, lock) VALUES (1, '[1]', '09:00', '10:00', 'none')");
  const r = rec();
  const res = await syncWindows(db, r.client, NOW, utc);
  const ws = r.pushed[0];
  // Mondays in [Jan 5 12:00, Feb 4 12:00): Jan 12, 19, 26, Feb 2 (Jan 5 9-10 already ended)
  assert.equal(ws.length, 5);
  assert.equal(res.pushed, 5);
  assert.equal(res.skipped, 0);
  assert.equal(ws.filter((w) => w.id === `b${NOW - H}-${NOW + H}-1`).length, 1);
  assert.ok(!ws.some((w) => w.id === 's2'));
  assert.equal(ws.filter((w) => w.id.startsWith('c1@')).length, 4);
  assert.deepEqual(ws.find((w) => w.id === `b${NOW - H}-${NOW + H}-1`).sites, ['x.com']);
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

test('frozen, allow-without-apps and bad-item windows are skipped and counted, never pushed', async () => {
  const db = await mk();
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('B','block')"); // 1
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('A','allow')"); // 2
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1,'site','x.com')");
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1,'app','League of Legends.exe')");
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (2,'site','docs.rs')");
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (1, ?, ?, 'frozen')", [NOW - H, NOW + H]); // s1
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (2, ?, ?, 'none')", [NOW - H, NOW + H]); // s2
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock, unlock_delay_ms) VALUES (1, ?, ?, 'locked', ?)", [NOW - H, NOW + H, H]); // ok
  const r = rec();
  const res = await syncWindows(db, r.client, NOW, utc);
  assert.deepEqual(res, { pushed: 1, skipped: 2 });
  assert.deepEqual(r.pushed[0].map((w) => w.id), [`b${NOW - H}-${NOW + H}-1`]);
  assert.deepEqual(r.pushed[0][0].apps, ['league of legends.exe']);
});

test('a window with a bad app entry is skipped, the rest still pushed', async () => {
  const db = await mk();
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('B','block')");
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1,'app','a:b')");
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('C','block')");
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (2,'site','ok.com')");
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (1, ?, ?, 'none')", [NOW - H, NOW + H]);
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (2, ?, ?, 'none')", [NOW - H, NOW + H]);
  const r = rec();
  assert.deepEqual(await syncWindows(db, r.client, NOW, utc), { pushed: 1, skipped: 1 });
  assert.deepEqual(r.pushed[0].map((w) => w.id), ['s2']);
});

async function twoLists() {
  const db = await mk();
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('A','block')");
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('B','block')");
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1,'site','a.com')");
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (2,'site','b.com')");
  return db;
}
const addLocked = (db, listId, starts, ends, delay = H) =>
  db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock, unlock_delay_ms) VALUES (?, ?, ?, 'locked', ?)", [listId, starts, ends, delay]);

test('sync pushes the merged window and counts it once', async () => {
  const db = await twoLists();
  await addLocked(db, 2, NOW - H, NOW + H);
  await addLocked(db, 1, NOW - H, NOW + H);
  const r = rec();
  const res = await syncWindows(db, r.client, NOW, utc);
  assert.deepEqual(res, { pushed: 1, skipped: 0 });
  const [w] = r.pushed[0];
  assert.equal(w.id, `b${NOW - H}-${NOW + H}-1.2`);
  assert.deepEqual(w.sites.sort(), ['a.com', 'b.com']);
  assert.equal(w.unlock_delay_ms, H);
  assert.equal(w.lock, 'locked');
});

test('same lists and times but lock none stay separate windows from a locked block', async () => {
  const db = await twoLists();
  await addLocked(db, 1, NOW - H, NOW + H);
  await addLocked(db, 2, NOW - H, NOW + H);
  await addSession(db, NOW - H, NOW + H); // none, list 1
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (2, ?, ?, 'none')", [NOW - H, NOW + H]);
  const r = rec();
  const res = await syncWindows(db, r.client, NOW, utc);
  assert.deepEqual(res, { pushed: 3, skipped: 0 });
  assert.deepEqual(r.pushed[0].map((w) => w.id).sort(), [`b${NOW - H}-${NOW + H}-1.2`, 's3', 's4'].sort());
});

test('locked sessions with different unlock delays or times form separate blocks', async () => {
  const db = await twoLists();
  await addLocked(db, 1, NOW - H, NOW + H, H);
  await addLocked(db, 2, NOW - H, NOW + H, 2 * H);
  await addLocked(db, 2, NOW - H, NOW + 2 * H, H);
  const r = rec();
  assert.deepEqual(await syncWindows(db, r.client, NOW, utc), { pushed: 3, skipped: 0 });
});

test('a locked session whose list was deleted is skipped; the rest of its block still pushes', async () => {
  const db = await twoLists();
  await addLocked(db, 1, NOW - H, NOW + H);
  await addLocked(db, 99, NOW - H, NOW + H);
  const r = rec();
  assert.deepEqual(await syncWindows(db, r.client, NOW, utc), { pushed: 1, skipped: 1 });
  assert.equal(r.pushed[0][0].id, `b${NOW - H}-${NOW + H}-1`);
});

test('a locked session without a valid unlock delay is skipped', async () => {
  const db = await twoLists();
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (1, ?, ?, 'locked')", [NOW - H, NOW + H]);
  const r = rec();
  assert.deepEqual(await syncWindows(db, r.client, NOW, utc), { pushed: 0, skipped: 1 });
});
