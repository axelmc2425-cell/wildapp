// End-to-end: time limits through the real focus-helper (stdio). Needs `--features test-clock`
// (AddUsage seeds usage, AdvanceClock moves the helper's own clock, wall time included).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHelperClient } from '../src/modules/focus/helper-client.js';
import { createStdioCall } from '../scripts/helper-bridge.mjs';
import { generatePartnerKeys, signUnlock } from '../src/modules/focus/unlock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = ['focus-helper', 'focus-helper.exe'].map((n) => join(root, 'target', 'debug', n)).find(existsSync);
const HOUR = 3600000;
const DAY_MS = 86400000;

async function probe() {
  if (!exe) return 'focus-helper binary not built';
  const dir = mkdtempSync(join(tmpdir(), 'focus-limits-probe-'));
  const b = createStdioCall(exe, join(dir, 'state.json'));
  try {
    const res = JSON.parse(await b.call(JSON.stringify({ type: 'AdvanceClock', ms: 0 })));
    if (res.type === 'Ok') return false;
    if (res.type === 'Error' && res.code === 'bad-request') return 'focus-helper was built without --features test-clock (AdvanceClock: bad-request)';
    throw new Error(`unexpected AdvanceClock reply: ${JSON.stringify(res)}`);
  } finally {
    await b.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
const skip = await probe();
const T = { skip };

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'focus-limits-e2e-'));
  const bridges = [];
  t.after(async () => {
    for (const b of bridges) await b.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  let bridge = null;
  let client = null;
  const open = () => {
    bridge = createStdioCall(exe, join(dir, 'state.json'));
    bridges.push(bridge);
    client = createHelperClient((line) => bridge.call(line));
  };
  open();
  let skew = 0; // our copy of the helper's clock skew (the helper adds it to wall time too)
  const send = async (req) => JSON.parse(await bridge.call(JSON.stringify(req)));
  const today = () => iso(Date.now() + skew);
  const advance = async (ms) => {
    assert.equal((await send({ type: 'AdvanceClock', ms })).type, 'Ok');
    skew += ms;
  };
  const report = async (day, exeName = 'code.exe', title = null) => {
    const r = await send({ type: 'ReportForeground', exe: exeName, title, idle_secs: 0, day, hour: 12 });
    assert.equal(r.type, 'Ok', JSON.stringify(r));
  };
  const addUsage = async (day, apps = {}, sites = {}) => {
    const total = Object.values(apps).reduce((a, b) => a + b, 0);
    assert.equal((await send({ type: 'AddUsage', day: { day, total, apps, sites, other_browsing: 0 } })).type, 'Ok');
  };
  const limit = (over = {}) => ({ id: 'limit-1', name: 'Games', apps: ['game.exe'], sites: [], period: 'daily', cap_secs: 3600, lock: 'none', ...over });
  const stat = async (id = 'limit-1') => (await client.getLimits()).status.find((s) => s.id === id);
  return { dir, send, today, advance, report, addUsage, limit, stat, restart: async () => { await bridge.close(); open(); }, get client() { return client; } };
}

test('a daily limit blocks exactly at the cap and lists the app in the decision', T, async (t) => {
  const s = setup(t);
  const day = s.today();
  const pushed = await s.client.pushLimits([s.limit()]);
  assert.equal(pushed.type, 'LimitsPushed');
  assert.deepEqual(pushed.kept_locked, []);
  await s.report(day); // the first report anchors the sampler and sets the current day
  await s.addUsage(day, { 'game.exe': 3599 });
  let st = await s.stat();
  assert.equal(st.blocked, false);
  assert.equal(st.used_secs, 3599);
  assert.equal(st.cap_secs, 3600);
  assert.equal((await s.client.status()).decision.limitBlocks, undefined, 'omitted while nothing is exceeded');
  assert.ok(!(await s.client.status()).decision.blockApps.includes('game.exe'));
  await s.addUsage(day, { 'game.exe': 3600 });
  st = await s.stat();
  assert.equal(st.blocked, true);
  assert.equal(st.used_secs, 3600);
  const d = (await s.client.status()).decision;
  assert.ok(d.blockApps.includes('game.exe'), JSON.stringify(d));
  assert.deepEqual(d.limitBlocks.map((b) => b.id), ['limit-1']);
  assert.equal(d.limitBlocks[0].until_day, iso(Date.parse(day) + DAY_MS));
});

test('daily rollover: silence never unblocks, the first report of the next day does', T, async (t) => {
  const s = setup(t);
  const day = s.today();
  await s.client.pushLimits([s.limit()]);
  await s.report(day);
  await s.addUsage(day, { 'game.exe': 3600 });
  assert.equal((await s.stat()).blocked, true);
  await s.advance(DAY_MS + 3600000);
  assert.equal((await s.stat()).blocked, true, 'no report yet: still blocked');
  assert.ok((await s.client.status()).decision.blockApps.includes('game.exe'));
  await s.report(s.today());
  const st = await s.stat();
  assert.equal(st.blocked, false);
  assert.equal(st.used_secs, 0);
  assert.deepEqual((await s.client.status()).decision.blockApps, []);
});

test('a day string that goes backwards never lowers used time', T, async (t) => {
  const s = setup(t);
  const day = s.today();
  await s.client.pushLimits([s.limit()]);
  await s.report(day);
  await s.addUsage(day, { 'game.exe': 3600 });
  await s.report(iso(Date.parse(day) - DAY_MS));
  assert.equal((await s.stat()).blocked, true);
});

test('a weekly limit holds through Sunday and lifts at Monday', T, async (t) => {
  const s = setup(t);
  const day = s.today();
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  const toMonday = 7 - weekday;
  await s.client.pushLimits([s.limit({ id: 'limit-w', name: 'Weekly', period: 'weekly', cap_secs: 7200 })]);
  await s.report(day);
  await s.addUsage(day, { 'game.exe': 7200 });
  let st = await s.stat('limit-w');
  assert.equal(st.blocked, true);
  assert.equal(st.period_ends_day, iso(Date.parse(day) + toMonday * DAY_MS));
  // Up to the last day of the week it still holds (a report each day keeps within the day-skew bound).
  for (let i = 1; i < toMonday; i += 1) {
    await s.advance(DAY_MS);
    await s.report(s.today());
  }
  assert.equal((await s.stat('limit-w')).blocked, true, 'the last day of the week');
  await s.advance(DAY_MS);
  await s.report(s.today()); // Monday
  st = await s.stat('limit-w');
  assert.equal(st.blocked, false);
  assert.equal(st.used_secs, 0);
});

test('a site limit counts the site label and a real browser title', T, async (t) => {
  const s = setup(t);
  const day = s.today();
  await s.client.pushLimits([s.limit({ id: 'limit-s', name: 'Video', apps: [], sites: ['youtube.com'], cap_secs: 60 })]);
  const title = 'Cats compilation - YouTube - Google Chrome';
  for (let i = 0; i < 4; i += 1) {
    await s.report(day, 'chrome.exe', title);
    await sleep(1100);
  }
  const live = await s.stat('limit-s');
  assert.ok(live.used_secs >= 2 && live.used_secs <= 5, `counted ${live.used_secs}`);
  assert.equal(live.blocked, false);
  await s.addUsage(day, { 'chrome.exe': 60 }, { YouTube: 60 });
  assert.equal((await s.stat('limit-s')).blocked, true);
  assert.ok((await s.client.status()).decision.blockSites.includes('youtube.com'));
});

test('bad ids are rejected with bad-limit', T, async (t) => {
  const s = setup(t);
  for (const id of ['x', 'game', 'limit', 'Limit-1', '']) {
    await assert.rejects(s.client.pushLimits([s.limit({ id })]), (e) => e.code === 'bad-limit', JSON.stringify(id));
  }
  assert.deepEqual((await s.client.getLimits()).limits, []);
  // GetLimits has no id argument; an unlock request for a bad id is refused as an unknown window.
  await assert.rejects(s.client.requestChallenge('x'), (e) => typeof e.code === 'string');
});

async function lockedSetup(t, delay = HOUR) {
  const s = setup(t);
  const keys = await generatePartnerKeys();
  assert.equal((await s.client.setPartner(keys.publicKey)).type, 'Ok');
  const locked = s.limit({ lock: 'locked', unlock_delay_ms: delay });
  const pushed = await s.client.pushLimits([locked]);
  assert.equal(pushed.type, 'LimitsPushed');
  return { s, keys, locked };
}

test('a locked limit keeps its terms against weakening pushes; tightening applies', T, async (t) => {
  const { s, locked } = await lockedSetup(t);
  const get = async () => (await s.client.getLimits()).limits.find((l) => l.id === 'limit-1');
  let r = await s.client.pushLimits([{ ...locked, cap_secs: 7200 }]);
  assert.deepEqual(r.kept_locked, ['limit-1']);
  assert.equal((await get()).cap_secs, 3600);
  r = await s.client.pushLimits([]);
  assert.deepEqual(r.kept_locked, ['limit-1']);
  assert.ok(await get(), 'a delete push keeps it');
  r = await s.client.pushLimits([{ ...locked, lock: 'none', unlock_delay_ms: undefined }]);
  assert.deepEqual(r.kept_locked, ['limit-1']);
  assert.equal((await get()).lock, 'locked');
  r = await s.client.pushLimits([{ ...locked, cap_secs: 1800, apps: ['game.exe', 'other.exe'] }]);
  assert.deepEqual(r.kept_locked, []);
  assert.equal((await get()).cap_secs, 1800);
  assert.deepEqual((await get()).apps, ['game.exe', 'other.exe']);
});

test('partner token unlocks a locked limit; an unlocked copy is accepted; a stale locked re-push is tombstoned', T, async (t) => {
  const { s, keys, locked } = await lockedSetup(t);
  const c = await s.client.requestChallenge('limit-1');
  const token = await signUnlock(keys.privateKeyJwk, c.code, Date.now());
  assert.equal((await s.client.submitToken(token)).type, 'Ok');
  let l = (await s.client.getLimits()).limits.find((x) => x.id === 'limit-1');
  assert.equal(l.lock, 'none');
  const stale = await s.client.pushLimits([locked]);
  assert.deepEqual(stale.skipped_tombstoned, ['limit-1']);
  l = (await s.client.getLimits()).limits.find((x) => x.id === 'limit-1');
  assert.equal(l?.lock ?? 'none', 'none');
  const edited = await s.client.pushLimits([{ ...locked, lock: 'none', unlock_delay_ms: undefined, cap_secs: 9000 }]);
  assert.deepEqual(edited.kept_locked, []);
  assert.equal((await s.client.getLimits()).limits.find((x) => x.id === 'limit-1').cap_secs, 9000);
});

test('a waiting-period unlock completes after the clock passes the delay', T, async (t) => {
  const { s } = await lockedSetup(t);
  const r = await s.client.requestDelayedUnlock('limit-1');
  assert.equal(r.type, 'UnlockPending');
  let g = await s.client.getLimits();
  assert.equal(g.pending_unlocks.length, 1);
  assert.equal(g.limits[0].lock, 'locked');
  await s.advance(HOUR - 60000);
  assert.equal((await s.client.getLimits()).limits[0].lock, 'locked', 'not yet');
  await s.advance(120000);
  g = await s.client.getLimits();
  assert.equal(g.limits[0].lock, 'none');
  assert.equal(g.pending_unlocks.length, 0);
});

test('restart keeps limits and an exceeded limit blocks before any new report', T, async (t) => {
  const { s, locked } = await lockedSetup(t);
  const day = s.today();
  await s.report(day);
  await s.addUsage(day, { 'game.exe': 3600 });
  assert.equal((await s.stat()).blocked, true);
  await s.restart();
  const g = await s.client.getLimits();
  assert.deepEqual(g.limits, [locked]);
  const st = await s.stat();
  assert.equal(st.blocked, true, 'no report since the restart');
  assert.equal(st.used_secs, 3600);
  const d = (await s.client.status()).decision;
  assert.ok(d.blockApps.includes('game.exe'));
  assert.deepEqual(d.limitBlocks.map((b) => b.id), ['limit-1']);
});
