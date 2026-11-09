import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrateFocus } from '../src/modules/focus/schema.js';
import { createController, createUnavailableClient, HELPER_UNAVAILABLE_CLIENT } from '../src/modules/focus/controller.js';

const MIN = 60000;
const T0 = Date.UTC(2026, 0, 5, 12);
const utc = () => 0;

const STATUS = { type: 'Status', decision: { blockSites: [], blockApps: [], allow: null, frozen: false, locks: [] }, windows: [], partner_set: true, now_ms: T0, warnings: [] };

function mkErr(code, message) { const e = new Error(message); e.code = code; return e; }

async function setup() {
  const db = await openNodeDb(join(mkdtempSync(join(tmpdir(), 'focus-ctl-')), 't.db'));
  await migrateFocus(db);
  let clock = T0;
  const calls = { pushes: [], statuses: 0, active: 0, maxActive: 0 };
  const client = {
    fail: null, statusFail: null, delay: 0,
    async pushWindows(w) {
      calls.active++; calls.maxActive = Math.max(calls.maxActive, calls.active);
      try {
        if (client.delay) await new Promise(r => setTimeout(r, client.delay));
        if (client.fail) throw client.fail;
        calls.pushes.push(w);
        return { type: 'Ok' };
      } finally { calls.active--; }
    },
    async status() { calls.statuses++; if (client.statusFail) throw client.statusFail; return STATUS; },
  };
  let changes = 0;
  const ctl = createController({ db, client, now: () => clock, tzOffsetAt: utc, onChange: () => { changes++; } });
  return { db, client, calls, ctl, setNow: (t) => { clock = t; }, changes: () => changes };
}
const list = (name, sites = ['a.com']) => ({ name, sites, apps: [] });
const last = (calls) => calls.pushes[calls.pushes.length - 1];

test('load pushes current windows once and reads status', async () => {
  const { ctl, calls } = await setup();
  await ctl.load();
  assert.equal(calls.pushes.length, 1);
  assert.deepEqual(calls.pushes[0], []);
  assert.equal(ctl.state.helper.kind, 'ok');
  assert.equal(ctl.state.syncPending, false);
  assert.deepEqual(ctl.state.lastSync, { pushed: 0, skipped: 0 });
});

test('startBlock saves rows and pushes a window per list with the normalized items', async () => {
  const { ctl, calls, db } = await setup();
  const a = await ctl.saveList(list('A', ['https://www.Reddit.com/r/x']));
  const b = await ctl.saveList(list('B', ['b.com']));
  const r = await ctl.startBlock({ listIds: [a.id, b.id], minutes: 25 });
  assert.deepEqual(r, { ok: true });
  const w = last(calls);
  assert.equal(w.length, 2);
  assert.deepEqual(w.find(x => x.sites.includes('reddit.com')).sites, ['reddit.com']);
  const rows = await db.all('SELECT starts, ends FROM focus_sessions');
  assert.equal(rows.length, 2);
  assert.ok(rows.every(x => x.starts === T0 && x.ends === T0 + 25 * MIN));
  assert.equal(ctl.state.blocks.length, 1);
  assert.equal(ctl.state.blocks[0].state, 'running');
});

test('startBlock validation', async () => {
  const { ctl, calls } = await setup();
  const a = await ctl.saveList(list('A'));
  assert.deepEqual(await ctl.startBlock({ listIds: [], minutes: 25 }), { ok: false, message: 'Pick at least one list.' });
  assert.deepEqual(await ctl.startBlock({ listIds: [999], minutes: 25 }), { ok: false, message: 'One of those lists no longer exists.' });
  for (const m of [0, 1441, 1.5, NaN, -3, '5x']) {
    const r = await ctl.startBlock({ listIds: [a.id], minutes: m });
    assert.equal(r.ok, false);
    assert.equal(r.message, 'Enter a whole number of minutes from 1 to 1440.');
  }
  assert.equal(ctl.state.blocks.length, 0);
  assert.ok(calls.pushes.every(w => w.length === 0));
});

test('startBlock while the client throws "not running" saves rows, sets syncPending, and the next resync pushes the block exactly once', async () => {
  const { ctl, calls, client, db } = await setup();
  const a = await ctl.saveList(list('A'));
  client.fail = mkErr('unreachable', 'The Focus Room helper is not running');
  const r = await ctl.startBlock({ listIds: [a.id], minutes: 30 });
  assert.deepEqual(r, { ok: true });
  assert.equal(ctl.state.syncPending, true);
  assert.equal(ctl.state.helper.kind, 'not-running');
  assert.equal(ctl.state.notice, null);
  assert.equal((await db.all('SELECT id FROM focus_sessions')).length, 1);
  const before = calls.pushes.length;
  client.fail = null;
  await ctl.resync();
  assert.equal(calls.pushes.length, before + 1);
  assert.equal(last(calls).length, 1);
  assert.equal(ctl.state.syncPending, false);
  assert.equal(ctl.state.helper.kind, 'ok');
});

test('a second resync with no changes pushes the same set and creates no new rows', async () => {
  const { ctl, calls, db } = await setup();
  const a = await ctl.saveList(list('A'));
  await ctl.startBlock({ listIds: [a.id], minutes: 30 });
  await ctl.resync();
  const one = JSON.stringify(last(calls));
  await ctl.resync();
  assert.equal(JSON.stringify(last(calls)), one);
  assert.equal((await db.all('SELECT id FROM focus_sessions')).length, 1);
  assert.equal(last(calls).length, 1);
});

test('cancelBlock removes rows and pushes without the window', async () => {
  const { ctl, calls, db } = await setup();
  const a = await ctl.saveList(list('A'));
  await ctl.startBlock({ listIds: [a.id], minutes: 30 });
  const r = await ctl.cancelBlock(ctl.state.blocks[0].key);
  assert.deepEqual(r, { ok: true, helperStopped: true });
  assert.deepEqual(last(calls), []);
  assert.equal((await db.all('SELECT id FROM focus_sessions')).length, 0);
  assert.equal(ctl.state.blocks.length, 0);
});

test('cancelBlock of an unknown or finished key is rejected', async () => {
  const { ctl, setNow } = await setup();
  const a = await ctl.saveList(list('A'));
  assert.deepEqual(await ctl.cancelBlock('1:2:none'), { ok: false, message: 'That block has already finished.' });
  await ctl.startBlock({ listIds: [a.id], minutes: 5 });
  const key = ctl.state.blocks[0].key;
  setNow(T0 + 6 * MIN);
  assert.deepEqual(await ctl.cancelBlock(key), { ok: false, message: 'That block has already finished.' });
});

test('cancelBlock while the client is unreachable returns helperStopped:false with the old end, and a later resync succeeds', async () => {
  const { ctl, calls, client, db } = await setup();
  const a = await ctl.saveList(list('A'));
  await ctl.startBlock({ listIds: [a.id], minutes: 30 });
  client.fail = mkErr('unreachable', 'The Focus Room helper is not running');
  const r = await ctl.cancelBlock(ctl.state.blocks[0].key);
  assert.deepEqual(r, { ok: true, helperStopped: false, enforcedUntil: T0 + 30 * MIN });
  assert.equal((await db.all('SELECT id FROM focus_sessions')).length, 0);
  assert.equal(ctl.state.syncPending, true);
  client.fail = null;
  await ctl.resync();
  assert.deepEqual(last(calls), []);
  assert.equal(ctl.state.syncPending, false);
});

test('saveList on a list in a running block re-pushes the window with the new items', async () => {
  const { ctl, calls } = await setup();
  const a = await ctl.saveList(list('A', ['a.com']));
  await ctl.startBlock({ listIds: [a.id], minutes: 30 });
  const r = await ctl.saveList({ id: a.id, name: 'A', sites: ['a.com', 'new.com'], apps: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(last(calls)[0].sites, ['a.com', 'new.com']);
  assert.equal(ctl.state.lists[0].sites.length, 2);
});

test('saveList maps store problems to error results and never throws', async () => {
  const { ctl, db } = await setup();
  const gone = await ctl.saveList({ id: 77, name: 'X', sites: [], apps: [] });
  assert.deepEqual(gone, { ok: false, errors: { name: 'That list no longer exists.' } });
  const bad = await ctl.saveList({ name: '', sites: [], apps: [] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.name);
  db.batch = async () => { throw new Error('disk full'); };
  const r = await ctl.saveList(list('Z'));
  assert.deepEqual(r, { ok: false, errors: { name: 'Could not save: disk full' } });
});

test('database failures in other operations return ok:false', async () => {
  const { ctl, db } = await setup();
  const a = await ctl.saveList(list('A'));
  db.batch = async () => { throw new Error('disk full'); };
  const r = await ctl.startBlock({ listIds: [a.id], minutes: 5 });
  assert.equal(r.ok, false);
  assert.match(r.message, /disk full/);
  const d = await ctl.deleteList(a.id);
  assert.equal(d.ok, false);
});

test('deleteList refuses while running, succeeds after the end', async () => {
  const { ctl, setNow } = await setup();
  const a = await ctl.saveList(list('A'));
  await ctl.startBlock({ listIds: [a.id], minutes: 10 });
  assert.deepEqual(await ctl.deleteList(a.id), { ok: false, reason: 'running' });
  assert.equal(ctl.state.lists.length, 1);
  setNow(T0 + 11 * MIN);
  assert.deepEqual(await ctl.deleteList(a.id), { ok: true });
  assert.equal(ctl.state.lists.length, 0);
  assert.equal(ctl.state.blocks.length, 0);
});

test('extendBlock extends, caps the total at 1440 minutes, and rejects at the cap', async () => {
  const { ctl, calls } = await setup();
  const a = await ctl.saveList(list('A'));
  await ctl.startBlock({ listIds: [a.id], minutes: 1400 });
  let r = await ctl.extendBlock(ctl.state.blocks[0].key, 60);
  assert.deepEqual(r, { ok: true });
  assert.equal(ctl.state.blocks[0].ends, T0 + 1440 * MIN);
  assert.equal(last(calls)[0].ends, T0 + 1440 * MIN);
  r = await ctl.extendBlock(ctl.state.blocks[0].key, 15);
  assert.deepEqual(r, { ok: false, message: 'A block can be at most 24 hours long.' });
});

test('extendBlock adds minutes to every row of the block and rejects finished/unknown', async () => {
  const { ctl, setNow, db } = await setup();
  const a = await ctl.saveList(list('A'));
  const b = await ctl.saveList(list('B'));
  await ctl.startBlock({ listIds: [a.id, b.id], minutes: 30 });
  assert.deepEqual(await ctl.extendBlock(ctl.state.blocks[0].key, 15), { ok: true });
  const rows = await db.all('SELECT ends FROM focus_sessions');
  assert.ok(rows.every(x => x.ends === T0 + 45 * MIN));
  assert.deepEqual(await ctl.extendBlock('nope', 15), { ok: false, message: 'That block has already finished.' });
  const key = ctl.state.blocks[0].key;
  setNow(T0 + 46 * MIN);
  assert.deepEqual(await ctl.extendBlock(key, 15), { ok: false, message: 'That block has already finished.' });
});

test('a block whose end passes between calls is not pushed and shows state finished', async () => {
  const { ctl, calls, setNow } = await setup();
  const a = await ctl.saveList(list('A'));
  await ctl.startBlock({ listIds: [a.id], minutes: 10 });
  assert.equal(last(calls).length, 1);
  setNow(T0 + 10 * MIN + 1);
  assert.equal(ctl.state.blocks[0].state, 'finished');
  await ctl.resync();
  assert.deepEqual(last(calls), []);
});

test('load purges sessions finished more than a day ago', async () => {
  const { ctl, db, setNow } = await setup();
  const a = await ctl.saveList(list('A'));
  await ctl.startBlock({ listIds: [a.id], minutes: 10 });
  setNow(T0 + 2 * 86400000);
  await ctl.load();
  assert.equal((await db.all('SELECT id FROM focus_sessions')).length, 0);
  assert.equal(ctl.state.blocks.length, 0);
});

test('persist-failed from the client sets the persist-failed banner state', async () => {
  const { ctl, client } = await setup();
  client.fail = mkErr('persist-failed', 'could not write state');
  await ctl.resync();
  assert.equal(ctl.state.helper.kind, 'persist-failed');
  assert.equal(ctl.state.syncPending, true);
  assert.equal(ctl.state.notice, null);
});

test('a rejected push sets a notice naming the problem; success clears it', async () => {
  const { ctl, client } = await setup();
  client.fail = mkErr('bad-window', 'bad site in window');
  await ctl.resync();
  assert.match(ctl.state.notice, /^The helper rejected/);
  client.fail = null;
  await ctl.resync();
  assert.equal(ctl.state.notice, null);
});

test('refreshStatus never throws on any error', async () => {
  const { ctl, client } = await setup();
  for (const e of [mkErr('unreachable', 'x'), new Error('boom'), 'string', null, undefined, { weird: 1 }]) {
    client.statusFail = e === null || e === undefined ? { message: undefined } : e;
    await ctl.refreshStatus();
    assert.notEqual(ctl.state.helper.kind, 'ok');
  }
  client.statusFail = { get message() { throw new Error('nasty'); } };
  await ctl.refreshStatus();
  client.statusFail = null;
  await ctl.refreshStatus();
  assert.equal(ctl.state.helper.kind, 'ok');
});

test('concurrent resync calls do not interleave pushes and coalesce', async () => {
  const { ctl, calls, client } = await setup();
  client.delay = 15;
  await Promise.all([ctl.resync(), ctl.resync(), ctl.resync(), ctl.resync()]);
  assert.equal(calls.maxActive, 1);
  assert.equal(calls.pushes.length, 1); // requests queued before it started share one run
  const first = ctl.resync();
  await new Promise(r => setTimeout(r, 5)); // now running
  await Promise.all([first, ctl.resync(), ctl.resync()]); // two more requests while running: exactly one more run
  assert.equal(calls.maxActive, 1);
  assert.equal(calls.pushes.length, 3);
});

test('many concurrent operations never interleave writes (consistent ids and rows)', async () => {
  const { ctl, calls, client, db } = await setup();
  client.delay = 2;
  const base = [];
  for (let i = 0; i < 4; i++) base.push((await ctl.saveList(list('Base' + i, ['b' + i + '.com']))).id);
  const ops = [];
  for (let i = 0; i < 12; i++) {
    ops.push(ctl.saveList(list('New' + i, ['n' + i + '.com'])).then(r => ({ kind: 'list', i, r })));
    ops.push(ctl.startBlock({ listIds: [base[i % 4], base[(i + 1) % 4]], minutes: 10 + i }).then(r => ({ kind: 'block', i, r })));
    ops.push(ctl.resync().then(() => ({ kind: 'sync' })));
  }
  const res = await Promise.all(ops);
  assert.ok(res.filter(x => x.kind !== 'sync').every(x => x.r.ok));
  assert.equal(calls.maxActive, 1);
  const ids = res.filter(x => x.kind === 'list').map(x => x.r.id);
  assert.equal(new Set(ids).size, 12);
  const lists = await db.all('SELECT id, name FROM focus_lists');
  for (const x of res.filter(y => y.kind === 'list')) {
    assert.equal(lists.find(l => l.id === x.r.id).name, 'New' + x.i);
    const items = await db.all('SELECT value FROM focus_items WHERE list_id = ?', [x.r.id]);
    assert.deepEqual(items.map(v => v.value), ['n' + x.i + '.com']);
  }
  const sessions = await db.all('SELECT id, list_id, starts, ends FROM focus_sessions ORDER BY id');
  assert.equal(sessions.length, 24);
  assert.equal(new Set(sessions.map(s => s.id)).size, 24);
  for (let i = 0; i < 12; i++) {
    const rows = sessions.filter(s => s.ends === T0 + (10 + i) * MIN);
    assert.deepEqual(rows.map(r => r.list_id).sort(), [base[i % 4], base[(i + 1) % 4]].sort());
  }
  assert.equal(last(calls).length, 24);
});

test('onChange fires after state changes', async () => {
  const { ctl, changes } = await setup();
  await ctl.load();
  assert.ok(changes() >= 1);
  const n = changes();
  await ctl.saveList(list('A'));
  assert.ok(changes() > n);
});

test('createUnavailableClient rejects with code unreachable', async () => {
  const c = createUnavailableClient('only available in the desktop app');
  for (const fn of [() => c.pushWindows([]), () => c.status()]) {
    await assert.rejects(fn(), (e) => e.code === 'unreachable' && e.message === 'only available in the desktop app');
  }
  await assert.rejects(HELPER_UNAVAILABLE_CLIENT.status(), (e) => e.code === 'unreachable');
  const { ctl } = await setup();
  const db = (await setup()).db;
  const c2 = createController({ db, client: c, now: () => T0, tzOffsetAt: utc, onChange() {} });
  await c2.load();
  assert.equal(c2.state.helper.kind, 'unavailable');
  assert.equal(c2.state.syncPending, true);
  void ctl;
});
