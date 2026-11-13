// End-to-end: hourly usage and second-level stretches through the real focus-helper (stdio), using the
// test-clock build's AddUsage / AddSessions. Needs `--features test-clock`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHelperClient } from '../src/modules/focus/helper-client.js';
import { createStdioCall } from '../scripts/helper-bridge.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = ['focus-helper', 'focus-helper.exe'].map((n) => join(root, 'target', 'debug', n)).find(existsSync);

async function probe() {
  if (!exe) return 'focus-helper binary not built';
  const dir = mkdtempSync(join(tmpdir(), 'focus-detail-probe-'));
  const b = createStdioCall(exe, join(dir, 'state.json'));
  try {
    const res = JSON.parse(await b.call(JSON.stringify({ type: 'AddSessions', day: '2020-01-01', truncated: false, stretches: [] })));
    if (res.type === 'Ok') return false;
    if (res.type === 'Error' && res.code === 'bad-request') return 'focus-helper was built without --features test-clock (AddSessions: bad-request)';
    throw new Error(`unexpected AddSessions reply: ${JSON.stringify(res)}`);
  } finally {
    await b.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
const skip = await probe();
const T = { skip };

const DAY = '2026-03-04';
const base = Date.UTC(2026, 2, 4, 9, 0, 0) / 1000;
const STRETCHES = [
  { start: base, end: base + 600, exe: 'code.exe', site: null },
  { start: base + 600, end: base + 900, exe: 'chrome.exe', site: 'YouTube' },
  { start: base + 1200, end: base + 1500, exe: 'chrome.exe', site: null },
];
const hours = Array.from({ length: 24 }, (_, h) => (h === 9 ? 1500 : 0));
const USAGE_DAY = { day: DAY, total: 1500, apps: { 'code.exe': 600, 'chrome.exe': 900 }, sites: { YouTube: 300 }, other_browsing: 600, hours };

function open(t, dir) {
  const bridge = createStdioCall(exe, join(dir, 'state.json'));
  t.after(() => bridge.close().catch(() => {}));
  return { bridge, client: createHelperClient((line) => bridge.call(line)) };
}
const send = async (bridge, req) => JSON.parse(await bridge.call(JSON.stringify(req)));
const tmp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-detail-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
async function seed(bridge) {
  assert.equal((await send(bridge, { type: 'AddUsage', day: USAGE_DAY })).type, 'Ok');
  assert.equal((await send(bridge, { type: 'AddSessions', day: DAY, truncated: false, stretches: STRETCHES })).type, 'Ok');
  assert.equal((await send(bridge, { type: 'AddSessions', day: '2026-03-05', truncated: true, stretches: STRETCHES.slice(0, 1) })).type, 'Ok');
}

test('GetUsage rows carry hours and GetSessions returns the seeded stretches exactly', T, async (t) => {
  const dir = tmp(t);
  const { bridge, client } = open(t, dir);
  await seed(bridge);
  const usage = await client.getUsage(DAY, DAY);
  assert.deepEqual(usage.days, [USAGE_DAY]);
  assert.equal(usage.days[0].hours.length, 24);
  const res = await client.getSessions(DAY);
  assert.equal(res.type, 'Sessions');
  assert.equal(res.day, DAY);
  assert.equal(res.truncated, false);
  assert.deepEqual(res.stretches, STRETCHES);
});

test('bad days are rejected with bad-request', T, async (t) => {
  const { client } = open(t, tmp(t));
  for (const day of ['../x', '2026-13-40', '', '2026-3-4']) {
    await assert.rejects(client.getSessions(day), (e) => e.code === 'bad-request', day);
  }
});

test('an empty day answers empty and not truncated; a truncated day says so', T, async (t) => {
  const { bridge, client } = open(t, tmp(t));
  await seed(bridge);
  const empty = await client.getSessions('2026-03-09');
  assert.deepEqual([empty.stretches, empty.truncated], [[], false]);
  const cut = await client.getSessions('2026-03-05');
  assert.equal(cut.truncated, true);
  assert.deepEqual(cut.stretches, STRETCHES.slice(0, 1));
});

test('restarting the helper on the same state dir keeps hours and stretches', T, async (t) => {
  const dir = tmp(t);
  const first = open(t, dir);
  await seed(first.bridge);
  await first.bridge.close();
  const second = open(t, dir);
  assert.deepEqual((await second.client.getSessions(DAY)).stretches, STRETCHES);
  assert.equal((await second.client.getSessions('2026-03-05')).truncated, true);
  assert.deepEqual((await second.client.getUsage(DAY, DAY)).days, [USAGE_DAY]);
  assert.ok(readdirSync(dir).some((f) => f.startsWith('sessions-')), 'a sessions-* file sits next to state.json');
});

test('one-second ReportForeground reports become a stretch', T, async (t) => {
  const { bridge, client } = open(t, tmp(t));
  const day = new Date().toISOString().slice(0, 10);
  const report = () => send(bridge, { type: 'ReportForeground', exe: 'Code.exe', title: null, idle_secs: 0, day, hour: new Date().getUTCHours() });
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await report()).type, 'Ok');
    await sleep(1100);
  }
  const res = await client.getSessions(day);
  assert.ok(res.stretches.length >= 1, 'a stretch was recorded');
  const total = res.stretches.reduce((a, s) => a + (s.end - s.start), 0);
  assert.ok(total >= 2 && total <= 5, `stretch seconds ${total}`);
  assert.ok(res.stretches.every((s) => s.exe === 'code.exe' && s.site === null));
});
