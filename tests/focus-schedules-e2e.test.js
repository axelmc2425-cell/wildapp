// End-to-end: a locked recurring schedule through the real controller and the real focus-helper (stdio),
// with the helper's clock moved by the test-clock build's AdvanceClock. Needs `--features test-clock`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openNodeDb } from '../src/core/db-node.js';
import { migrateFocus } from '../src/modules/focus/schema.js';
import { createController } from '../src/modules/focus/controller.js';
import { createHelperClient } from '../src/modules/focus/helper-client.js';
import { createStdioCall } from '../scripts/helper-bridge.mjs';
import { generatePartnerKeys, signUnlock } from '../src/modules/focus/unlock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = ['focus-helper', 'focus-helper.exe'].map((n) => join(root, 'target', 'debug', n)).find(existsSync);
const MIN = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;

async function probe() {
  if (!exe) return 'focus-helper binary not built';
  const dir = mkdtempSync(join(tmpdir(), 'focus-sched-probe-'));
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

const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'focus-sched-e2e-'));
  const bridges = [];
  t.after(async () => {
    for (const b of bridges) await b.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const db = await openNodeDb(join(dir, 't.db'));
  await migrateFocus(db);
  const bridge = createStdioCall(exe, join(dir, 'state.json'));
  bridges.push(bridge);
  const client = createHelperClient((line) => bridge.call(line));
  // The controller's clock follows the helper's test clock, so both see the same "now".
  let shift = 0;
  const now = () => Date.now() + shift;
  const ctl = createController({ db, client, now, tzOffsetAt: () => 0 });
  const advance = async (ms) => {
    const res = JSON.parse(await bridge.call(JSON.stringify({ type: 'AdvanceClock', ms })));
    assert.notEqual(res.type, 'Error');
    shift += ms;
  };
  const keys = await generatePartnerKeys();
  // A locked daily schedule: starts in one hour, runs 3 hours, ends on a date a week out.
  const lockedSchedule = async (sites = ['reddit.com']) => {
    const l = await ctl.saveList({ name: 'Social', sites, apps: [] });
    assert.deepEqual(await ctl.setPartner({ publicKey: keys.publicKey, name: 'Pat' }), { ok: true });
    const startMs = Math.ceil((now() + HOUR) / MIN) * MIN;
    const r = await ctl.saveSchedule({
      name: 'Evening lock', listIds: [l.id], weekdays: [0, 1, 2, 3, 4, 5, 6],
      start: hhmm(startMs), end: hhmm(startMs + 3 * HOUR), lock: 'locked', unlockDelayMs: HOUR, endsOn: ymd(now() + 7 * DAY),
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    return { id: r.id, startMs, endMs: startMs + 3 * HOUR };
  };
  const winId = (id, starts) => `c${id}@${starts}`;
  const token = async (key) => {
    const c = await ctl.requestPartnerChallenge(key);
    assert.equal(c.ok, true, JSON.stringify(c));
    return signUnlock(keys.privateKeyJwk, c.code, now());
  };
  const live = (s, wid) => {
    const w = s.windows.find((x) => x.id === wid);
    return !!w && w.ends > s.now_ms;
  };
  return { ctl, client, db, advance, lockedSchedule, winId, token, live, now };
}

test('a locked schedule is pushed ahead of time and enforced when its occurrence starts', T, async (t) => {
  const { ctl, client, advance, lockedSchedule, winId, live } = await setup(t);
  const { id, startMs, endMs } = await lockedSchedule();
  assert.equal(ctl.state.syncPending, false);
  let s = await client.status();
  const first = s.windows.find((w) => w.id === winId(id, startMs));
  assert.ok(first, 'the first occurrence is already on the helper');
  assert.equal(first.lock, 'locked');
  assert.equal(first.unlock_delay_ms, HOUR);
  assert.equal(first.starts, startMs);
  assert.equal(first.ends, endMs);
  assert.ok(s.windows.some((w) => w.id === winId(id, startMs + DAY)), 'the next day is pushed too');
  assert.deepEqual(s.decision.blockSites, [], 'nothing is blocked before the start');
  assert.equal(ctl.state.blocks.length, 0);

  await advance(HOUR + 30 * MIN); // 30 minutes into the occurrence
  await ctl.refreshStatus();
  s = await client.status();
  assert.ok(live(s, winId(id, startMs)));
  assert.ok(s.decision.blockSites.includes('reddit.com'), 'the helper blocks the site');
  const b = ctl.state.blocks.find((x) => x.scheduleId === id);
  assert.ok(b, 'the controller shows the running occurrence');
  assert.equal(b.key, winId(id, startMs));

  await advance(3 * HOUR); // past the end
  await ctl.refreshStatus();
  s = await client.status();
  assert.deepEqual(s.decision.blockSites, [], 'blocking stops at the end');
  assert.ok(s.windows.some((w) => w.id === winId(id, startMs + DAY)), 'tomorrow stays queued');
});

test('deleting the schedule row directly does not release an occurrence already pushed', T, async (t) => {
  const { ctl, client, db, advance, lockedSchedule, winId, live } = await setup(t);
  const { id, startMs } = await lockedSchedule();
  await advance(HOUR + 10 * MIN);
  await ctl.refreshStatus();
  assert.ok(live(await client.status(), winId(id, startMs)));

  await db.run('DELETE FROM focus_schedule_lists WHERE schedule_id = ?', [id]);
  await db.run('DELETE FROM focus_schedules WHERE id = ?', [id]);
  assert.equal((await db.all('SELECT id FROM focus_schedules')).length, 0);
  await ctl.load();
  await ctl.resync();

  const s = await client.status();
  assert.ok(live(s, winId(id, startMs)), 'the helper still holds the pushed occurrence');
  assert.ok(s.decision.blockSites.includes('reddit.com'), 'and still enforces it');
  assert.equal(s.windows.find((w) => w.id === winId(id, startMs)).lock, 'locked');
});

test('a partner token unlocks one occurrence and the next day is still pushed and held', T, async (t) => {
  const { ctl, client, advance, lockedSchedule, winId, token, live } = await setup(t);
  const { id, startMs } = await lockedSchedule();
  await advance(HOUR + 20 * MIN);
  await ctl.refreshStatus();
  const key = winId(id, startMs);
  assert.ok(ctl.state.blocks.some((b) => b.key === key));
  assert.deepEqual(await ctl.submitPartnerToken(key, await token(key)), { ok: true });

  let s = await client.status();
  assert.equal(live(s, key), false, 'this occurrence is over');
  assert.deepEqual(s.decision.blockSites, []);
  // The controller still lists the occurrence; the Focus Room page hides it once the helper reports it ended.
  await ctl.resync();
  s = await client.status();
  assert.equal(live(s, key), false, 'a re-sync does not revive it');
  const next = winId(id, startMs + DAY);
  assert.ok(s.windows.some((w) => w.id === next && w.lock === 'locked'), 'the next occurrence is still pushed');

  await advance(DAY); // into the next day's occurrence
  await ctl.refreshStatus();
  s = await client.status();
  assert.ok(live(s, next));
  assert.ok(s.decision.blockSites.includes('reddit.com'), 'the next occurrence blocks again');
  assert.ok(ctl.state.blocks.some((b) => b.key === next));
});

test('a locked schedule cannot be paused or deleted while it is active', T, async (t) => {
  const { ctl, client, lockedSchedule, winId } = await setup(t);
  const { id, startMs } = await lockedSchedule();
  assert.deepEqual(await ctl.setScheduleEnabled(id, false), { ok: false, reason: 'locked' });
  assert.deepEqual(await ctl.deleteSchedule(id), { ok: false, reason: 'locked' });
  assert.equal(ctl.state.schedules.length, 1);
  assert.ok((await client.status()).windows.some((w) => w.id === winId(id, startMs)));
});

test('a locked schedule is refused with no partner set, and nothing reaches the helper', T, async (t) => {
  const { ctl, client, db } = await setup(t);
  const l = await ctl.saveList({ name: 'Social', sites: ['reddit.com'], apps: [] });
  const startMs = Math.ceil((Date.now() + HOUR) / MIN) * MIN;
  const r = await ctl.saveSchedule({
    name: 'No partner', listIds: [l.id], weekdays: [0, 1, 2, 3, 4, 5, 6],
    start: hhmm(startMs), end: hhmm(startMs + 3 * HOUR), lock: 'locked', unlockDelayMs: HOUR, endsOn: ymd(Date.now() + 7 * DAY),
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /partner/);
  assert.equal((await db.all('SELECT id FROM focus_schedules')).length, 0);
  assert.equal(ctl.state.schedules.length, 0);
  const s = await client.status();
  assert.equal(s.windows.filter((w) => w.lock === 'locked').length, 0);
});
