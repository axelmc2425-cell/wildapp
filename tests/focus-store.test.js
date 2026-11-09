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
  assert.deepEqual(lists, [{ id: r.id, name: 'Study', mode: 'block', sites: ['youtube.com'], apps: ['steam.exe'] }]);
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
  assert.deepEqual(await listLists(db), [{ id, name: 'A', mode: 'block', sites: ['old.com'], apps: ['old.exe'] }]);
  const r = await saveList(db, { id, name: 'B', sites: ['new.com'], apps: [] });
  assert.deepEqual(r, { ok: true, id });
  assert.deepEqual(await listLists(db), [{ id, name: 'B', mode: 'block', sites: ['new.com'], apps: [] }]);
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
