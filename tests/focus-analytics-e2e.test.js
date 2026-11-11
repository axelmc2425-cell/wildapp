// End-to-end: usage seeded into the real focus-helper (stdio) with the test-clock build's AddUsage,
// read back through the real bridge and helper client, summarized by stats.js. Needs `--features test-clock`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHelperClient } from '../src/modules/focus/helper-client.js';
import { createStdioCall } from '../scripts/helper-bridge.mjs';
import { summarize } from '../src/modules/focus/stats.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = ['focus-helper', 'focus-helper.exe'].map((n) => join(root, 'target', 'debug', n)).find(existsSync);

async function probe() {
  if (!exe) return 'focus-helper binary not built';
  const dir = mkdtempSync(join(tmpdir(), 'focus-usage-probe-'));
  const b = createStdioCall(exe, join(dir, 'state.json'));
  try {
    const res = JSON.parse(await b.call(JSON.stringify({ type: 'AddUsage', day: { day: '2020-01-01', total: 0, apps: {}, sites: {}, other_browsing: 0 } })));
    if (res.type === 'Ok') return false;
    if (res.type === 'Error' && res.code === 'bad-request') return 'focus-helper was built without --features test-clock (AddUsage: bad-request)';
    throw new Error(`unexpected AddUsage reply: ${JSON.stringify(res)}`);
  } finally {
    await b.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
const skip = await probe();
const T = { skip };

const DAYS = [
  { day: '2026-03-02', total: 7200, apps: { 'code.exe': 5400, 'chrome.exe': 1800 }, sites: { YouTube: 900 }, other_browsing: 900 },
  { day: '2026-03-03', total: 3600, apps: { 'chrome.exe': 2400, 'code.exe': 1200 }, sites: { Reddit: 600, YouTube: 300 }, other_browsing: 1500 },
  { day: '2026-03-05', total: 1800, apps: { 'code.exe': 1800 }, sites: {}, other_browsing: 0 },
];

function open(t, dir) {
  const bridge = createStdioCall(exe, join(dir, 'state.json'));
  t.after(() => bridge.close().catch(() => {}));
  return { bridge, client: createHelperClient((line) => bridge.call(line)) };
}
const seed = async (bridge) => {
  for (const day of DAYS) assert.equal(JSON.parse(await bridge.call(JSON.stringify({ type: 'AddUsage', day }))).type, 'Ok');
};

test('seeded days come back from GetUsage and summarize correctly', T, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-usage-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { bridge, client } = open(t, dir);
  await seed(bridge);

  const res = await client.getUsage('2026-03-02', '2026-03-08');
  assert.equal(res.type, 'Usage');
  assert.deepEqual(res.days, DAYS);

  const range = { from: '2026-03-02', to: '2026-03-08', days: 7 };
  const sum = summarize(res.days, range, '2026-03-08');
  assert.equal(sum.total, 12600);
  assert.equal(sum.topApp.name, 'code.exe');
  assert.equal(sum.topApp.secs, 8400);
  assert.equal(sum.activeDays, 3);
  assert.equal(sum.otherBrowsing, 2400);
});

test('a range with no seeded days is empty and summarizes to zeros', T, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-usage-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { bridge, client } = open(t, dir);
  await seed(bridge);
  const res = await client.getUsage('2026-04-01', '2026-04-07');
  assert.equal(res.type, 'Usage');
  assert.deepEqual(res.days, []);
  const sum = summarize(res.days, { from: '2026-04-01', to: '2026-04-07', days: 7 }, '2026-04-07');
  assert.equal(sum.total, 0);
  assert.equal(sum.activeDays, 0);
  assert.equal(sum.topApp, null);
});

test('a reversed range is rejected with bad-request', T, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-usage-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { client } = open(t, dir);
  await assert.rejects(client.getUsage('2026-03-08', '2026-03-02'), (e) => e.code === 'bad-request');
});

test('restarting the helper on the same state keeps the seeded days', T, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-usage-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = open(t, dir);
  await seed(first.bridge);
  await first.bridge.close(); // shutdown flushes the usage file
  const second = open(t, dir);
  const res = await second.client.getUsage('2026-03-01', '2026-03-31');
  assert.deepEqual(res.days, DAYS);
});
