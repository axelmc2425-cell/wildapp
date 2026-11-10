import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { MAX_WINDOWS } from '../src/modules/focus/limits.js';
import { migrateFocus } from '../src/modules/focus/schema.js';
import { syncWindows, dedupeById } from '../src/modules/focus/sync.js';

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

async function addSched(db, { listIds = [1], weekdays = '[1]', start = '09:00', end = '10:00', lock = 'none', delay = null, endsOn = null, enabled = 1 } = {}) {
  await db.run(
    "INSERT INTO focus_schedules(list_id, name, weekdays, start_time, end_time, lock, ends_on, unlock_delay_ms, enabled) VALUES (?, 'S', ?, ?, ?, ?, ?, ?, ?)",
    [listIds[0], weekdays, start, end, lock, endsOn, delay, enabled]);
  const [{ id }] = await db.all('SELECT MAX(id) AS id FROM focus_schedules');
  for (const l of listIds) await db.run('INSERT INTO focus_schedule_lists(schedule_id, list_id) VALUES (?, ?)', [id, l]);
  return id;
}

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
  await addSched(db);
  const r = rec();
  const res = await syncWindows(db, r.client, NOW, utc);
  const ws = r.pushed[0];
  // Mondays in [Jan 5 12:00, Feb 4 12:00): Jan 12, 19, 26, Feb 2 (Jan 5 9-10 already ended)
  assert.equal(ws.length, 5);
  assert.equal(res.pushed, 5);
  assert.equal(res.skipped, 0);
  assert.equal(ws.filter((w) => w.id === `b${NOW - H}-1`).length, 1);
  assert.ok(!ws.some((w) => w.id === 's2'));
  assert.equal(ws.filter((w) => w.id.startsWith('c1@')).length, 4);
  assert.deepEqual(ws.find((w) => w.id === `b${NOW - H}-1`).sites, ['x.com']);
  assert.ok(ws.every((w) => w.ends > NOW && w.starts < NOW + 30 * DAY));
});

test('missing-list sessions and schedules are skipped and counted', async () => {
  const db = await mk();
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('L','block')");
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (99, ?, ?, 'none')", [NOW, NOW + H]);
  await addSched(db, { listIds: [99] });
  await addSched(db);
  const r = rec();
  const res = await syncWindows(db, r.client, NOW, utc);
  assert.equal(res.skipped, 2);
  assert.equal(res.pushed, 4);
});

test('schedule whose only list was deleted is skipped; multi-list schedule unions live lists', async () => {
  const db = await mk();
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('A','block')");
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('B','block')");
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1,'site','a.com')");
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (2,'site','b.com')");
  await addSched(db, { listIds: [1, 2] });
  await addSched(db, { listIds: [77] });
  const r = rec();
  const res = await syncWindows(db, r.client, NOW, utc);
  assert.deepEqual(res, { pushed: 4, skipped: 1 });
  assert.deepEqual(r.pushed[0][0].sites.sort(), ['a.com', 'b.com']);
});

test('locked schedule with a valid delay pushes with unlock_delay_ms; disabled and ended schedules push nothing', async () => {
  const db = await withList();
  await addSched(db, { lock: 'locked', delay: H });
  await addSched(db, { weekdays: '[2]', enabled: 0 });
  await addSched(db, { weekdays: '[3]', endsOn: '2026-01-01' });
  const r = rec();
  const res = await syncWindows(db, r.client, NOW, utc);
  assert.deepEqual(res, { pushed: 4, skipped: 0 });
  assert.ok(r.pushed[0].every((w) => w.lock === 'locked' && w.unlock_delay_ms === H));
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

test('a corrupt schedule row is skipped and counted; good schedules and locked sessions still push', async () => {
  const db = await withList();
  await addSched(db, { weekdays: 'not json' });
  await addSched(db, { weekdays: '[9]' });
  await addSched(db, { start: 'zz' });
  await addSched(db);
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock, unlock_delay_ms) VALUES (1, ?, ?, 'locked', ?)", [NOW - H, NOW + H, H]);
  const r = rec();
  assert.deepEqual(await syncWindows(db, r.client, NOW, utc), { pushed: 5, skipped: 3 });
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
  assert.deepEqual(r.pushed[0].map((w) => w.id), [`b${NOW - H}-1`]);
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
  assert.equal(w.id, `b${NOW - H}-1.2`);
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
  assert.deepEqual(r.pushed[0].map((w) => w.id).sort(), [`b${NOW - H}-1.2`, 's3', 's4'].sort());
});

test('locked sessions with different lists stay separate; same start and lists but different ends merge with the later end', async () => {
  const db = await twoLists();
  await addLocked(db, 1, NOW - H, NOW + H, H);
  await addLocked(db, 2, NOW - H, NOW + H, 2 * H);
  await addLocked(db, 1, NOW - H, NOW + 2 * H, H);
  const r = rec();
  assert.deepEqual(await syncWindows(db, r.client, NOW, utc), { pushed: 2, skipped: 0 });
  assert.equal(new Set(r.pushed[0].map((w) => w.id)).size, 2);
  assert.equal(r.pushed[0].find((w) => w.id.endsWith('-1')).ends, NOW + 2 * H);
});

for (const order of [[H, 2 * H], [2 * H, H]]) {
  test(`same list and times with delays ${order.join('/')} make one window with the longest delay`, async () => {
    const db = await twoLists();
    for (const d of order) await addLocked(db, 1, NOW - H, NOW + H, d);
    const r = rec();
    assert.deepEqual(await syncWindows(db, r.client, NOW, utc), { pushed: 1, skipped: 0 });
    assert.equal(r.pushed[0][0].unlock_delay_ms, 2 * H);
    assert.equal(r.pushed[0][0].id, `b${NOW - H}-1`);
  });
}

test('dedupeById keeps the longest delay then the later end and reports the dropped count', () => {
  const w = (id, d, ends) => ({ id, starts: 0, ends, unlock_delay_ms: d });
  const a = dedupeById([w('x', H, 5), w('x', 2 * H, 4), w('y', null, 1), w('x', 2 * H, 6)]);
  assert.equal(a.dropped, 2);
  assert.deepEqual(a.windows.map((v) => [v.id, v.unlock_delay_ms, v.ends]).sort(), [['x', 2 * H, 6], ['y', null, 1]]);
  const b = dedupeById([w('x', 2 * H, 6), w('x', H, 5), w('x', 2 * H, 4)]);
  assert.deepEqual(b.windows.map((v) => [v.unlock_delay_ms, v.ends]), [[2 * H, 6]]);
});

test('trimming to MAX_WINDOWS keeps locked windows over none windows', async () => {
  const db = await twoLists();
  for (let i = 0; i < MAX_WINDOWS; i++) await addSession(db, NOW + i * 1000, NOW + i * 1000 + 500);
  await addLocked(db, 1, NOW + 20 * DAY, NOW + 20 * DAY + H);
  const r = rec();
  const res = await syncWindows(db, r.client, NOW, utc);
  assert.deepEqual(res, { pushed: MAX_WINDOWS, skipped: 1 });
  assert.ok(r.pushed[0].some((w) => w.lock === 'locked'));
});

test('a locked session whose list was deleted is skipped; the rest of its block still pushes', async () => {
  const db = await twoLists();
  await addLocked(db, 1, NOW - H, NOW + H);
  await addLocked(db, 99, NOW - H, NOW + H);
  const r = rec();
  assert.deepEqual(await syncWindows(db, r.client, NOW, utc), { pushed: 1, skipped: 1 });
  assert.equal(r.pushed[0][0].id, `b${NOW - H}-1`);
});

test('a locked session without a valid unlock delay is skipped', async () => {
  const db = await twoLists();
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (1, ?, ?, 'locked')", [NOW - H, NOW + H]);
  const r = rec();
  assert.deepEqual(await syncWindows(db, r.client, NOW, utc), { pushed: 0, skipped: 1 });
});

test('folders are pushed as app_folders; a forbidden folder skips the window and counts it', async () => {
  const db = await mk();
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('G','block')");
  await db.run("INSERT INTO focus_lists(name, mode) VALUES ('W','block')");
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (1,'folder','C:\\Games\\Foo')");
  await db.run("INSERT INTO focus_items(list_id, kind, value) VALUES (2,'folder','C:\\Windows\\System32')");
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (1, ?, ?, 'none')", [NOW - H, NOW + H]);
  await db.run("INSERT INTO focus_sessions(list_id, starts, ends, lock) VALUES (2, ?, ?, 'none')", [NOW - H, NOW + H]);
  const r = rec();
  assert.deepEqual(await syncWindows(db, r.client, NOW, utc), { pushed: 1, skipped: 1 });
  assert.deepEqual(r.pushed[0].map((w) => w.id), ['s1']);
  assert.deepEqual(r.pushed[0][0].app_folders, ['C:\\Games\\Foo']);
});
