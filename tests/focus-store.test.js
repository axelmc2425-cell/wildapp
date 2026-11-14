import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrateFocus } from '../src/modules/focus/schema.js';
import {
  listLists, saveList, deleteList, createSessions, setSessionsEnd,
  deleteSessions, listSessions, purgeFinished,
  listSchedules, listSchedulesChecked, saveSchedule, setScheduleEnabled, deleteSchedule, scheduleHoldsList,
} from '../src/modules/focus/store.js';

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'focus-store-'));
  const db = await openNodeDb(join(dir, 'test.db'));
  await migrateFocus(db);
  return db;
}

test('saveList stores normalized sites and apps and returns the id', async () => {
  const db = await fresh();
  const r = await saveList(db, { name: ' Study ', sites: ['youtube.com'], apps: ['steam.exe'] });
  assert.equal(r.ok, true);
  assert.equal(typeof r.id, 'number');
  const lists = await listLists(db);
  assert.deepEqual(lists, [{ id: r.id, name: 'Study', mode: 'block', sites: ['youtube.com'], apps: ['steam.exe'], folders: [] }]);
});

test('saveList normalizes "https://www.Reddit.com/r/x?y=1" to "reddit.com" and keeps "League of Legends.exe"', async () => {
  const db = await fresh();
  const r = await saveList(db, { name: 'A', sites: ['https://www.Reddit.com/r/x?y=1', 'https://Example.com:8080/p'], apps: ['League of Legends.exe', 'C:\\Games\\Steam.EXE'] });
  assert.equal(r.ok, true);
  const [l] = await listLists(db);
  assert.deepEqual(l.sites, ['reddit.com', 'example.com']);
  assert.deepEqual(l.apps, ['league of legends.exe', 'steam.exe']);
});

test('saveList collapses duplicates after normalization', async () => {
  const db = await fresh();
  await saveList(db, { name: 'A', sites: ['reddit.com', 'WWW.Reddit.com', 'https://reddit.com/x', 'a.com'], apps: ['x.exe', 'X.EXE'] });
  const [l] = await listLists(db);
  assert.deepEqual(l.sites, ['reddit.com', 'a.com']);
  assert.deepEqual(l.apps, ['x.exe']);
});

test('saveList rejects an empty name, a 61-character name and a duplicate name differing only by case', async () => {
  const db = await fresh();
  assert.deepEqual(await saveList(db, { name: '   ', sites: [], apps: [] }), { ok: false, errors: { name: 'Give the list a name.' } });
  assert.deepEqual(await saveList(db, { name: 'x'.repeat(61), sites: [], apps: [] }), { ok: false, errors: { name: 'Keep the name under 60 characters.' } });
  assert.equal((await saveList(db, { name: 'x'.repeat(60), sites: [], apps: [] })).ok, true);
  const a = await saveList(db, { name: 'Focus', sites: [], apps: [] });
  assert.equal(a.ok, true);
  const dup = await saveList(db, { name: 'fOCUS', sites: [], apps: [] });
  assert.deepEqual(dup, { ok: false, errors: { name: 'A list with this name already exists.' } });
  // renaming itself by case only is fine
  assert.equal((await saveList(db, { id: a.id, name: 'FOCUS', sites: [], apps: [] })).ok, true);
});

test('saveList reports each bad entry with its value and a message and saves nothing', async () => {
  const db = await fresh();
  const r = await saveList(db, { name: 'A', sites: ['ok.com', 'not a site', '   '], apps: ['.exe', 'good.exe', 'a/b.exe'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.sites.map(e => e.value), ['not a site', '   ']);
  assert.ok(r.errors.sites.every(e => typeof e.message === 'string' && e.message));
  assert.deepEqual(r.errors.apps.map(e => e.value), ['.exe', 'a/b.exe']);
  assert.deepEqual(await listLists(db), []);
});

test('saveList rejects more than 512 items', async () => {
  const db = await fresh();
  const sites = Array.from({ length: 513 }, (_, i) => `s${i}.com`);
  const r = await saveList(db, { name: 'A', sites, apps: [] });
  assert.deepEqual(r, { ok: false, errors: { items: 'A list can hold up to 512 entries.' } });
  assert.deepEqual(await listLists(db), []);
  const ok = await saveList(db, { name: 'A', sites: sites.slice(0, 500), apps: Array.from({ length: 12 }, (_, i) => `a${i}.exe`) });
  assert.equal(ok.ok, true);
});

test('saveList with an id replaces items atomically (a failing second statement leaves the old items)', async () => {
  const db = await fresh();
  const { id } = await saveList(db, { name: 'A', sites: ['old.com'], apps: ['old.exe'] });
  const failing = { ...db, batch: (stmts) => db.batch([...stmts, { sql: 'INSERT INTO no_such_table VALUES (1)' }]) };
  await assert.rejects(saveList(failing, { id, name: 'B', sites: ['new.com'], apps: [] }));
  assert.deepEqual(await listLists(db), [{ id, name: 'A', mode: 'block', sites: ['old.com'], apps: ['old.exe'], folders: [] }]);
  const r = await saveList(db, { id, name: 'B', sites: ['new.com'], apps: [] });
  assert.deepEqual(r, { ok: true, id });
  assert.deepEqual(await listLists(db), [{ id, name: 'B', mode: 'block', sites: ['new.com'], apps: [], folders: [] }]);
});

test('listLists sorts by lowercase name and keeps items separate per list', async () => {
  const db = await fresh();
  await saveList(db, { name: 'beta', sites: ['b.com'], apps: [] });
  await saveList(db, { name: 'Alpha', sites: ['a.com'], apps: ['a.exe'] });
  const lists = await listLists(db);
  assert.deepEqual(lists.map(l => l.name), ['Alpha', 'beta']);
  assert.deepEqual(lists[0].sites, ['a.com']);
  assert.deepEqual(lists[1].apps, []);
});

test('deleteList refuses while a session has ends > now and succeeds after it ended, removing sessions and items', async () => {
  const db = await fresh();
  const { id } = await saveList(db, { name: 'A', sites: ['a.com'], apps: [] });
  const other = await saveList(db, { name: 'B', sites: ['b.com'], apps: [] });
  await createSessions(db, { listIds: [id, other.id], starts: 100, ends: 200 });
  assert.deepEqual(await deleteList(db, id, 150), { ok: false, reason: 'running' });
  assert.equal((await listLists(db)).length, 2);
  assert.deepEqual(await deleteList(db, id, 200), { ok: true });
  assert.deepEqual((await listLists(db)).map(l => l.id), [other.id]);
  assert.equal((await db.all('SELECT * FROM focus_items WHERE list_id = ?', [id])).length, 0);
  assert.deepEqual((await listSessions(db)).map(s => s.listId), [other.id]);
});

test('createSessions writes one row per list and rejects ends <= starts', async () => {
  const db = await fresh();
  const a = await saveList(db, { name: 'A', sites: [], apps: [] });
  const b = await saveList(db, { name: 'B', sites: [], apps: [] });
  const ids = await createSessions(db, { listIds: [a.id, b.id], starts: 10, ends: 20 });
  assert.equal(ids.length, 2);
  const s = await listSessions(db);
  assert.deepEqual(s, [
    { id: ids[0], listId: a.id, starts: 10, ends: 20, lock: 'none', unlockDelayMs: null },
    { id: ids[1], listId: b.id, starts: 10, ends: 20, lock: 'none', unlockDelayMs: null },
  ]);
  await assert.rejects(createSessions(db, { listIds: [a.id], starts: 5, ends: 5 }), /bad times/);
  await assert.rejects(createSessions(db, { listIds: [a.id], starts: 6, ends: 5 }), /bad times/);
  assert.equal((await listSessions(db)).length, 2);
});

test('setSessionsEnd and deleteSessions change only the given ids', async () => {
  const db = await fresh();
  const a = await saveList(db, { name: 'A', sites: [], apps: [] });
  const ids = await createSessions(db, { listIds: [a.id, a.id, a.id], starts: 1, ends: 10 });
  await setSessionsEnd(db, [ids[0], ids[1]], 50);
  assert.deepEqual((await listSessions(db)).map(s => s.ends), [50, 50, 10]);
  await deleteSessions(db, [ids[1]]);
  assert.deepEqual((await listSessions(db)).map(s => s.id), [ids[0], ids[2]]);
  await setSessionsEnd(db, [], 5);
  await deleteSessions(db, []);
  assert.equal((await listSessions(db)).length, 2);
});

test('purgeFinished removes only sessions older than keepMs', async () => {
  const db = await fresh();
  const a = await saveList(db, { name: 'A', sites: [], apps: [] });
  const now = 1_000_000_000;
  const [old, recent, running] = await createSessions(db, { listIds: [a.id, a.id, a.id], starts: 1, ends: 2 });
  await setSessionsEnd(db, [old], now - 86400000 - 1);
  await setSessionsEnd(db, [recent], now - 86400000);
  await setSessionsEnd(db, [running], now + 1000);
  assert.equal(await purgeFinished(db, now), 1);
  assert.deepEqual((await listSessions(db)).map(s => s.id), [recent, running]);
  assert.equal(await purgeFinished(db, now, 1000), 1);
  assert.deepEqual((await listSessions(db)).map(s => s.id), [running]);
});

// ---- locked sessions ----
import { endLockedSessions } from '../src/modules/focus/store.js';

const HOUR = 3600000;

test('creates a locked session with its delay and reads it back', async () => {
  const db = await fresh();
  const { id } = await saveList(db, { name: 'L', sites: ['a.com'], apps: [] });
  const [sid] = await createSessions(db, { listIds: [id], starts: 100, ends: 100 + 2 * HOUR, lock: 'locked', unlockDelayMs: HOUR });
  assert.deepEqual(await listSessions(db), [{ id: sid, listId: id, starts: 100, ends: 100 + 2 * HOUR, lock: 'locked', unlockDelayMs: HOUR }]);
  const [n] = await createSessions(db, { listIds: [id], starts: 1, ends: 2 });
  assert.deepEqual((await listSessions(db)).find(s => s.id === n), { id: n, listId: id, starts: 1, ends: 2, lock: 'none', unlockDelayMs: null });
});

test('createSessions rejects invalid locked input and writes nothing', async () => {
  const db = await fresh();
  const { id } = await saveList(db, { name: 'L', sites: [], apps: [] });
  await assert.rejects(createSessions(db, { listIds: [id], starts: 0, ends: HOUR, lock: 'locked' }));
  await assert.rejects(createSessions(db, { listIds: [id], starts: 0, ends: HOUR, lock: 'locked', unlockDelayMs: 5 }));
  await assert.rejects(createSessions(db, { listIds: [id], starts: 0, ends: 8 * 24 * HOUR, lock: 'locked', unlockDelayMs: HOUR }));
  await assert.rejects(createSessions(db, { listIds: [id], starts: 0, ends: HOUR, lock: 'none', unlockDelayMs: HOUR }));
  assert.deepEqual(await listSessions(db), []);
});

test('deleteSessions refuses locked rows and deletes none rows', async () => {
  const db = await fresh();
  const { id } = await saveList(db, { name: 'L', sites: [], apps: [] });
  const [n] = await createSessions(db, { listIds: [id], starts: 1, ends: 2 });
  const [l] = await createSessions(db, { listIds: [id], starts: 1, ends: HOUR, lock: 'locked', unlockDelayMs: HOUR });
  await assert.rejects(deleteSessions(db, [n, l]), /locked/);
  assert.equal((await listSessions(db)).length, 2);
  await deleteSessions(db, [n]);
  assert.deepEqual((await listSessions(db)).map(s => s.id), [l]);
});

test('endLockedSessions removes locked rows', async () => {
  const db = await fresh();
  const { id } = await saveList(db, { name: 'L', sites: [], apps: [] });
  const [l] = await createSessions(db, { listIds: [id], starts: 1, ends: HOUR, lock: 'locked', unlockDelayMs: HOUR });
  await endLockedSessions(db, [l]);
  assert.deepEqual(await listSessions(db), []);
});

test('saveList refuses editing a list in a running locked block', async () => {
  const db = await fresh();
  const { id } = await saveList(db, { name: 'L', sites: ['a.com'], apps: [] });
  await createSessions(db, { listIds: [id], starts: 100, ends: 100 + 2 * HOUR, lock: 'locked', unlockDelayMs: HOUR });
  const r = await saveList(db, { id, name: 'L', sites: ['b.com'], apps: [] }, 200);
  assert.equal(r.ok, false);
  assert.equal(r.errors.name, 'That list is part of a locked block.');
  assert.equal(r.kind, 'block');
  assert.equal(r.lockedUntil, 100 + 2 * HOUR);
  assert.deepEqual((await listLists(db))[0].sites, ['a.com']);
});

test('saveList allows editing after the locked block ended', async () => {
  const db = await fresh();
  const { id } = await saveList(db, { name: 'L', sites: ['a.com'], apps: [] });
  await createSessions(db, { listIds: [id], starts: 100, ends: 100 + 2 * HOUR, lock: 'locked', unlockDelayMs: HOUR });
  const r = await saveList(db, { id, name: 'L', sites: ['b.com'], apps: [] }, 100 + 2 * HOUR);
  assert.equal(r.ok, true);
});

test('a normal running block does not block editing', async () => {
  const db = await fresh();
  const { id } = await saveList(db, { name: 'L', sites: ['a.com'], apps: [] });
  await createSessions(db, { listIds: [id], starts: 100, ends: 1000 });
  assert.equal((await saveList(db, { id, name: 'L', sites: ['b.com'], apps: [] }, 200)).ok, true);
});

test('deleteList refuses while a locked block is running', async () => {
  const db = await fresh();
  const { id } = await saveList(db, { name: 'L', sites: [], apps: [] });
  await createSessions(db, { listIds: [id], starts: 100, ends: 1000, lock: 'locked', unlockDelayMs: HOUR });
  assert.deepEqual(await deleteList(db, id, 200), { ok: false, reason: 'running' });
});

test('folders round trip, collapse duplicates and list under folders', async () => {
  const db = await fresh();
  const r = await saveList(db, { name: 'F', sites: ['a.com'], apps: ['x.exe'], folders: ['C:/Games/Foo/', 'C:\\Games\\Foo', 'D:\\Stuff'] });
  assert.equal(r.ok, true);
  const [l] = await listLists(db);
  assert.deepEqual(l.folders, ['C:\\Games\\Foo', 'D:\\Stuff']);
  assert.deepEqual(l.apps, ['x.exe']);
  assert.deepEqual(l.sites, ['a.com']);
});

test('an invalid folder gives errors.folders and saves nothing', async () => {
  const db = await fresh();
  const r = await saveList(db, { name: 'F', sites: [], apps: [], folders: ['C:\\Windows', 'relative\\x', 'C:\\ok'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.folders.map(e => e.value), ['C:\\Windows', 'relative\\x']);
  assert.ok(r.errors.folders.every(e => e.message));
  assert.deepEqual(await listLists(db), []);
});

test('the 512 cap counts folders', async () => {
  const db = await fresh();
  const sites = Array.from({ length: 510 }, (_, i) => `s${i}.com`);
  const folders = ['C:\\a', 'C:\\b', 'C:\\c'];
  assert.deepEqual(await saveList(db, { name: 'A', sites, apps: [], folders }), { ok: false, errors: { items: 'A list can hold up to 512 entries.' } });
  assert.equal((await saveList(db, { name: 'A', sites, apps: [], folders: folders.slice(0, 2) })).ok, true);
});

test('editing a list replaces its folders', async () => {
  const db = await fresh();
  const r = await saveList(db, { name: 'A', sites: [], apps: [], folders: ['C:\\a'] });
  await saveList(db, { id: r.id, name: 'A', sites: [], apps: [] });
  assert.deepEqual((await listLists(db))[0].folders, []);
});

// --- schedules ---
const NOW = Date.UTC(2026, 10, 10, 12);
const tz = () => 0;
const DAYMS = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

async function withList(db, name = 'L') {
  return (await saveList(db, { name, sites: ['a.com'], apps: [] })).id;
}
const sched = (listIds, over = {}) => ({
  name: 'Work', listIds, weekdays: [3, 1, 1, 2], start: '09:00', end: '17:00',
  lock: 'none', unlockDelayMs: null, endsOn: null, ...over,
});
const lockedSched = (listIds, endsOn, over = {}) =>
  sched(listIds, { lock: 'locked', unlockDelayMs: 3600000, endsOn, ...over });

test('saveSchedule creates a row and listSchedules round-trips it', async () => {
  const db = await fresh();
  const a = await withList(db, 'A'), b = await withList(db, 'B');
  const r = await saveSchedule(db, sched([b, a]), NOW, tz);
  assert.equal(r.ok, true);
  assert.deepEqual(await listSchedules(db), [{
    id: r.id, name: 'Work', listIds: [a, b].sort((x, y) => x - y), weekdays: [1, 2, 3],
    start: '09:00', end: '17:00', lock: 'none', unlockDelayMs: null, endsOn: null, enabled: true,
  }]);
  const [row] = await db.all('SELECT list_id FROM focus_schedules');
  assert.equal(row.list_id, Math.min(a, b));
});

test('saveSchedule returns validation errors', async () => {
  const db = await fresh();
  const a = await withList(db);
  const none = await saveSchedule(db, lockedSched([a], null), NOW, tz);
  assert.equal(none.ok, false);
  assert.ok(none.errors.endsOn);
  const far = await saveSchedule(db, lockedSched([a], ymd(NOW + 91 * DAYMS)), NOW, tz);
  assert.equal(far.ok, false);
  assert.ok(far.errors.endsOn);
  assert.equal((await listSchedules(db)).length, 0);
});

test('saveSchedule rejects an unknown list', async () => {
  const db = await fresh();
  const r = await saveSchedule(db, sched([999]), NOW, tz);
  assert.equal(r.ok, false);
  assert.ok(r.errors.listIds);
});

test('saveSchedule edits an unlocked schedule and keeps enabled', async () => {
  const db = await fresh();
  const a = await withList(db, 'A'), b = await withList(db, 'B');
  const { id } = await saveSchedule(db, sched([a]), NOW, tz);
  await setScheduleEnabled(db, id, false, NOW, tz);
  const r = await saveSchedule(db, { ...sched([b]), id, name: 'New' }, NOW, tz);
  assert.deepEqual(r, { ok: true, id });
  const [s] = await listSchedules(db);
  assert.equal(s.name, 'New');
  assert.deepEqual(s.listIds, [b]);
  assert.equal(s.enabled, false);
  assert.equal((await db.all('SELECT * FROM focus_schedule_lists')).length, 1);
});

test('a locked schedule cannot be edited, disabled or deleted before its end, then can be', async () => {
  const db = await fresh();
  const a = await withList(db);
  const endsOn = ymd(NOW + DAYMS);
  const { id } = await saveSchedule(db, lockedSched([a], endsOn), NOW, tz);
  const edit = await saveSchedule(db, { ...lockedSched([a], endsOn), id, name: 'X' }, NOW, tz);
  assert.equal(edit.ok, false);
  assert.equal(edit.errors.name, `That schedule is locked until ${endsOn}.`);
  assert.deepEqual(await setScheduleEnabled(db, id, false, NOW, tz), { ok: false, reason: 'locked' });
  assert.deepEqual(await deleteSchedule(db, id, NOW, tz), { ok: false, reason: 'locked' });
  const later = NOW + 3 * DAYMS;
  assert.deepEqual(await setScheduleEnabled(db, id, false, later, tz), { ok: true });
  assert.deepEqual(await deleteSchedule(db, id, later, tz), { ok: true });
  assert.equal((await listSchedules(db)).length, 0);
  assert.equal((await db.all('SELECT * FROM focus_schedule_lists')).length, 0);
});

test('missing schedules report missing', async () => {
  const db = await fresh();
  assert.deepEqual(await setScheduleEnabled(db, 42, true, NOW, tz), { ok: false, reason: 'missing' });
  assert.deepEqual(await deleteSchedule(db, 42, NOW, tz), { ok: false, reason: 'missing' });
});

test('an overnight occurrence running past the end date still holds the schedule', async () => {
  const db = await fresh();
  const a = await withList(db);
  const endsOn = ymd(NOW + DAYMS);           // Wed 2026-11-11
  const { id } = await saveSchedule(db, lockedSched([a], endsOn, { weekdays: [0, 1, 2, 3, 4, 5, 6], start: '22:00', end: '06:00' }), NOW, tz);
  const during = Date.UTC(2026, 10, 12, 2); // 02:00 the day after endsOn, inside the tail
  assert.deepEqual(await deleteSchedule(db, id, during, tz), { ok: false, reason: 'locked' });
  assert.equal(await scheduleHoldsList(db, a, during, tz), Date.UTC(2026, 10, 12, 6));
  assert.deepEqual(await deleteSchedule(db, id, Date.UTC(2026, 10, 12, 7), tz), { ok: true });
});

test('scheduleHoldsList returns the end of an active locked schedule only', async () => {
  const db = await fresh();
  const a = await withList(db, 'A'), b = await withList(db, 'B');
  await saveSchedule(db, lockedSched([a], ymd(NOW + DAYMS), { weekdays: [1] }), NOW, tz);
  await saveSchedule(db, sched([b]), NOW, tz);
  assert.equal(await scheduleHoldsList(db, a, NOW, tz), Date.UTC(2026, 10, 12));
  assert.equal(await scheduleHoldsList(db, b, NOW, tz), null);
  assert.equal(await scheduleHoldsList(db, a, NOW + 3 * DAYMS, tz), null);
});

test('saveList and deleteList refuse a list held by a locked schedule', async () => {
  const db = await fresh();
  const a = await withList(db);
  const endsOn = ymd(NOW + DAYMS);
  await saveSchedule(db, lockedSched([a], endsOn), NOW, tz);
  const r = await saveList(db, { id: a, name: 'Renamed', sites: [], apps: [] }, NOW, tz);
  assert.equal(r.ok, false);
  assert.equal(r.errors.name, 'That list is part of a locked schedule.');
  assert.equal(r.lockedUntil, Date.UTC(2026, 10, 12));
  assert.equal(r.kind, 'schedule');
  assert.deepEqual(await deleteList(db, a, NOW, tz), { ok: false, reason: 'locked-schedule', lockedUntil: Date.UTC(2026, 10, 12) });
  assert.equal((await listLists(db)).length, 1);
});

test('deleteList removes only the link when the schedule has other lists, else the schedule', async () => {
  const db = await fresh();
  const a = await withList(db, 'A'), b = await withList(db, 'B');
  const two = (await saveSchedule(db, sched([a, b]), NOW, tz)).id;
  const one = (await saveSchedule(db, sched([a], { name: 'Solo' }), NOW, tz)).id;
  assert.deepEqual(await deleteList(db, a, NOW, tz), { ok: true });
  const left = await listSchedules(db);
  assert.deepEqual(left.map(s => [s.id, s.listIds]), [[two, [b]]]);
  assert.ok(!left.some(s => s.id === one));
  assert.equal((await db.all('SELECT * FROM focus_schedule_lists')).length, 1);
});

test('listSchedules skips corrupt rows and listSchedulesChecked counts them', async () => {
  const db = await fresh();
  await saveList(db, { name: 'L', sites: ['a.com'], apps: [] });
  const ins = (wd, st = '09:00') => db.run("INSERT INTO focus_schedules(list_id, name, weekdays, start_time, end_time, lock, enabled) VALUES (1, 'S', ?, ?, '10:00', 'none', 1)", [wd, st]);
  await ins('not json'); await ins('[9]'); await ins('[1]', 'zz'); await ins('[1]');
  const { schedules, bad } = await listSchedulesChecked(db);
  assert.equal(bad, 3);
  assert.deepEqual(schedules.map(s => s.id), [4]);
  assert.deepEqual((await listSchedules(db)).map(s => s.id), [4]);
});

import { listLimits, saveLimit, deleteLimit, setLimitEnabled } from '../src/modules/focus/store.js';

const limitInput = (p = {}) => ({ name: 'Games', period: 'daily', capSecs: 3600, lock: 'none', unlockDelayMs: null, apps: ['Game.exe'], sites: ['https://www.YouTube.com/x'], ...p });

test('limits: save, list, update, toggle and delete round trip', async () => {
  const db = await fresh();
  const id = await saveLimit(db, limitInput());
  assert.deepEqual(await listLimits(db), [{
    id, name: 'Games', period: 'daily', capSecs: 3600, lock: 'none', unlockDelayMs: null,
    enabled: true, apps: ['game.exe'], sites: ['youtube.com'],
  }]);
  const id2 = await saveLimit(db, limitInput({ name: 'Two', lock: 'locked', unlockDelayMs: 3_600_000, apps: [], sites: ['a.com', 'b.com'] }));
  assert.notEqual(id2, id);
  assert.equal(await saveLimit(db, { ...limitInput({ apps: ['x.exe'], sites: [], capSecs: 120 }), id }), id);
  const [a, b] = await listLimits(db);
  assert.equal(a.capSecs, 120);
  assert.deepEqual([a.apps, a.sites], [['x.exe'], []]);
  assert.equal(b.unlockDelayMs, 3_600_000);
  await setLimitEnabled(db, id, false);
  assert.equal((await listLimits(db))[0].enabled, false);
  await setLimitEnabled(db, id, true);
  assert.equal((await listLimits(db))[0].enabled, true);
  await deleteLimit(db, id);
  assert.equal((await listLimits(db)).length, 1);
  assert.equal((await db.all('SELECT * FROM focus_limit_items WHERE limit_id = ?', [id])).length, 0);
});

test('limits: invalid input throws and ids are not reused', async () => {
  const db = await fresh();
  await assert.rejects(saveLimit(db, limitInput({ capSecs: 30 })));
  await assert.rejects(saveLimit(db, limitInput({ apps: [], sites: [] })));
  await assert.rejects(saveLimit(db, { ...limitInput(), id: 99 }));
  const id = await saveLimit(db, limitInput());
  await deleteLimit(db, id);
  assert.ok((await saveLimit(db, limitInput())) > id);
  assert.equal((await db.all('SELECT * FROM focus_limits')).length, 1);
});
