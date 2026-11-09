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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = ['focus-helper', 'focus-helper.exe'].map((n) => join(root, 'target', 'debug', n)).find(existsSync);
const skip = exe ? false : 'focus-helper binary not built';
const MIN = 60000;

// Temp db + real helper bridge + controller (real wall clock unless `now` is given).
async function setup(t, { now = () => Date.now(), bridge = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'focus-ui-e2e-'));
  const bridges = [];
  t.after(async () => {
    for (const b of bridges) await b.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const db = await openNodeDb(join(dir, 't.db'));
  await migrateFocus(db);
  const open = () => {
    const b = createStdioCall(exe, join(dir, 'state.json'));
    bridges.push(b);
    return createHelperClient((line) => b.call(line));
  };
  const real = bridge ? open() : null;
  // A swappable client so a test can start with the helper "down" and bring it up later.
  let current = real || {
    pushWindows: async () => { const e = new Error('helper not running'); e.code = 'unreachable'; throw e; },
    status: async () => { const e = new Error('helper not running'); e.code = 'unreachable'; throw e; },
  };
  const client = { pushWindows: (w) => current.pushWindows(w), status: () => current.status() };
  const ctl = createController({ db, client, now, tzOffsetAt: () => 0 });
  return { ctl, client, swapToReal: () => { current = open(); } };
}

const list = (name, sites) => ({ name, sites, apps: [] });

test('startBlock pushes a window and the helper reports the list sites', { skip }, async (t) => {
  const { ctl, client } = await setup(t);
  await ctl.load();
  const a = await ctl.saveList(list('Social', ['reddit.com', 'example.org']));
  assert.deepEqual(await ctl.startBlock({ listIds: [a.id], minutes: 25 }), { ok: true });
  const s = await client.status();
  assert.equal(s.windows.length, 1);
  assert.ok(s.decision.blockSites.includes('reddit.com'));
  assert.ok(s.decision.blockSites.includes('example.org'));
  assert.equal(ctl.state.helper.kind, 'ok');
  assert.equal(ctl.state.syncPending, false);
});

test('extendBlock moves the end in both the db and the helper', { skip }, async (t) => {
  const { ctl, client } = await setup(t);
  const a = await ctl.saveList(list('Social', ['reddit.com']));
  await ctl.startBlock({ listIds: [a.id], minutes: 25 });
  const before = (await client.status()).windows[0].ends;
  const key = ctl.state.blocks[0].key;
  assert.deepEqual(await ctl.extendBlock(key, 15), { ok: true });
  const after = (await client.status()).windows[0].ends;
  assert.equal(after - before, 15 * MIN);
  assert.equal(ctl.state.blocks[0].ends, after);
});

test('cancelBlock makes the helper drop the window', { skip }, async (t) => {
  const { ctl, client } = await setup(t);
  const a = await ctl.saveList(list('Social', ['reddit.com']));
  await ctl.startBlock({ listIds: [a.id], minutes: 25 });
  assert.equal((await client.status()).windows.length, 1);
  const r = await ctl.cancelBlock(ctl.state.blocks[0].key);
  assert.deepEqual(r, { ok: true, helperStopped: true });
  const s = await client.status();
  assert.equal(s.windows.length, 0);
  assert.deepEqual(s.decision.blockSites, []);
});

test('a block started while the helper is down is pushed once the bridge starts', { skip }, async (t) => {
  const { ctl, client, swapToReal } = await setup(t, { bridge: false });
  const a = await ctl.saveList(list('Social', ['reddit.com']));
  await ctl.startBlock({ listIds: [a.id], minutes: 25 });
  assert.equal(ctl.state.syncPending, true);
  assert.equal(ctl.state.blocks.length, 1);

  swapToReal();
  await ctl.resync();
  let s = await client.status();
  assert.equal(s.windows.length, 1);
  assert.ok(s.decision.blockSites.includes('reddit.com'));
  assert.equal(ctl.state.syncPending, false);
  assert.equal(ctl.state.helper.kind, 'ok');

  await ctl.resync();
  s = await client.status();
  assert.equal(s.windows.length, 1, 'a second resync leaves exactly one window');
});

test('a block on a far-past clock is not held or enforced by the helper (the helper uses its own clock)', { skip }, async (t) => {
  const past = Date.UTC(2020, 0, 1, 12);
  const { ctl, client } = await setup(t, { now: () => past });
  const a = await ctl.saveList(list('Social', ['reddit.com']));
  assert.deepEqual(await ctl.startBlock({ listIds: [a.id], minutes: 1 }), { ok: true });
  await ctl.resync();
  const s = await client.status();
  assert.equal(s.windows.length, 0);
  assert.deepEqual(s.decision.blockSites, []);
});

test('editing a list during a running block changes the helper blocked sites after resync', { skip }, async (t) => {
  const { ctl, client } = await setup(t);
  const a = await ctl.saveList(list('Social', ['reddit.com']));
  await ctl.startBlock({ listIds: [a.id], minutes: 25 });
  let s = await client.status();
  assert.deepEqual(s.decision.blockSites, ['reddit.com']);

  const r = await ctl.saveList({ id: a.id, ...list('Social', ['news.ycombinator.com']) });
  assert.equal(r.ok, true);
  await ctl.resync();
  s = await client.status();
  assert.equal(s.windows.length, 1);
  assert.deepEqual(s.decision.blockSites, ['news.ycombinator.com']);
});
