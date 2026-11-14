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
  const calls = { pushes: [], statuses: 0, active: 0, maxActive: 0, lock: [], limitPushes: [], limitGets: 0 };
  const client = {
    fail: null, statusFail: null, delay: 0,
    async pushWindows(w) {
      calls.active++; calls.maxActive = Math.max(calls.maxActive, calls.active);
      try {
        if (client.delay) await new Promise(r => setTimeout(r, client.delay));
        if (client.fail) throw client.fail;
        calls.pushes.push(w);
        client.windows = w;
        return { type: 'Ok' };
      } finally { calls.active--; }
    },
    statusValue: STATUS, mirror: false, windows: [], pending: [],
    async status() {
      calls.statuses++;
      if (client.statusFail) throw client.statusFail;
      return { ...client.statusValue, windows: client.mirror ? client.windows : client.statusValue.windows, pending_unlocks: client.pending };
    },
    lockErr: null,
    async requestChallenge(id) { calls.lock.push(['challenge', id]); if (client.lockErr) throw client.lockErr; return { type: 'Challenge', code: 'CODE-' + id }; },
    async submitToken(t) { calls.lock.push(['token', t]); if (client.lockErr) throw client.lockErr; client.windows = []; if (client.tokenUnlocks) client.unlockLimit(client.tokenUnlocks); return { type: 'Ok' }; },
    async setPartner(k) { calls.lock.push(['partner', k]); if (client.lockErr) throw client.lockErr; return { type: 'Ok' }; },
    async requestDelayedUnlock(id) { calls.lock.push(['delay', id]); if (client.lockErr) throw client.lockErr; client.pending = [{ window_id: id, unlock_at: T0 + 99 }]; return { type: 'UnlockPending', unlock_at: T0 + 99 }; },
    async cancelDelayedUnlock(id) { calls.lock.push(['cancel', id]); if (client.lockErr) throw client.lockErr; client.pending = []; return { type: 'Ok' }; },
    // A small model of the helper's limit rules: unlocked replaced freely, locked kept against weakening.
    hLimits: [], tomb: new Set(), limitFail: null, getFail: null, limStatus: [], limitPending: [],
    async pushLimits(ls) {
      calls.limitPushes.push(ls);
      if (client.onPush) client.onPush(ls);
      if (client.limitFail) throw client.limitFail;
      const kept = [], skipped = [];
      const next = [];
      for (const old of client.hLimits) {
        const inc = ls.find((x) => x.id === old.id);
        if (old.lock === 'locked' && (!inc || inc.cap_secs > old.cap_secs || inc.lock !== 'locked')) { kept.push(old.id); next.push(old); }
      }
      for (const inc of ls) {
        if (kept.includes(inc.id)) continue;
        if (inc.lock === 'locked' && client.tomb.has(inc.id)) { skipped.push(inc.id); continue; }
        if (inc.lock === 'unlocked' || inc.lock === 'none') client.tomb.delete(inc.id);
        next.push(inc);
      }
      client.hLimits = next;
      return { type: 'LimitsPushed', applied: ls.length, kept_locked: kept, skipped_tombstoned: skipped };
    },
    async getLimits() {
      calls.limitGets++;
      if (client.getFail) throw client.getFail;
      const snap = JSON.parse(JSON.stringify(client.hide ? [] : client.hLimits));
      client.hide = false;
      if (client.getDelay) await new Promise((r) => setTimeout(r, client.getDelay));
      return { type: 'Limits', limits: snap, status: client.limStatus, pending_unlocks: client.limitPending };
    },
    unlockLimit(id) { client.hLimits = client.hLimits.map((l) => (l.id === id ? { ...l, lock: 'none', unlock_delay_ms: undefined } : l)); client.tomb.add(id); },
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

// Fix round 1: reload failure after a successful write must not hide the write.
function breakReloadAfterWrite(db) {
  let armed = false;
  for (const m of ['batch', 'run']) {
    const orig = db[m].bind(db);
    db[m] = async (...a) => { const r = await orig(...a); armed = true; return r; };
  }
  const all = db.all.bind(db);
  db.all = async (sql, ...a) => {
    if (armed && /name, mode FROM focus_lists/.test(sql)) throw new Error('read failed');
    return all(sql, ...a);
  };
  return { arm: () => { armed = false; } };
}

test('startBlock: reload failing after the write still resyncs, returns ok and sets a stale notice', async () => {
  const { ctl, calls, db } = await setup();
  const a = await ctl.saveList(list('A'));
  const h = breakReloadAfterWrite(db); h.arm();
  const before = calls.pushes.length;
  assert.deepEqual(await ctl.startBlock({ listIds: [a.id], minutes: 20 }), { ok: true });
  assert.equal((await db.all('SELECT id FROM focus_sessions')).length, 1);
  assert.equal(calls.pushes.length, before + 1);
  assert.equal(last(calls).length, 1);
  assert.match(ctl.state.notice, /^Saved, but the list on screen may be out of date/);
});

test('extendBlock: reload failing after the write still resyncs and returns ok', async () => {
  const { ctl, calls, db } = await setup();
  const a = await ctl.saveList(list('A'));
  await ctl.startBlock({ listIds: [a.id], minutes: 20 });
  const key = ctl.state.blocks[0].key;
  breakReloadAfterWrite(db).arm();
  const before = calls.pushes.length;
  assert.deepEqual(await ctl.extendBlock(key, 10), { ok: true });
  assert.equal((await db.all('SELECT ends FROM focus_sessions'))[0].ends, T0 + 30 * MIN);
  assert.equal(calls.pushes.length, before + 1);
  assert.equal(last(calls)[0].ends, T0 + 30 * MIN);
  assert.match(ctl.state.notice, /out of date/);
});

test('cancelBlock: reload failing after the delete still resyncs; helperStopped logic intact', async () => {
  for (const down of [false, true]) {
    const { ctl, calls, db, client } = await setup();
    const a = await ctl.saveList(list('A'));
    await ctl.startBlock({ listIds: [a.id], minutes: 20 });
    const key = ctl.state.blocks[0].key;
    breakReloadAfterWrite(db).arm();
    if (down) client.fail = mkErr('unreachable', 'The Focus Room helper is not running');
    const before = calls.pushes.length;
    const r = await ctl.cancelBlock(key);
    assert.equal((await db.all('SELECT id FROM focus_sessions')).length, 0);
    if (down) {
      assert.deepEqual(r, { ok: true, helperStopped: false, enforcedUntil: T0 + 20 * MIN });
      assert.equal(ctl.state.syncPending, true);
    } else {
      assert.deepEqual(r, { ok: true, helperStopped: true });
      assert.equal(calls.pushes.length, before + 1);
      assert.deepEqual(last(calls), []);
      assert.match(ctl.state.notice, /out of date/);
    }
  }
});

test('a slow status() that resolves after a failed push does not paint the banner green', async () => {
  const { ctl, client } = await setup();
  let release;
  const gate = new Promise(r => { release = r; });
  client.status = async () => { await gate; return STATUS; };
  const slow = ctl.refreshStatus();
  client.fail = mkErr('unreachable', 'The Focus Room helper is not running');
  await ctl.resync();
  assert.equal(ctl.state.helper.kind, 'not-running');
  release();
  await slow;
  assert.equal(ctl.state.helper.kind, 'not-running');
  assert.equal(ctl.state.syncPending, true);
});

test('an ok status is not applied while syncPending even if it is the newest', async () => {
  const { ctl, client } = await setup();
  client.fail = mkErr('unreachable', 'The Focus Room helper is not running');
  await ctl.resync();
  await ctl.refreshStatus();
  assert.equal(ctl.state.helper.kind, 'not-running');
});

test('state.loaded is false until load settles, true after (also after a failing load)', async () => {
  const { ctl } = await setup();
  assert.equal(ctl.state.loaded, false);
  const p = ctl.load();
  assert.equal(ctl.state.loaded, false);
  await p;
  assert.equal(ctl.state.loaded, true);

  const { db, client, ctl: c2 } = await setup();
  const bad = createController({ db: { all: async () => { throw new Error('disk gone'); }, run: async () => { throw new Error('disk gone'); }, batch: async () => { throw new Error('disk gone'); } }, client, now: () => T0, tzOffsetAt: utc });
  await bad.load();
  assert.equal(bad.state.loaded, true);
  assert.match(bad.state.notice, /Could not read/);
  void c2; void db;
});

// ---- locked blocks ----
const HOUR = 3600000;
const lockedSetup = async () => {
  const x = await setup();
  x.client.mirror = true;
  x.a = await x.ctl.saveList(list('A'));
  x.b = await x.ctl.saveList(list('B', ['b.com']));
  return x;
};
const rowCount = async (db) => (await db.all('SELECT id FROM focus_sessions')).length;
const startLocked = (x, over = {}) => x.ctl.startLockedBlock({ listIds: [x.a.id, x.b.id], minutes: 120, delayHours: 6, ...over });

test('locked start fails and writes nothing when the helper is down', async () => {
  const x = await lockedSetup();
  x.client.statusFail = mkErr('unreachable', 'The Focus Room helper is not running');
  const r = await startLocked(x);
  assert.equal(r.ok, false);
  assert.match(r.message, /^Nothing was locked\. /);
  assert.equal(await rowCount(x.db), 0);
});

test('locked start fails when no partner key', async () => {
  const x = await lockedSetup();
  x.client.statusValue = { ...STATUS, partner_set: false };
  const r = await startLocked(x);
  assert.equal(r.ok, false);
  assert.match(r.message, /partner/i);
  assert.equal(await rowCount(x.db), 0);
});

test('locked start validates input before anything', async () => {
  const x = await lockedSetup();
  const before = x.calls.statuses;
  for (const over of [{ minutes: 0 }, { minutes: 10081 }, { minutes: 1.5 }, { minutes: 'x' }, { delayHours: 0 }, { delayHours: 169 }, { delayHours: 'abc' }, { delayHours: null }, { listIds: [] }, { listIds: 'a' }, { listIds: [9999] }]) {
    const r = await startLocked(x, over);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(typeof r.message, 'string');
  }
  assert.equal(x.calls.statuses, before);
  assert.equal(await rowCount(x.db), 0);
});

test('locked start rolls back rows when the push is rejected', async () => {
  const x = await lockedSetup();
  x.client.fail = mkErr('bad-window', 'too-long');
  const r = await startLocked(x);
  assert.equal(r.ok, false);
  assert.match(r.message, /^Nothing was locked\. /);
  assert.equal(await rowCount(x.db), 0);
  assert.equal(x.ctl.state.syncPending, false);
  assert.equal(x.ctl.state.blocks.length, 0);
});

test('locked start succeeds and the helper receives one merged window with the delay', async () => {
  const x = await lockedSetup();
  const r = await startLocked(x);
  assert.deepEqual(r, { ok: true });
  const w = last(x.calls);
  assert.equal(w.length, 1);
  assert.equal(w[0].lock, 'locked');
  assert.equal(w[0].unlock_delay_ms, 6 * HOUR);
  assert.equal(w[0].ends, T0 + 120 * MIN);
  const rows = await x.db.all('SELECT lock, unlock_delay_ms FROM focus_sessions');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((q) => q.lock === 'locked' && q.unlock_delay_ms === 6 * HOUR));
  assert.equal(x.ctl.state.blocks[0].lock, 'locked');
});

test('cancelBlock refuses a locked block before touching the store', async () => {
  const x = await lockedSetup();
  await startLocked(x);
  const key = x.ctl.state.blocks[0].key;
  const r = await x.ctl.cancelBlock(key);
  assert.deepEqual(r, { ok: false, message: 'A locked block cannot be cancelled. Use Unlock early.' });
  assert.equal(await rowCount(x.db), 2);
});

test('extend only lengthens a locked block and caps at 7 days', async () => {
  const x = await lockedSetup();
  await startLocked(x, { minutes: 60 });
  let key = x.ctl.state.blocks[0].key;
  for (const bad of [0, -5, 1.5, 'x', NaN]) assert.equal((await x.ctl.extendBlock(key, bad)).ok, false);
  assert.equal(x.ctl.state.blocks[0].ends, T0 + 60 * MIN);
  assert.deepEqual(await x.ctl.extendBlock(key, 30), { ok: true });
  assert.equal(x.ctl.state.blocks[0].ends, T0 + 90 * MIN);
  assert.equal(last(x.calls)[0].ends, T0 + 90 * MIN);
  key = x.ctl.state.blocks[0].key;
  assert.deepEqual(await x.ctl.extendBlock(key, 20000), { ok: true });
  assert.equal(x.ctl.state.blocks[0].ends, T0 + 7 * 24 * HOUR);
  assert.equal(last(x.calls)[0].ends, T0 + 7 * 24 * HOUR);
  key = x.ctl.state.blocks[0].key;
  const r = await x.ctl.extendBlock(key, 5);
  assert.equal(r.ok, false);
  assert.match(r.message, /7 days/);
});

test('extend refuses a locked block the helper just ended and does not revive it', async () => {
  const x = await lockedSetup();
  await startLocked(x, { minutes: 60 });
  const key = x.ctl.state.blocks[0].key;
  const pushes = x.calls.pushes.length;
  x.client.windows = [];
  const r = await x.ctl.extendBlock(key, 30);
  assert.equal(r.ok, false);
  assert.match(r.message, /just ended/);
  assert.equal(x.calls.pushes.length, pushes);
  assert.equal(x.ctl.state.blocks.length, 0);
});

test('extend of a normal block keeps the 24 hour cap', async () => {
  const x = await lockedSetup();
  await x.ctl.startBlock({ listIds: [x.a.id], minutes: 60 });
  const key = x.ctl.state.blocks[0].key;
  await x.ctl.extendBlock(key, 100000);
  assert.equal(x.ctl.state.blocks[0].ends, T0 + 24 * HOUR);
  assert.match((await x.ctl.extendBlock(x.ctl.state.blocks[0].key, 5)).message, /24 hours/);
});

test('token success removes the block after reconcile', async () => {
  const x = await lockedSetup();
  await startLocked(x);
  const key = x.ctl.state.blocks[0].key;
  const c = await x.ctl.requestPartnerChallenge(key);
  assert.equal(c.ok, true);
  assert.match(c.code, /^CODE-b/);
  const r = await x.ctl.submitPartnerToken(key, 'TOKEN');
  assert.deepEqual(r, { ok: true });
  assert.equal(await rowCount(x.db), 0);
  assert.equal(x.ctl.state.blocks.length, 0);
});

test('each token error leaves the lock and returns the plain message', async () => {
  const x = await lockedSetup();
  await startLocked(x);
  const key = x.ctl.state.blocks[0].key;
  for (const code of ['bad-format', 'bad-signature', 'wrong-challenge', 'wrong-lock', 'used', 'challenge-expired', 'expired']) {
    x.client.lockErr = mkErr(code, code);
    const r = await x.ctl.submitPartnerToken(key, 'TOKEN');
    assert.equal(r.ok, false, code);
    assert.match(r.message, /The lock stays on\./, code);
    assert.equal(await rowCount(x.db), 2, code);
  }
});

test('garbage token, partner key and block key never throw', async () => {
  const x = await lockedSetup();
  await startLocked(x);
  const key = x.ctl.state.blocks[0].key;
  for (const t of [undefined, null, 5, {}, [], '', '   ', 'x'.repeat(100000)]) {
    const r = await x.ctl.submitPartnerToken(key, t);
    assert.equal(r.ok, false);
    assert.equal(typeof r.message, 'string');
  }
  for (const k of [undefined, null, 5, {}, 'nope', '1:2:locked:3']) {
    for (const f of [() => x.ctl.requestPartnerChallenge(k), () => x.ctl.submitPartnerToken(k, 'T'), () => x.ctl.startDelayedUnlock(k), () => x.ctl.cancelDelayedUnlock(k)]) {
      const r = await f();
      assert.equal(r.ok, false);
      assert.equal(typeof r.message, 'string');
    }
  }
  for (const p of [undefined, null, {}, { publicKey: 5, name: 'N' }, { publicKey: '', name: 'N' }, { publicKey: 'k', name: 7 }, { publicKey: 'k', name: '  ' }, { publicKey: 'x'.repeat(100000), name: 'N' }]) {
    const r = await x.ctl.setPartner(p);
    assert.equal(r.ok, false);
    assert.equal(typeof r.message, 'string');
  }
  assert.equal(x.calls.lock.filter((c) => c[0] === 'partner').length, 0);
  assert.equal(await rowCount(x.db), 2);
});

test('a normal block key is not a lockable target', async () => {
  const x = await lockedSetup();
  await x.ctl.startBlock({ listIds: [x.a.id], minutes: 30 });
  const r = await x.ctl.requestPartnerChallenge(x.ctl.state.blocks[0].key);
  assert.equal(r.ok, false);
  assert.equal(x.calls.lock.length, 0);
});

test('delayed unlock request returns the unlock time; cancel clears it', async () => {
  const x = await lockedSetup();
  await startLocked(x);
  const key = x.ctl.state.blocks[0].key;
  assert.deepEqual(await x.ctl.startDelayedUnlock(key), { ok: true, unlockAt: T0 + 99 });
  assert.equal(x.ctl.state.helper.status.pending_unlocks.length, 1);
  assert.deepEqual(await x.ctl.cancelDelayedUnlock(key), { ok: true });
  assert.equal(x.ctl.state.helper.status.pending_unlocks.length, 0);
  assert.equal(await rowCount(x.db), 2);
});

test('request while helper unreachable says it was not sent and changes nothing', async () => {
  const x = await lockedSetup();
  await startLocked(x);
  const key = x.ctl.state.blocks[0].key;
  x.client.lockErr = mkErr('unreachable', 'The Focus Room helper is not running');
  for (const f of [() => x.ctl.requestPartnerChallenge(key), () => x.ctl.submitPartnerToken(key, 'T'), () => x.ctl.startDelayedUnlock(key), () => x.ctl.cancelDelayedUnlock(key)]) {
    const r = await f();
    assert.deepEqual(r, { ok: false, message: 'Not sent. The lock is unchanged.' });
  }
  assert.equal(await rowCount(x.db), 2);
});

test('reconcile removes a locked block the helper no longer holds, and keeps it while pushes are pending', async () => {
  const x = await lockedSetup();
  await startLocked(x);
  x.client.windows = [];
  await x.ctl.refreshStatus();
  assert.equal(await rowCount(x.db), 0);
  assert.equal(x.ctl.state.blocks.length, 0);

  // a failed push of an extension must not make reconcile delete the block
  await startLocked(x);
  const key = x.ctl.state.blocks[0].key;
  x.client.fail = mkErr('unreachable', 'The Focus Room helper is not running');
  await x.ctl.extendBlock(key, 10);
  assert.equal(x.ctl.state.syncPending, true);
  await x.ctl.refreshStatus();
  assert.equal(await rowCount(x.db), 2);
});

test('reconcile treats a window the helper ended early (end pulled back, still listed) as gone', async () => {
  const x = await lockedSetup();
  await startLocked(x);
  const w = x.client.windows[0];
  x.client.windows = [{ ...w, ends: T0 }];
  x.client.statusValue = { ...STATUS, now_ms: T0 + 1000 };
  await x.ctl.refreshStatus();
  assert.equal(await rowCount(x.db), 0);
  assert.equal(x.ctl.state.blocks.length, 0);
});

test('reconcile leaves a block whose time has passed alone', async () => {
  const x = await lockedSetup();
  await startLocked(x, { minutes: 5 });
  x.client.windows = [];
  x.setNow(T0 + 10 * MIN);
  await x.ctl.refreshStatus();
  assert.equal(await rowCount(x.db), 2);
});

test('setPartner stores the name and key only after the helper accepts', async () => {
  const x = await lockedSetup();
  assert.equal(x.ctl.state.partner.set, true);
  assert.deepEqual(await x.ctl.setPartner({ publicKey: 'KEY1', name: ' Sam ' }), { ok: true });
  assert.deepEqual(JSON.parse(JSON.stringify(await x.db.all('SELECT public_key, name FROM focus_partner'))), [{ public_key: 'KEY1', name: 'Sam' }]);
  assert.deepEqual(x.ctl.state.partner, { set: true, name: 'Sam' });
  await x.ctl.setPartner({ publicKey: 'KEY2', name: 'Alex' });
  assert.deepEqual(JSON.parse(JSON.stringify(await x.db.all('SELECT public_key, name FROM focus_partner'))), [{ public_key: 'KEY2', name: 'Alex' }]);
  for (const code of ['lock-active', 'bad-key']) {
    x.client.lockErr = mkErr(code, code);
    const r = await x.ctl.setPartner({ publicKey: 'KEY3', name: 'Zed' });
    assert.equal(r.ok, false);
    assert.equal(typeof r.message, 'string');
    assert.deepEqual(JSON.parse(JSON.stringify(await x.db.all('SELECT public_key, name FROM focus_partner'))), [{ public_key: 'KEY2', name: 'Alex' }]);
  }
});

test('partner state follows the latest status', async () => {
  const x = await setup();
  x.client.statusValue = { ...STATUS, partner_set: false };
  await x.ctl.load();
  assert.deepEqual(x.ctl.state.partner, { set: false, name: null });
});

test('HELPER_UNAVAILABLE_CLIENT answers every lock call without throwing', async () => {
  const c = HELPER_UNAVAILABLE_CLIENT;
  for (const m of ['requestChallenge', 'submitToken', 'setPartner', 'requestDelayedUnlock', 'cancelDelayedUnlock']) {
    await assert.rejects(() => c[m]('x'), (e) => e.code === 'unreachable');
  }
});

// ---- fix round 1 ----
// A fake that behaves like the real helper: it retains locked windows across pushes, treats a same-id
// push with a later end as an extension (keeping stored fields) and any other id as a new window.
function realish(client) {
  let held = [];
  client.mirror = true;
  client.pushWindows = async (incoming) => {
    if (client.fail) throw client.fail;
    const next = held.map((w) => ({ ...w }));
    for (const w of incoming) {
      if (w.lock !== 'locked') continue;
      const old = next.find((k) => k.id === w.id);
      if (old) { if (w.ends > old.ends) old.ends = w.ends; } else next.push({ ...w });
    }
    held = next;
    client.windows = [...held, ...incoming.filter((w) => w.lock !== 'locked')];
    return { type: 'Ok' };
  };
  client.submitToken = async () => { held = []; client.windows = []; return { type: 'Ok' }; };
  return { held: () => held };
}

test('extend keeps exactly one helper window for the block, and a token then removes it', async () => {
  const x = await lockedSetup();
  const h = realish(x.client);
  await startLocked(x, { minutes: 60 });
  assert.equal(h.held().length, 1);
  const id = h.held()[0].id;
  assert.deepEqual(await x.ctl.extendBlock(x.ctl.state.blocks[0].key, 30), { ok: true });
  assert.equal(h.held().length, 1);
  assert.equal(h.held()[0].id, id);
  assert.equal(h.held()[0].ends, T0 + 90 * MIN);
  const r = await x.ctl.submitPartnerToken(x.ctl.state.blocks[0].key, 'TOKEN');
  assert.deepEqual(r, { ok: true });
  assert.equal(h.held().length, 0);
  assert.equal(await rowCount(x.db), 0);
});

test('locked start: persist-failed with the window present keeps the rows and warns', async () => {
  const x = await lockedSetup();
  const h = realish(x.client);
  const push = x.client.pushWindows;
  x.client.pushWindows = async (w) => { await push(w); throw mkErr('persist-failed', 'disk'); };
  const r = await startLocked(x);
  assert.deepEqual(r, { ok: true, message: 'Locked, but the helper could not save it, so it will be lost on restart.' });
  assert.equal(await rowCount(x.db), 2);
  assert.equal(h.held().length, 1);
});

test('locked start: persist-failed with the window absent rolls back', async () => {
  const x = await lockedSetup();
  realish(x.client);
  x.client.pushWindows = async () => { throw mkErr('persist-failed', 'disk'); };
  const r = await startLocked(x);
  assert.equal(r.ok, false);
  assert.match(r.message, /^Nothing was locked\. /);
  assert.equal(await rowCount(x.db), 0);
});

test('locked start: timeout with the window present is a plain success', async () => {
  const x = await lockedSetup();
  realish(x.client);
  const push = x.client.pushWindows;
  x.client.pushWindows = async (w) => { await push(w); throw mkErr('unreachable', 'The helper did not answer in time'); };
  assert.deepEqual(await startLocked(x), { ok: true });
  assert.equal(await rowCount(x.db), 2);
});

test('locked start: timeout with the window absent rolls back', async () => {
  const x = await lockedSetup();
  realish(x.client);
  x.client.pushWindows = async () => { throw mkErr('unreachable', 'The helper did not answer in time'); };
  const r = await startLocked(x);
  assert.equal(r.ok, false);
  assert.equal(await rowCount(x.db), 0);
});

test('locked start: timeout then unreadable status keeps the rows, unconfirmed, syncPending', async () => {
  const x = await lockedSetup();
  realish(x.client);
  let n = 0;
  const st = x.client.status;
  x.client.status = async () => { if (++n > 1) throw mkErr('unreachable', 'The helper did not answer in time'); return st(); };
  x.client.pushWindows = async () => { throw mkErr('unreachable', 'The helper did not answer in time'); };
  const r = await startLocked(x);
  assert.deepEqual(r, { ok: true, unconfirmed: true, message: "Couldn't confirm the lock with the helper. It may be on. Check the Focus Room." });
  assert.equal(await rowCount(x.db), 2);
  assert.equal(x.ctl.state.syncPending, true);
});

test('locked start: a push that succeeds but whose window is absent from status rolls back', async () => {
  const x = await lockedSetup();
  realish(x.client);
  x.client.pushWindows = async () => ({ type: 'Ok' }); // helper silently holds nothing
  const r = await startLocked(x);
  assert.deepEqual(r, { ok: false, message: 'Nothing was locked. The helper did not receive it.' });
  assert.equal(await rowCount(x.db), 0);
  assert.equal(x.ctl.state.syncPending, false);
});

test('locked start: status unreadable after a good push is unconfirmed, rows kept', async () => {
  const x = await lockedSetup();
  realish(x.client);
  let n = 0;
  const st = x.client.status;
  x.client.status = async () => { if (++n > 1) throw mkErr('unreachable', 'x'); return st(); };
  const r = await startLocked(x);
  assert.equal(r.ok, true);
  assert.equal(r.unconfirmed, true);
  assert.equal(await rowCount(x.db), 2);
  assert.equal(x.ctl.state.syncPending, true);
});

test('setPartner: persist-failed counts as accepted and warns', async () => {
  const x = await lockedSetup();
  x.client.lockErr = mkErr('persist-failed', 'disk');
  const r = await x.ctl.setPartner({ publicKey: 'K', name: 'Sam' });
  assert.equal(r.ok, true);
  assert.match(r.message, /lost on restart/);
  assert.deepEqual(JSON.parse(JSON.stringify(await x.db.all('SELECT name FROM focus_partner'))), [{ name: 'Sam' }]);
});

test('setPartner: a failed name save after the helper accepted never shows the old name', async () => {
  const x = await lockedSetup();
  await x.ctl.setPartner({ publicKey: 'K1', name: 'Old' });
  await x.db.run("CREATE TRIGGER nope BEFORE INSERT ON focus_partner BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  const r = await x.ctl.setPartner({ publicKey: 'K2', name: 'New' });
  assert.equal(r.ok, false);
  assert.match(r.message, /^The helper accepted the key but its name could not be saved: .*disk full.*\.$/);
  assert.deepEqual(x.ctl.state.partner, { set: true, name: null });
});

test('unexpected reply types give a plain failure', async () => {
  const x = await lockedSetup();
  await startLocked(x);
  const key = x.ctl.state.blocks[0].key;
  x.client.requestChallenge = async () => ({ type: 'Ok' });
  x.client.submitToken = async () => ({ type: 'Challenge', code: 'x' });
  x.client.requestDelayedUnlock = async () => ({ type: 'Ok' });
  x.client.cancelDelayedUnlock = async () => ({ type: 'UnlockPending', unlock_at: 1 });
  for (const f of [() => x.ctl.requestPartnerChallenge(key), () => x.ctl.submitPartnerToken(key, 'T'), () => x.ctl.startDelayedUnlock(key), () => x.ctl.cancelDelayedUnlock(key)]) {
    const r = await f();
    assert.equal(r.ok, false);
    assert.match(r.message, /unexpected reply/);
  }
  assert.equal(await rowCount(x.db), 2);
});

test('saveList passes folders through to the window and reports errors.folders', async () => {
  const { ctl, calls } = await setup();
  const a = await ctl.saveList({ name: 'F', sites: [], apps: [], folders: ['C:/Games/Foo/'] });
  assert.equal(a.ok, true);
  assert.deepEqual(ctl.state.lists[0].folders, ['C:\\Games\\Foo']);
  await ctl.startBlock({ listIds: [a.id], minutes: 25 });
  assert.deepEqual(last(calls)[0].app_folders, ['C:\\Games\\Foo']);
  const bad = await ctl.saveList({ name: 'G', sites: [], apps: [], folders: ['C:\\Windows'] });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.folders[0].value, 'C:\\Windows');
});

// --- schedules ---
const schedIn = (listIds, over = {}) => ({
  name: 'Work', listIds, weekdays: [1], start: '09:00', end: '17:00', lock: 'none', unlockDelayMs: null, endsOn: null, ...over,
});
const lockedIn = (listIds, over = {}) => schedIn(listIds, { lock: 'locked', unlockDelayMs: 3600000, endsOn: '2026-01-10', ...over });

test('saveSchedule lists it on state and pushes its windows', async () => {
  const { ctl, calls } = await setup();
  const a = await ctl.saveList(list('A'));
  const r = await ctl.saveSchedule(schedIn([a.id]));
  assert.equal(r.ok, true);
  assert.equal(typeof r.id, 'number');
  assert.equal(ctl.state.schedules.length, 1);
  assert.equal(ctl.state.schedules[0].name, 'Work');
  assert.ok(last(calls).some(w => /^c\d+@/.test(w.id)));
  const bad = await ctl.saveSchedule(schedIn([]));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.listIds);
});

test('a running locked occurrence shows in state.blocks and unlocks by its window id', async () => {
  const { ctl, calls, client } = await setup();
  client.mirror = true;
  const a = await ctl.saveList(list('A'));
  const r = await ctl.saveSchedule(lockedIn([a.id]));
  assert.equal(r.ok, true);
  const b = ctl.state.blocks.find(x => x.scheduleId === r.id);
  assert.ok(b);
  const wid = `c${r.id}@${Date.UTC(2026, 0, 5, 9)}`;
  assert.equal(b.windowId, wid);
  assert.equal(b.key, wid);
  const c = await ctl.requestPartnerChallenge(wid);
  assert.deepEqual(c, { ok: true, code: 'CODE-' + wid });
  assert.deepEqual(calls.lock.at(-1), ['challenge', wid]);
});

test('state.blocks merges schedule blocks sorted by ends', async () => {
  const { ctl, client } = await setup();
  client.mirror = true;
  const a = await ctl.saveList(list('A'));
  await ctl.saveSchedule(lockedIn([a.id]));
  await ctl.startBlock({ listIds: [a.id], minutes: 25 });
  const ends = ctl.state.blocks.map(b => b.ends);
  assert.equal(ends.length, 2);
  assert.deepEqual(ends, [...ends].sort((x, y) => x - y));
});

test('extendBlock and cancelBlock refuse a schedule block and change nothing', async () => {
  const { ctl, db, client } = await setup();
  client.mirror = true;
  const a = await ctl.saveList(list('A'));
  const r = await ctl.saveSchedule(lockedIn([a.id]));
  const key = ctl.state.blocks.find(x => x.scheduleId === r.id).key;
  const sessionsBefore = await db.all('SELECT * FROM focus_sessions');
  assert.deepEqual(await ctl.extendBlock(key, 30), { ok: false, message: 'Edit the schedule instead.' });
  assert.deepEqual(await ctl.cancelBlock(key), { ok: false, message: 'A locked block cannot be cancelled. Use Unlock early.' });
  assert.deepEqual(await db.all('SELECT * FROM focus_sessions'), sessionsBefore);
  assert.equal(ctl.state.blocks.length, 1);
});

test('reconcile does not end or remove a schedule block the helper does not list', async () => {
  const { ctl, client, db } = await setup();
  client.mirror = true;
  const a = await ctl.saveList(list('A'));
  const r = await ctl.saveSchedule(lockedIn([a.id]));
  client.mirror = false; // status lists no windows
  await ctl.refreshStatus();
  await ctl.resync();
  assert.ok(ctl.state.blocks.some(x => x.scheduleId === r.id));
  assert.equal((await db.all('SELECT * FROM focus_schedules')).length, 1);
});

test('setScheduleEnabled and deleteSchedule reload, push, and report refusals', async () => {
  const { ctl, calls, client } = await setup();
  client.mirror = true;
  const a = await ctl.saveList(list('A'));
  const r = await ctl.saveSchedule(schedIn([a.id]));
  const pushesBefore = calls.pushes.length;
  assert.deepEqual(await ctl.setScheduleEnabled(r.id, false), { ok: true });
  assert.equal(ctl.state.schedules[0].enabled, false);
  assert.ok(calls.pushes.length > pushesBefore);
  assert.deepEqual(last(calls).filter(w => /^c\d+@/.test(w.id)), []);
  assert.deepEqual(await ctl.deleteSchedule(r.id), { ok: true });
  assert.equal(ctl.state.schedules.length, 0);
  assert.deepEqual(await ctl.deleteSchedule(r.id), { ok: false, reason: 'missing' });
  const l = await ctl.saveSchedule(lockedIn([a.id]));
  assert.deepEqual(await ctl.setScheduleEnabled(l.id, false), { ok: false, reason: 'locked' });
  assert.deepEqual(await ctl.deleteSchedule(l.id), { ok: false, reason: 'locked' });
});

test('saveSchedule with the helper down still saves and sets syncPending', async () => {
  const { ctl, client } = await setup();
  const a = await ctl.saveList(list('A'));
  client.fail = mkErr('unreachable', 'down');
  const r = await ctl.saveSchedule(schedIn([a.id]));
  assert.equal(r.ok, true);
  assert.equal(ctl.state.syncPending, true);
  assert.equal(ctl.state.schedules.length, 1);
});

test('saveList and deleteList use the injected tz for locked-schedule holds', async () => {
  const { ctl, client } = await setup();
  client.mirror = true;
  const a = await ctl.saveList(list('A'));
  await ctl.saveSchedule(lockedIn([a.id]));
  const e = await ctl.saveList({ ...list('A2'), id: a.id });
  assert.equal(e.ok, false);
  assert.equal(e.errors.name, 'That list is part of a locked schedule.');
  const d = await ctl.deleteList(a.id);
  assert.equal(d.ok, false);
});

test('a locked schedule is refused without a partner, before anything is written', async () => {
  const { ctl, client, db, calls } = await setup();
  const a = await ctl.saveList(list('A'));
  client.statusValue = { ...STATUS, partner_set: false };
  const pushes = calls.pushes.length;
  const r = await ctl.saveSchedule(lockedIn([a.id]));
  assert.equal(r.ok, false);
  assert.match(r.message, /partner/);
  assert.equal((await db.all('SELECT id FROM focus_schedules')).length, 0);
  assert.equal(calls.pushes.length, pushes);
});

test('a locked schedule is refused while the helper is down, but a normal one still saves', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveList(list('A'));
  client.statusFail = mkErr('unreachable', 'down');
  const r = await ctl.saveSchedule(lockedIn([a.id]));
  assert.equal(r.ok, false);
  assert.match(r.message, /^Nothing was saved\./);
  assert.equal((await db.all('SELECT id FROM focus_schedules')).length, 0);
  assert.equal((await ctl.saveSchedule(schedIn([a.id]))).ok, true);
});

test('a locked save is rolled back when the helper does not hold the first occurrence', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveList(list('A'));
  client.mirror = false; // status never lists the pushed windows
  const r = await ctl.saveSchedule(lockedIn([a.id]));
  assert.equal(r.ok, false);
  assert.match(r.message, /did not take the lock/);
  assert.equal((await db.all('SELECT id FROM focus_schedules')).length, 0);
  assert.equal(ctl.state.schedules.length, 0);
});

test('a failed locked edit restores the previous schedule', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveList(list('A'));
  const b = await ctl.saveList(list('B', ['b.com']));
  const n = await ctl.saveSchedule(schedIn([a.id], { name: 'Before' }));
  client.mirror = false;
  const r = await ctl.saveSchedule({ ...lockedIn([b.id], { name: 'After' }), id: n.id });
  assert.equal(r.ok, false);
  const [row] = await db.all('SELECT name, lock, enabled FROM focus_schedules');
  assert.deepEqual({ ...row }, { name: 'Before', lock: 'none', enabled: 1 });
  assert.deepEqual(ctl.state.schedules[0].listIds, [a.id]);
});

test('a locked save whose first occurrence is beyond the horizon skips the verification', async () => {
  const { ctl, client } = await setup();
  const a = await ctl.saveList(list('A'));
  client.mirror = false;
  // The only weekday (Wed) falls after the end date, so no occurrence exists to verify.
  const r = await ctl.saveSchedule(lockedIn([a.id], { endsOn: '2026-01-06', weekdays: [3] }));
  assert.equal(r.ok, true);
});

test('saveSchedule rejects lists whose items together exceed 512', async () => {
  const { ctl, db } = await setup();
  const mk = async (name, from) => ctl.saveList({ name, sites: Array.from({ length: 300 }, (_, i) => `s${from + i}.com`), apps: [] });
  const a = await mk('A', 0);
  const b = await mk('B', 1000);
  const r = await ctl.saveSchedule(schedIn([a.id, b.id]));
  assert.equal(r.ok, false);
  assert.equal(r.errors.listIds, 'Those lists together have too many items (max 512).');
  assert.equal((await db.all('SELECT id FROM focus_schedules')).length, 0);
  assert.equal((await ctl.saveSchedule(schedIn([a.id]))).ok, true);
});

test('a paused unlocked schedule edited to Locked is resumed, pushed, and kept', async () => {
  const { ctl, client, db } = await setup();
  client.mirror = true;
  const a = await ctl.saveList(list('A'));
  const n = await ctl.saveSchedule(schedIn([a.id]));
  await ctl.setScheduleEnabled(n.id, false);
  const r = await ctl.saveSchedule({ ...lockedIn([a.id]), id: n.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  const [row] = await db.all('SELECT lock, enabled FROM focus_schedules');
  assert.deepEqual({ ...row }, { lock: 'locked', enabled: 1 });
  assert.ok(client.windows.some(w => w.id.startsWith(`c${n.id}@`) && w.lock === 'locked'));
});

test('rolling back a locked edit of a paused schedule restores enabled = 0', async () => {
  const { ctl, client, db } = await setup();
  client.mirror = true;
  const a = await ctl.saveList(list('A'));
  const n = await ctl.saveSchedule(schedIn([a.id], { name: 'Before' }));
  await ctl.setScheduleEnabled(n.id, false);
  client.mirror = false;
  const r = await ctl.saveSchedule({ ...lockedIn([a.id], { name: 'After' }), id: n.id });
  assert.equal(r.ok, false);
  const [row] = await db.all('SELECT name, lock, enabled FROM focus_schedules');
  assert.deepEqual({ ...row }, { name: 'Before', lock: 'none', enabled: 0 });
});

test('a locked save whose status cannot be read after the push is kept as unconfirmed', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveList(list('A'));
  const orig = client.status;
  let n = 0;
  client.status = async () => { if (++n >= 2) throw mkErr('timeout', 'slow'); return orig(); };
  const r = await ctl.saveSchedule(lockedIn([a.id]));
  assert.equal(r.ok, true);
  assert.equal(r.unconfirmed, true);
  assert.match(r.message, /saved.*may not be enforced yet/);
  assert.equal(ctl.state.syncPending, true);
  assert.equal((await db.all('SELECT id FROM focus_schedules')).length, 1);
});

test('getUsage resolves {ok, days}, never throws, and flags an unreachable helper', async () => {
  const mk = (getUsage) => createController({ db: {}, client: { getUsage }, now: () => 0, tzOffsetAt: () => 0, onChange() {} });
  const rows = [{ day: '2026-11-11', total: 5 }];
  const seen = [];
  assert.deepEqual(await mk(async (f, t) => { seen.push([f, t]); return { type: 'Usage', days: rows }; }).getUsage('a', 'b'), { ok: true, days: rows });
  assert.deepEqual(seen, [['a', 'b']]);
  const bad = await mk(async () => ({ type: 'Ok' })).getUsage('a', 'b');
  assert.equal(bad.ok, false);
  const down = await mk(async () => { const e = new Error('The helper is not running'); e.code = 'unreachable'; throw e; }).getUsage('a', 'b');
  assert.deepEqual([down.ok, down.down], [false, true]);
  const req = await mk(async () => { const e = new Error('range too large'); e.code = 'bad-request'; throw e; }).getUsage('a', 'b');
  assert.deepEqual([req.ok, req.down, req.message], [false, false, 'range too large']);
  const none = await mk(undefined).getUsage('a', 'b');
  assert.equal(none.ok, false);
});

test('getSessions resolves {ok, stretches}, never throws, and flags an unreachable helper', async () => {
  const mk = (getSessions) => createController({ db: {}, client: { getSessions }, now: () => 0, tzOffsetAt: () => 0, onChange() {} });
  const stretches = [{ start: 1, end: 5, exe: 'a.exe', site: null }];
  const seen = [];
  assert.deepEqual(
    await mk(async (d) => { seen.push(d); return { type: 'Sessions', day: d, truncated: true, stretches }; }).getSessions('2026-11-13'),
    { ok: true, day: '2026-11-13', truncated: true, stretches },
  );
  assert.deepEqual(seen, ['2026-11-13']);
  const bad = await mk(async () => ({ type: 'Ok' })).getSessions('2026-11-13');
  assert.equal(bad.ok, false);
  const down = await mk(async () => { const e = new Error('The helper is not running'); e.code = 'unreachable'; throw e; }).getSessions('d');
  assert.deepEqual([down.ok, down.down], [false, true]);
  const req = await mk(async () => { const e = new Error('bad day'); e.code = 'bad-request'; throw e; }).getSessions('d');
  assert.deepEqual([req.ok, req.down, req.message, req.code], [false, false, 'bad day', 'bad-request']);
  assert.equal((await mk(undefined).getSessions('d')).ok, false);
  const stub = await createController({ db: {}, client: HELPER_UNAVAILABLE_CLIENT, now: () => 0, tzOffsetAt: () => 0, onChange() {} }).getSessions('d');
  assert.deepEqual([stub.ok, stub.down, stub.unavailable], [false, true, true]);
});

// ---- time limits ----
const lim = (o = {}) => ({ name: 'Games', period: 'daily', capSecs: 3600, lock: 'none', unlockDelayMs: null, apps: ['game.exe'], sites: [], ...o });
const lockedLim = (o = {}) => lim({ lock: 'locked', unlockDelayMs: 24 * 3600000, ...o });
const limRows = (db) => db.all('SELECT id, name, cap_secs, lock, unlock_delay_ms, enabled FROM focus_limits ORDER BY id');

test('new unlocked limit is saved and pushed with its real id', async () => {
  const { ctl, calls, db } = await setup();
  await ctl.load();
  const r = await ctl.saveLimit(lim());
  assert.equal(r.ok, true);
  assert.equal(typeof r.id, 'number');
  const rows = await limRows(db);
  assert.equal(rows.length, 1);
  const pushed = calls.limitPushes[calls.limitPushes.length - 1];
  assert.deepEqual(pushed.map((l) => l.id), [`limit-${r.id}`]);
  assert.equal(pushed[0].cap_secs, 3600);
  assert.equal(ctl.state.limitsState.limits.length, 1);
});

test('invalid limit returns field errors and writes nothing', async () => {
  const { ctl, calls, db } = await setup();
  const r = await ctl.saveLimit(lim({ name: '', capSecs: 30 }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.name && r.errors.cap);
  assert.equal((await limRows(db)).length, 0);
  assert.equal(calls.limitPushes.length, 0);
});

test('new locked limit persists only after the helper accepts; id is never undefined', async () => {
  const { ctl, calls, db } = await setup();
  const r = await ctl.saveLimit(lockedLim());
  assert.equal(r.ok, true);
  const pushed = calls.limitPushes[calls.limitPushes.length - 1];
  assert.equal(pushed[0].id, `limit-${r.id}`);
  assert.ok(!JSON.stringify(calls.limitPushes).includes('undefined'));
  assert.equal(pushed[0].lock, 'locked');
  assert.equal((await limRows(db))[0].lock, 'locked');
});

test('a helper bad-limit rejection of a new limit deletes the row and returns field errors', async () => {
  const { ctl, client, db } = await setup();
  client.limitFail = mkErr('bad-limit', 'bad-cap');
  const r = await ctl.saveLimit(lockedLim());
  assert.equal(r.ok, false);
  assert.ok(r.errors.cap);
  assert.equal((await limRows(db)).length, 0);
  assert.equal(ctl.state.limitsState.limits.length, 0);
});

test('new locked limit with the helper unreachable is not kept', async () => {
  const { ctl, client, db } = await setup();
  client.limitFail = mkErr('unreachable', 'pipe closed');
  const r = await ctl.saveLimit(lockedLim());
  assert.equal(r.ok, false);
  assert.match(r.message, /Nothing was saved/);
  assert.equal((await limRows(db)).length, 0);
});

test('new locked limit without a partner is refused and rolled back', async () => {
  const { ctl, client, db } = await setup();
  client.limitFail = mkErr('no-partner', 'a partner key is required');
  const r = await ctl.saveLimit(lockedLim());
  assert.equal(r.ok, false);
  assert.ok(r.errors.form);
  assert.equal((await limRows(db)).length, 0);
});

test('a new unlocked limit is kept with a warning when the helper is unreachable', async () => {
  const { ctl, client, db } = await setup();
  client.limitFail = mkErr('unreachable', 'pipe closed');
  const r = await ctl.saveLimit(lim());
  assert.equal(r.ok, true);
  assert.equal(r.unconfirmed, true);
  assert.ok(r.warning);
  assert.equal((await limRows(db)).length, 1);
  assert.equal(ctl.state.syncPending, true);
});

test('a helper rejection of an edit restores the previous row', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveLimit(lim());
  client.limitFail = mkErr('bad-limit', 'bad-item');
  const r = await ctl.saveLimit({ ...lim({ capSecs: 7200, name: 'Changed' }), id: a.id });
  assert.equal(r.ok, false);
  assert.ok(r.errors.items);
  const rows = await limRows(db);
  assert.equal(rows[0].cap_secs, 3600);
  assert.equal(rows[0].name, 'Games');
});

test('weakening a locked limit needs unlock and writes nothing', async () => {
  const { ctl, calls, db } = await setup();
  const a = await ctl.saveLimit(lockedLim());
  const before = calls.limitPushes.length;
  const r = await ctl.saveLimit({ ...lockedLim({ capSecs: 7200 }), id: a.id });
  assert.deepEqual(r, { ok: false, needsUnlock: true, limitId: a.id });
  assert.equal((await limRows(db))[0].cap_secs, 3600);
  assert.equal(calls.limitPushes.length, before);
});

test('dropping the lock or disabling a locked limit needs unlock', async () => {
  const { ctl, db } = await setup();
  const a = await ctl.saveLimit(lockedLim());
  assert.equal((await ctl.saveLimit({ ...lim(), id: a.id })).needsUnlock, true);
  assert.equal((await ctl.setLimitEnabled(a.id, false)).needsUnlock, true);
  assert.equal((await limRows(db))[0].enabled, 1);
});

test('tightening a locked limit applies and is pushed', async () => {
  const { ctl, calls, db } = await setup();
  const a = await ctl.saveLimit(lockedLim());
  const r = await ctl.saveLimit({ ...lockedLim({ capSecs: 1800 }), id: a.id });
  assert.equal(r.ok, true);
  assert.equal((await limRows(db))[0].cap_secs, 1800);
  assert.equal(calls.limitPushes[calls.limitPushes.length - 1][0].cap_secs, 1800);
});

test('kept_locked reloads from the helper and sets the notice', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveLimit(lockedLim());
  // The app row drifted weaker than the helper's locked copy.
  await db.run('UPDATE focus_limits SET cap_secs = 7200 WHERE id = ?', [a.id]);
  await ctl.resync();
  assert.equal(ctl.state.notice, 'Games is locked and was kept.');
  assert.equal((await limRows(db))[0].cap_secs, 3600);
  assert.equal(ctl.state.limitsState.limits[0].capSecs, 3600);
  assert.equal(client.hLimits[0].cap_secs, 3600);
});

test('skipped_tombstoned sets a notice and the next sync retries', async () => {
  const { ctl, client, calls } = await setup();
  const a = await ctl.saveLimit(lockedLim());
  client.hLimits = [];
  client.tomb.add(`limit-${a.id}`);
  await ctl.resync();
  assert.match(ctl.state.notice, /Games/);
  assert.match(ctl.state.notice, /unlock/i);
  const n = calls.limitPushes.length;
  client.tomb.clear();
  await ctl.resync();
  assert.equal(calls.limitPushes.length, n + 1);
  assert.equal(client.hLimits.length, 1);
  assert.equal(ctl.state.notice, null);
});

test('a disabled unlocked limit is omitted from the push; a locked one never is', async () => {
  const { ctl, calls, client } = await setup();
  const a = await ctl.saveLimit(lim());
  const b = await ctl.saveLimit(lockedLim({ name: 'Locked' }));
  assert.equal((await ctl.setLimitEnabled(a.id, false)).ok, true);
  let pushed = calls.limitPushes[calls.limitPushes.length - 1];
  assert.deepEqual(pushed.map((l) => l.id), [`limit-${b.id}`]);
  assert.equal((await ctl.setLimitEnabled(a.id, true)).ok, true);
  pushed = calls.limitPushes[calls.limitPushes.length - 1];
  assert.equal(pushed.length, 2);
  assert.equal(client.hLimits.length, 2);
});

test('delete of an unlocked limit works and is pushed', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveLimit(lim());
  const r = await ctl.deleteLimit(a.id);
  assert.equal(r.ok, true);
  assert.equal((await limRows(db)).length, 0);
  assert.deepEqual(client.hLimits, []);
});

test('delete of a locked limit needs unlock; it stays', async () => {
  const { ctl, db } = await setup();
  const a = await ctl.saveLimit(lockedLim());
  const r = await ctl.deleteLimit(a.id);
  assert.deepEqual(r, { ok: false, needsUnlock: true, limitId: a.id });
  assert.equal((await limRows(db)).length, 1);
});

test('delete of a locked limit the helper no longer holds succeeds', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveLimit(lockedLim());
  client.hLimits = [];
  const r = await ctl.deleteLimit(a.id);
  assert.equal(r.ok, true);
  assert.equal((await limRows(db)).length, 0);
});

test('delete of a locked limit with the helper unreachable is refused, not needsUnlock', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveLimit(lockedLim());
  client.getFail = mkErr('unreachable', 'down');
  const r = await ctl.deleteLimit(a.id);
  assert.equal(r.ok, false);
  assert.notEqual(r.needsUnlock, true);
  assert.equal((await limRows(db)).length, 1);
});

test('partner token unlock of a limit id then deletion succeeds', async () => {
  const { ctl, client, calls, db } = await setup();
  const a = await ctl.saveLimit(lockedLim());
  const id = `limit-${a.id}`;
  const ch = await ctl.requestPartnerChallenge(id);
  assert.equal(ch.ok, true);
  assert.equal(ch.code, 'CODE-' + id);
  client.tokenUnlocks = id;
  const r = await ctl.submitPartnerToken(id, 'TOKEN');
  assert.equal(r.ok, true);
  assert.deepEqual(calls.lock.filter((x) => x[0] === 'challenge'), [['challenge', id]]);
  const row = (await limRows(db))[0];
  assert.equal(row.lock, 'none');
  assert.equal(row.unlock_delay_ms, null);
  // the unlocked copy was pushed, which clears the helper's tombstone
  assert.equal(client.tomb.has(id), false);
  assert.equal(client.hLimits[0].lock, 'none');
  assert.equal((await ctl.deleteLimit(a.id)).ok, true);
  assert.equal((await limRows(db)).length, 0);
  assert.deepEqual(client.hLimits, []);
});

test('delayed unlock of a limit completes after the wait, then deletion succeeds', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveLimit(lockedLim());
  const id = `limit-${a.id}`;
  const r = await ctl.startDelayedUnlock(id);
  assert.deepEqual(r, { ok: true, unlockAt: T0 + 99 });
  assert.equal((await limRows(db))[0].lock, 'locked');
  client.unlockLimit(id); // the helper completes the wait
  await ctl.refreshLimits();
  assert.equal((await limRows(db))[0].lock, 'none');
  assert.equal(client.tomb.has(id), false);
  assert.equal((await ctl.deleteLimit(a.id)).ok, true);
  const c = await ctl.cancelDelayedUnlock(id);
  assert.equal(c.ok, false); // no longer locked
});

test('unlock requests for an unknown or unlocked limit are refused', async () => {
  const { ctl } = await setup();
  const a = await ctl.saveLimit(lim());
  assert.equal((await ctl.requestPartnerChallenge('limit-999')).ok, false);
  assert.equal((await ctl.requestPartnerChallenge(`limit-${a.id}`)).ok, false);
});

test('refreshLimits merges status by id and reports enforcement', async () => {
  const { ctl, client } = await setup();
  const a = await ctl.saveLimit(lim());
  client.limStatus = [{ id: `limit-${a.id}`, used_secs: 600, cap_secs: 3600, blocked: false, period_ends_day: '2026-01-06' }];
  client.limitPending = [{ window_id: `limit-${a.id}`, unlock_at: 5 }];
  await ctl.refreshLimits();
  const s = ctl.state.limitsState;
  assert.equal(s.enforcement, true);
  assert.equal(s.loaded, true);
  assert.equal(s.limits[0].status.used_secs, 600);
  assert.equal(s.pendingUnlocks.length, 1);
});

test('helper down keeps saved limits, enforcement false and no numbers', async () => {
  const { ctl, client } = await setup();
  const a = await ctl.saveLimit(lim());
  client.limStatus = [{ id: `limit-${a.id}`, used_secs: 600, cap_secs: 3600, blocked: false, period_ends_day: 'x' }];
  await ctl.refreshLimits();
  assert.equal(ctl.state.limitsState.limits[0].status.used_secs, 600);
  client.getFail = mkErr('unreachable', 'down');
  await ctl.refreshLimits();
  const s = ctl.state.limitsState;
  assert.equal(s.enforcement, false);
  assert.equal(s.limits.length, 1);
  assert.equal(s.limits[0].status, undefined);
});

test('load reads saved limits, pushes them and fills limitsState', async () => {
  const { ctl, client, db, calls } = await setup();
  await db.run("INSERT INTO focus_limits(name, period, cap_secs, lock, enabled) VALUES ('G','daily',3600,'none',1)");
  await db.run("INSERT INTO focus_limit_items(limit_id, kind, value) VALUES (1,'app','game.exe')");
  await ctl.load();
  assert.equal(calls.limitPushes.length >= 1, true);
  assert.equal(client.hLimits[0].id, 'limit-1');
  assert.equal(ctl.state.limitsState.loaded, true);
  assert.equal(ctl.state.limitsState.enforcement, true);
});

test('a window push failure does not hide limits and a limit push failure sets syncPending', async () => {
  const { ctl, client } = await setup();
  await ctl.saveLimit(lim());
  client.limitFail = mkErr('unreachable', 'down');
  await ctl.resync();
  assert.equal(ctl.state.syncPending, true);
  client.limitFail = null;
  await ctl.resync();
  assert.equal(ctl.state.syncPending, false);
});

test('a 65th limit returns an error', async () => {
  const { ctl, db } = await setup();
  for (let i = 0; i < 64; i++) await db.run("INSERT INTO focus_limits(name, period, cap_secs, lock, enabled) VALUES ('G','daily',3600,'none',1)");
  const r = await ctl.saveLimit(lim());
  assert.equal(r.ok, false);
  assert.ok(r.errors.form);
});

const wireLocked = (n, o = {}) => ({ id: `limit-${n}`, name: 'FromHelper', apps: ['x.exe'], sites: [], period: 'daily', cap_secs: 3600, lock: 'locked', unlock_delay_ms: 3600000, ...o });
const limItems = (db) => db.all('SELECT limit_id, kind, value FROM focus_limit_items ORDER BY rowid');

test('a stale getLimits snapshot never undoes a concurrent lock', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveLimit(lim());
  client.getDelay = 40;
  const refresh = ctl.refreshLimits();
  const save = ctl.saveLimit({ ...lockedLim(), id: a.id });
  await Promise.all([refresh, save]);
  client.getDelay = 0;
  assert.equal((await limRows(db))[0].lock, 'locked');
  assert.equal(client.hLimits[0].lock, 'locked');
  await ctl.refreshLimits();
  assert.equal((await limRows(db))[0].lock, 'locked');
});

test('a tighten while a looser snapshot is in flight wins', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveLimit(lockedLim());
  client.getDelay = 40;
  const refresh = ctl.refreshLimits();
  const save = ctl.saveLimit({ ...lockedLim({ capSecs: 1800 }), id: a.id });
  await Promise.all([refresh, save]);
  client.getDelay = 0;
  await ctl.refreshLimits();
  assert.equal((await limRows(db))[0].cap_secs, 1800);
  assert.equal(client.hLimits[0].cap_secs, 1800);
});

test('a locked limit only the helper holds is brought back as a row; new ids continue above it', async () => {
  const { ctl, client, db } = await setup();
  client.hLimits = [wireLocked(7)];
  await ctl.refreshLimits();
  const rows = await limRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 7);
  assert.equal(rows[0].lock, 'locked');
  assert.equal(ctl.state.limitsState.limits[0].name, 'FromHelper');
  assert.deepEqual((await limItems(db)).map((i) => i.value), ['x.exe']);
  assert.equal(client.hLimits.length, 1);
  const b = await ctl.saveLimit(lim());
  assert.ok(b.id > 7);
});

test('a limit in the app but missing on the helper is pushed again', async () => {
  const { ctl, client } = await setup();
  const a = await ctl.saveLimit(lim());
  client.hLimits = [];
  await ctl.resync();
  assert.deepEqual(client.hLimits.map((l) => l.id), [`limit-${a.id}`]);
});

test('delete asks the helper even when the row looks unlocked', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveLimit(lim());
  client.hLimits = [wireLocked(a.id, { name: 'Games' })];
  const r = await ctl.deleteLimit(a.id);
  assert.deepEqual(r, { ok: false, needsUnlock: true, limitId: a.id });
  assert.equal((await limRows(db)).length, 1);
});

test('delete whose push comes back kept_locked is not reported as success and the row returns', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveLimit(lim());
  client.hLimits = [wireLocked(a.id, { name: 'Games', apps: ['game.exe'] })];
  client.hide = true; // the pre-check sees nothing; the push finds the lock
  const r = await ctl.deleteLimit(a.id);
  assert.deepEqual(r, { ok: false, needsUnlock: true, limitId: a.id });
  const rows = await limRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lock, 'locked');
  assert.equal(ctl.state.notice, 'Games is locked and was kept.');
});

test('load with an empty app list clears a stale unlocked helper limit', async () => {
  const { ctl, client } = await setup();
  client.hLimits = [wireLocked(3, { lock: 'none' })];
  await ctl.load();
  assert.deepEqual(client.hLimits, []);
});

test('load with an empty app list adopts a locked helper limit and does not delete it', async () => {
  const { ctl, client, db } = await setup();
  client.hLimits = [wireLocked(3), wireLocked(4, { lock: 'none' })];
  await ctl.load();
  assert.deepEqual(client.hLimits.map((l) => l.id), ['limit-3']);
  const rows = await limRows(db);
  assert.deepEqual(rows.map((r) => r.id), [3]);
  assert.equal(rows[0].lock, 'locked');
});

test('a window push no-partner failure keeps the window wording, not the limit one', async () => {
  const { ctl, client } = await setup();
  client.fail = mkErr('no-partner', 'a partner key is required for locked windows');
  await ctl.resync();
  assert.equal(ctl.state.syncPending, true);
  assert.doesNotMatch(String(ctl.state.notice), /locked limit/);
});

test('a successful limit save after a limit failure clears the pending state and adopts', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveLimit(lockedLim());
  client.limitFail = mkErr('unreachable', 'down');
  await ctl.saveLimit(lim({ name: 'Other' }));
  assert.equal(ctl.state.syncPending, true);
  client.limitFail = null;
  await db.run('UPDATE focus_limits SET cap_secs = 7200 WHERE id = ?', [a.id]);
  const r = await ctl.saveLimit(lim({ name: 'Third' }));
  assert.equal(r.ok, true);
  assert.equal(ctl.state.syncPending, false);
  assert.equal((await limRows(db))[0].cap_secs, 3600);
});

test('timeout on a new locked limit: held by the helper -> ok', async () => {
  const { ctl, client, db } = await setup();
  client.onPush = (ls) => { client.hLimits = ls; };
  client.limitFail = mkErr('timeout', 'The helper did not answer in time');
  const r = await ctl.saveLimit(lockedLim());
  assert.equal(r.ok, true);
  assert.equal((await limRows(db)).length, 1);
});

test('timeout on a new locked limit: not held -> undone', async () => {
  const { ctl, client, db } = await setup();
  client.limitFail = mkErr('timeout', 'The helper did not answer in time');
  const r = await ctl.saveLimit(lockedLim());
  assert.equal(r.ok, false);
  assert.equal((await limRows(db)).length, 0);
});

test('timeout on a new locked limit: cannot tell -> kept, unconfirmed', async () => {
  const { ctl, client, db } = await setup();
  client.limitFail = mkErr('timeout', 'The helper did not answer in time');
  client.getFail = mkErr('unreachable', 'down');
  const r = await ctl.saveLimit(lockedLim());
  assert.equal(r.ok, true);
  assert.equal(r.unconfirmed, true);
  assert.equal((await limRows(db)).length, 1);
  assert.equal(ctl.state.syncPending, true);
});

test('locking an existing limit whose id is tombstoned is undone', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveLimit(lim());
  client.tomb.add(`limit-${a.id}`);
  const r = await ctl.saveLimit({ ...lockedLim(), id: a.id });
  assert.equal(r.ok, false);
  assert.ok(r.errors.form);
  assert.equal((await limRows(db))[0].lock, 'none');
});

test('persist-failed keeps the limit and warns', async () => {
  const { ctl, client, db } = await setup();
  client.limitFail = mkErr('persist-failed', 'disk');
  const r = await ctl.saveLimit(lockedLim());
  assert.equal(r.ok, true);
  assert.match(r.warning, /lost on restart/);
  assert.equal((await limRows(db)).length, 1);
});

test('a rejection whose undo fails reports it and does not claim success', async () => {
  const { ctl, client, db } = await setup();
  client.limitFail = mkErr('bad-limit', 'bad-cap');
  client.onPush = () => { db.batch = async () => { throw new Error('disk'); }; };
  const r = await ctl.saveLimit(lockedLim());
  assert.equal(r.ok, false);
  assert.match(r.errors.form, /could not be undone/);
  assert.equal(ctl.state.syncPending, true);
});

test('an edit rejection restores the items too', async () => {
  const { ctl, client, db } = await setup();
  const a = await ctl.saveLimit(lim({ apps: ['game.exe'], sites: ['a.com'] }));
  client.limitFail = mkErr('bad-limit', 'bad-item');
  await ctl.saveLimit({ ...lim({ apps: ['other.exe'], sites: [] }), id: a.id });
  assert.deepEqual((await limItems(db)).map((i) => `${i.kind}:${i.value}`).sort(), ['app:game.exe', 'site:a.com']);
});

// ---- uninstall protection ----
const UN = { wait_ms: 24 * 3600000, pending_at: null, permit_until: null };
async function unSetup(status = {}) {
  const x = await setup();
  x.client.statusValue = { ...STATUS, uninstall: UN, ...status };
  x.client.unCalls = [];
  x.client.unErr = null;
  x.client.requestUninstallDelay = async () => { x.client.unCalls.push(['delay']); if (x.client.unErr) throw x.client.unErr; x.client.statusValue = { ...x.client.statusValue, uninstall: { ...UN, pending_at: T0 + 5 } }; return { type: 'UninstallPending', unlock_at: T0 + 5 }; };
  x.client.cancelUninstallDelay = async () => { x.client.unCalls.push(['cancel']); if (x.client.unErr) throw x.client.unErr; x.client.statusValue = { ...x.client.statusValue, uninstall: UN }; return { type: 'Ok' }; };
  x.client.setUninstallWait = async (ms) => { x.client.unCalls.push(['wait', ms]); if (x.client.unErr) throw x.client.unErr; x.client.statusValue = { ...x.client.statusValue, uninstall: { ...UN, wait_ms: ms } }; return { type: 'Ok' }; };
  x.client.requestUninstallChallenge = async () => { x.client.unCalls.push(['challenge']); if (x.client.unErr) throw x.client.unErr; return { type: 'Challenge', code: 'UC' }; };
  x.client.submitUninstallToken = async (t) => { x.client.unCalls.push(['token', t]); if (x.client.unErr) throw x.client.unErr; x.client.statusValue = { ...x.client.statusValue, uninstall: { ...UN, permit_until: T0 + 1800000 } }; return { type: 'Ok' }; };
  return x;
}

test('state.uninstall maps Status.uninstall', async () => {
  const x = await unSetup();
  await x.ctl.load();
  assert.deepEqual(x.ctl.state.uninstall, { waitMs: 24 * 3600000, pendingAt: null, permitUntil: null, known: true });
});

test('state.uninstall unknown when the field is missing, before status, and when helper is down', async () => {
  const x = await setup();
  assert.equal(x.ctl.state.uninstall.known, false);
  await x.ctl.load();
  assert.equal(x.ctl.state.uninstall.known, false);
  const y = await unSetup();
  await y.ctl.load();
  assert.equal(y.ctl.state.uninstall.known, true);
  y.client.statusFail = mkErr('unreachable', 'down');
  await y.ctl.refreshStatus();
  assert.equal(y.ctl.state.uninstall.known, false);
});

test('uninstallRequestDelay returns unlockAt and refreshes status', async () => {
  const x = await unSetup();
  await x.ctl.load();
  assert.deepEqual(await x.ctl.uninstallRequestDelay(), { ok: true, unlockAt: T0 + 5 });
  assert.equal(x.ctl.state.uninstall.pendingAt, T0 + 5);
  assert.deepEqual(await x.ctl.uninstallCancelDelay(), { ok: true });
  assert.equal(x.ctl.state.uninstall.pendingAt, null);
});

test('uninstallSetWait validates, sends and refreshes', async () => {
  const x = await unSetup();
  await x.ctl.load();
  const bad = await x.ctl.uninstallSetWait(10);
  assert.equal(bad.ok, false);
  assert.equal(x.client.unCalls.length, 0);
  assert.deepEqual(await x.ctl.uninstallSetWait(48 * 3600000), { ok: true });
  assert.equal(x.ctl.state.uninstall.waitMs, 48 * 3600000);
});

test('uninstall challenge and token', async () => {
  const x = await unSetup();
  await x.ctl.load();
  assert.deepEqual(await x.ctl.uninstallChallenge(), { ok: true, code: 'UC' });
  assert.deepEqual(await x.ctl.uninstallSubmitToken('  tok '), { ok: true });
  assert.deepEqual(x.client.unCalls.at(-1), ['token', 'tok']);
  assert.equal(x.ctl.state.uninstall.permitUntil, T0 + 1800000);
  const e = await x.ctl.uninstallSubmitToken('   ');
  assert.equal(e.ok, false);
  assert.equal(e.code, 'bad-format');
});

test('uninstall errors carry message and code', async () => {
  const x = await unSetup();
  await x.ctl.load();
  x.client.unErr = mkErr('needs-permit', 'x');
  const r = await x.ctl.uninstallSetWait(2 * 3600000);
  assert.deepEqual(r, { ok: false, message: "Shortening the wait needs your partner's code or a finished waiting period.", code: 'needs-permit' });
  x.client.unErr = mkErr('no-pending-uninstall', 'x');
  const c = await x.ctl.uninstallCancelDelay();
  assert.equal(c.code, 'no-pending-uninstall');
  assert.equal(c.message, 'There is no waiting period running.');
  x.client.unErr = mkErr('unreachable', 'down');
  const u = await x.ctl.uninstallRequestDelay();
  assert.equal(u.ok, false);
  assert.equal(u.code, 'unreachable');
});

test('uninstall reply of the wrong type is refused', async () => {
  const x = await unSetup();
  await x.ctl.load();
  x.client.requestUninstallDelay = async () => ({ type: 'Ok' });
  assert.equal((await x.ctl.uninstallRequestDelay()).ok, false);
});

test('HELPER_UNAVAILABLE_CLIENT answers uninstall calls without throwing', async () => {
  for (const m of ['requestUninstallDelay', 'cancelUninstallDelay', 'setUninstallWait', 'requestUninstallChallenge', 'submitUninstallToken']) {
    await assert.rejects(() => HELPER_UNAVAILABLE_CLIENT[m]('x'), (e) => e.code === 'unreachable');
  }
});
