// End-to-end: the real controller + client against the real focus-helper (stdio), with the helper's own clock
// moved by the test-clock build's AdvanceClock request. Needs `--features test-clock`.
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
import { windowIdForBlock } from '../src/modules/focus/lock-logic.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = ['focus-helper', 'focus-helper.exe'].map((n) => join(root, 'target', 'debug', n)).find(existsSync);
const HOUR = 3600000;
const MIN = 60000;
const PAST_DELAY = HOUR + 1000;

// Probe: the binary must exist and answer AdvanceClock (only the test-clock build does).
async function probe() {
  if (!exe) return 'focus-helper binary not built';
  const dir = mkdtempSync(join(tmpdir(), 'focus-locks-probe-'));
  const b = createStdioCall(exe, join(dir, 'state.json'));
  try {
    // A spawn failure, crash or malformed reply throws here and fails the run; only a clean
    // `bad-request` (unknown variant) means "built without test-clock".
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

const down = () => { const e = new Error('helper not running'); e.code = 'unreachable'; throw e; };

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'focus-locks-e2e-'));
  const bridges = [];
  t.after(async () => {
    for (const b of bridges) await b.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const db = await openNodeDb(join(dir, 't.db'));
  await migrateFocus(db);
  let bridge = null;
  const open = () => {
    bridge = createStdioCall(exe, join(dir, 'state.json'));
    bridges.push(bridge);
    return createHelperClient((line) => bridge.call(line));
  };
  let current = open();
  let isDown = false;
  const methods = ['pushWindows', 'status', 'requestChallenge', 'submitToken', 'setPartner', 'requestDelayedUnlock', 'cancelDelayedUnlock'];
  const client = Object.fromEntries(methods.map((m) => [m, (...a) => (isDown ? down() : current[m](...a))]));
  const ctl = createController({ db, client, now: () => Date.now(), tzOffsetAt: () => 0 });
  const keys = await generatePartnerKeys();
  const advance = async (ms) => {
    const res = JSON.parse(await bridge.call(JSON.stringify({ type: 'AdvanceClock', ms })));
    assert.notEqual(res.type, 'Error');
  };
  const restart = async () => {
    await bridge.close();
    current = open();
  };
  const list = (name, sites) => ({ name, sites, apps: [] });
  // A saved list, a partner, and one locked block (1 h wait).
  const lockedBlock = async (sites = ['reddit.com'], minutes = 240) => {
    const a = await ctl.saveList(list('Social', sites));
    assert.deepEqual(await ctl.setPartner({ publicKey: keys.publicKey, name: 'Pat' }), { ok: true });
    const r = await ctl.startLockedBlock({ listIds: [a.id], minutes, delayHours: 1 });
    assert.equal(r.ok, true, JSON.stringify(r));
    const block = ctl.state.blocks.find((b) => b.lock === 'locked');
    const wid = windowIdForBlock(block);
    await assertLive(wid); // the helper really holds it, so later "ended" checks are meaningful
    return { a, block, wid };
  };
  const token = async (key) => {
    const c = await ctl.requestPartnerChallenge(key);
    assert.equal(c.ok, true, JSON.stringify(c));
    return signUnlock(keys.privateKeyJwk, c.code, Date.now());
  };
  const present = (s, wid) => s.windows.some((x) => x.id === wid);
  // Ended on the helper's own clock. An absent window also counts as ended (a pruned one), so use
  // `live` where the window must still exist.
  const ended = (s, wid) => {
    const w = s.windows.find((x) => x.id === wid);
    return !w || w.ends <= s.now_ms;
  };
  // The helper itself still holds the window and enforces its sites.
  const assertLive = async (wid) => {
    const s = await client.status();
    assert.ok(present(s, wid), 'window must be present on the helper');
    assert.equal(ended(s, wid), false, 'window must not be ended');
    assert.ok(s.decision.blockSites.includes('reddit.com'));
  };
  return {
    ctl, client, keys, advance, restart, lockedBlock, token, ended, present, assertLive, list, db,
    setDown: (v) => { isDown = v; },
  };
}

const T = { skip };

test('start a locked block: helper holds one locked window with the delay', T, async (t) => {
  const { ctl, client, lockedBlock } = await setup(t);
  const { block, wid } = await lockedBlock();
  const s = await client.status();
  assert.equal(s.windows.length, 1);
  assert.equal(s.windows[0].id, wid);
  assert.equal(s.windows[0].lock, 'locked');
  assert.equal(s.windows[0].unlock_delay_ms, HOUR);
  assert.ok(s.decision.blockSites.includes('reddit.com'));
  assert.equal(block.lock, 'locked');
  assert.equal(block.unlockDelayMs, HOUR);
  assert.equal(ctl.state.syncPending, false);
});

test('cancel is refused and the helper still holds the window', T, async (t) => {
  const { ctl, client, lockedBlock } = await setup(t);
  const { block, wid } = await lockedBlock();
  const r = await ctl.cancelBlock(block.key);
  assert.equal(r.ok, false);
  const s = await client.status();
  assert.equal(s.windows.length, 1);
  assert.equal(s.windows[0].id, wid);
  assert.equal(ctl.state.blocks.length, 1);
});

test('unlock with a real partner token ends the lock and a re-sync does not bring it back', T, async (t) => {
  const { ctl, client, lockedBlock, token, ended, present } = await setup(t);
  const { block, wid } = await lockedBlock();
  const original = (await client.status()).windows.find((w) => w.id === wid);
  assert.ok(original);
  assert.deepEqual(await ctl.submitPartnerToken(block.key, await token(block.key)), { ok: true });
  assert.equal(ctl.state.blocks.filter((b) => b.lock === 'locked' && b.state === 'running').length, 0);
  let s = await client.status();
  assert.ok(present(s, wid), 'the real helper keeps listing the window it ended early');
  assert.ok(ended(s, wid));
  assert.deepEqual(s.decision.blockSites, []);
  await ctl.resync();
  s = await client.status();
  assert.ok(ended(s, wid), 're-sync must not revive the window');
  assert.deepEqual(s.decision.blockSites, []);
  // The helper's own tombstone: pushing the ORIGINAL window (same id, original end) must not bring it back.
  await client.pushWindows([original]);
  s = await client.status();
  assert.ok(ended(s, wid), 'pushing the original window must not revive it');
  assert.deepEqual(s.decision.blockSites, []);
  assert.equal(ctl.state.blocks.filter((b) => b.lock === 'locked' && b.state === 'running').length, 0);
});

test('wait it out: request, advance the clock past the delay, the controller removes the block', T, async (t) => {
  const { ctl, client, lockedBlock, advance, ended, assertLive } = await setup(t);
  const { block, wid } = await lockedBlock();
  const r = await ctl.startDelayedUnlock(block.key);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Number.isFinite(r.unlockAt));
  assert.equal((await client.status()).pending_unlocks.length, 1);
  assert.equal(ctl.state.blocks.filter((b) => b.lock === 'locked').length, 1, 'still locked during the wait');
  await assertLive(wid);
  await advance(PAST_DELAY);
  await ctl.refreshStatus();
  const s = await client.status();
  assert.ok(ended(s, wid));
  assert.deepEqual(s.decision.blockSites, []);
  assert.equal(ctl.state.blocks.filter((b) => b.lock === 'locked' && b.state === 'running').length, 0);
});

test('cancelling a wait keeps the lock after the delay passes', T, async (t) => {
  const { ctl, client, lockedBlock, advance, ended, assertLive } = await setup(t);
  const { block, wid } = await lockedBlock();
  assert.equal((await ctl.startDelayedUnlock(block.key)).ok, true);
  assert.deepEqual(await ctl.cancelDelayedUnlock(block.key), { ok: true });
  assert.equal((await client.status()).pending_unlocks.length, 0);
  await assertLive(wid);
  await advance(PAST_DELAY);
  await ctl.refreshStatus();
  const s = await client.status();
  assert.equal(ended(s, wid), false);
  assert.ok(s.decision.blockSites.includes('reddit.com'));
  assert.equal(ctl.state.blocks.filter((b) => b.lock === 'locked' && b.state === 'running').length, 1);
});

test('a wait survives restarting the helper bridge on the same state file', T, async (t) => {
  const { ctl, client, lockedBlock, advance, restart, ended, assertLive } = await setup(t);
  const { block, wid } = await lockedBlock();
  const r = await ctl.startDelayedUnlock(block.key);
  assert.equal(r.ok, true, JSON.stringify(r));
  await restart();
  const s0 = await client.status();
  assert.equal(s0.pending_unlocks.length, 1);
  assert.equal(s0.pending_unlocks[0].window_id, wid);
  assert.equal(s0.windows.length, 1);
  await ctl.refreshStatus();
  assert.equal(ctl.state.blocks.filter((b) => b.lock === 'locked' && b.state === 'running').length, 1);
  await assertLive(wid);
  await advance(PAST_DELAY);
  await ctl.refreshStatus();
  assert.ok(ended(await client.status(), wid));
  assert.equal(ctl.state.blocks.filter((b) => b.lock === 'locked' && b.state === 'running').length, 0);
});

test('a partner token during a wait ends the lock and clears the wait', T, async (t) => {
  const { ctl, client, lockedBlock, token, ended } = await setup(t);
  const { block, wid } = await lockedBlock();
  assert.equal((await ctl.startDelayedUnlock(block.key)).ok, true);
  assert.deepEqual(await ctl.submitPartnerToken(block.key, await token(block.key)), { ok: true });
  const s = await client.status();
  assert.ok(ended(s, wid));
  assert.equal(s.pending_unlocks.length, 0);
  assert.equal(ctl.state.blocks.filter((b) => b.lock === 'locked' && b.state === 'running').length, 0);
});

test('locked start with the helper down leaves no rows', T, async (t) => {
  const { ctl, db, keys, setDown, list } = await setup(t);
  const a = await ctl.saveList(list('Social', ['reddit.com']));
  assert.deepEqual(await ctl.setPartner({ publicKey: keys.publicKey, name: 'Pat' }), { ok: true });
  setDown(true);
  const r = await ctl.startLockedBlock({ listIds: [a.id], minutes: 60, delayHours: 1 });
  assert.equal(r.ok, false);
  assert.match(r.message, /Nothing was locked/);
  assert.deepEqual(await db.all('SELECT * FROM focus_sessions'), []);
  assert.equal(ctl.state.blocks.length, 0);
});

test('editing a list in a running locked block is refused', T, async (t) => {
  const { ctl, client, lockedBlock, list } = await setup(t);
  const { a } = await lockedBlock();
  const r = await ctl.saveList({ id: a.id, ...list('Social', ['news.ycombinator.com']) });
  assert.equal(r.ok, false);
  assert.match(r.errors.name, /locked block/);
  const s = await client.status();
  assert.deepEqual(s.decision.blockSites, ['reddit.com']);
});

test('extend keeps one helper window and a token then ends it', T, async (t) => {
  const { ctl, client, lockedBlock, token, ended } = await setup(t);
  const { block, wid } = await lockedBlock();
  const before = (await client.status()).windows[0].ends;
  assert.deepEqual(await ctl.extendBlock(block.key, 30), { ok: true });
  const s = await client.status();
  assert.equal(s.windows.length, 1);
  assert.equal(s.windows[0].id, wid);
  assert.equal(s.windows[0].ends - before, 30 * MIN);
  const live = ctl.state.blocks.find((b) => b.lock === 'locked');
  assert.equal(live.ends, s.windows[0].ends);
  assert.deepEqual(await ctl.submitPartnerToken(live.key, await token(live.key)), { ok: true });
  assert.ok(ended(await client.status(), wid));
  assert.equal(ctl.state.blocks.filter((b) => b.lock === 'locked' && b.state === 'running').length, 0);
});
