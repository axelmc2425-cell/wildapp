// End-to-end: uninstall protection through the real focus-helper (stdio), with its clock moved by the
// test-clock build's AdvanceClock. Needs `--features test-clock`. Stop-gating (service Stop) cannot be
// observed over stdio and is covered by the Windows checklist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStdioCall } from '../scripts/helper-bridge.mjs';
import { generatePartnerKeys, signUnlock } from '../src/modules/focus/unlock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = ['focus-helper', 'focus-helper.exe'].map((n) => join(root, 'target', 'debug', n)).find(existsSync);
const HOUR = 3600000;
const MIN = 60000;
const DAY = 24 * HOUR;

async function probe() {
  if (!exe) return 'focus-helper binary not built';
  const dir = mkdtempSync(join(tmpdir(), 'focus-uninstall-probe-'));
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
const T = { skip: await probe() };

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'focus-uninstall-e2e-'));
  const bridges = [];
  t.after(async () => {
    for (const b of bridges) await b.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  let bridge;
  const open = () => { bridge = createStdioCall(exe, join(dir, 'state.json')); bridges.push(bridge); };
  open();
  const send = async (req) => JSON.parse(await bridge.call(JSON.stringify(req)));
  const ok = async (req) => { const r = await send(req); assert.notEqual(r.type, 'Error', JSON.stringify(r)); return r; };
  const status = async () => (await ok({ type: 'GetStatus' }));
  const advance = (ms) => ok({ type: 'AdvanceClock', ms });
  const restart = async () => { await bridge.close(); open(); };
  const errCode = async (req) => { const r = await send(req); assert.equal(r.type, 'Error', JSON.stringify(r)); return r.code; };
  return { send, ok, status, advance, restart, errCode };
}

test('default status: 24 h wait, nothing pending, no permit', T, async (t) => {
  const { status } = setup(t);
  const s = await status();
  assert.deepEqual(s.uninstall, { wait_ms: DAY, pending_at: null, permit_until: null });
});

test('request is now + wait, a repeat returns the same, cancel clears, second cancel errors', T, async (t) => {
  const { send, ok, status, errCode } = setup(t);
  const before = (await status()).now_ms;
  const r = await ok({ type: 'RequestUninstallDelay' });
  const after = (await status()).now_ms;
  assert.equal(r.type, 'UninstallPending');
  // The helper's clock runs in real time: the request time lies between the two readings.
  assert.ok(r.unlock_at >= before + DAY && r.unlock_at <= after + DAY, `unlock_at ${r.unlock_at}`);
  assert.equal((await status()).uninstall.pending_at, r.unlock_at);
  const again = await ok({ type: 'RequestUninstallDelay' });
  assert.equal(again.unlock_at, r.unlock_at);
  assert.equal((await send({ type: 'CancelUninstallDelay' })).type, 'Ok');
  assert.equal((await status()).uninstall.pending_at, null);
  assert.equal(await errCode({ type: 'CancelUninstallDelay' }), 'no-pending-uninstall');
});

test('waiting route: no permit before unlock_at, 60 minute permit after, gone after it', T, async (t) => {
  const { ok, status, advance } = setup(t);
  const { unlock_at } = await ok({ type: 'RequestUninstallDelay' });
  const before = (await status()).now_ms;
  await advance(unlock_at - before - 1000);
  let s = await status();
  assert.equal(s.uninstall.permit_until, null);
  assert.equal(s.uninstall.pending_at, unlock_at);
  await advance(2000);
  s = await status();
  assert.equal(s.uninstall.permit_until, unlock_at + HOUR);
  assert.equal(s.uninstall.pending_at, null);
  await advance(HOUR + 1000);
  s = await status();
  assert.equal(s.uninstall.permit_until, null);
});

test('SetUninstallWait: raise ok, lower needs a permit, bounds are bad-request', T, async (t) => {
  const { ok, status, advance, errCode } = setup(t);
  await ok({ type: 'SetUninstallWait', wait_ms: 2 * DAY });
  assert.equal((await status()).uninstall.wait_ms, 2 * DAY);
  assert.equal(await errCode({ type: 'SetUninstallWait', wait_ms: DAY }), 'needs-permit');
  assert.equal(await errCode({ type: 'SetUninstallWait', wait_ms: 3599999 }), 'bad-request');
  assert.equal(await errCode({ type: 'SetUninstallWait', wait_ms: 604800001 }), 'bad-request');
  assert.equal((await status()).uninstall.wait_ms, 2 * DAY);
  // Get a live permit through the waiting route, then lowering works.
  const { unlock_at } = await ok({ type: 'RequestUninstallDelay' });
  await advance(unlock_at - (await status()).now_ms + 1000);
  assert.notEqual((await status()).uninstall.permit_until, null);
  await ok({ type: 'SetUninstallWait', wait_ms: DAY });
  assert.equal((await status()).uninstall.wait_ms, DAY);
});

test('partner route: no windows needed, 30 minute permit, token single use, other target grants nothing', T, async (t) => {
  const { ok, status, send } = setup(t);
  const keys = await generatePartnerKeys();
  await ok({ type: 'SetPartner', public_key: keys.publicKey });
  assert.equal((await status()).windows.length, 0);
  const sign = async (code) => signUnlock(keys.privateKeyJwk, code, (await status()).now_ms);

  const c = await ok({ type: 'RequestChallenge', window_id: 'uninstall' });
  assert.equal(c.type, 'Challenge');
  const token = await sign(c.code);
  const before = (await status()).now_ms;
  await ok({ type: 'SubmitToken', token });
  const s = await status();
  // The helper's clock keeps running in real time, so the grant time lies between the two readings.
  assert.ok(s.uninstall.permit_until >= before + 30 * MIN && s.uninstall.permit_until <= s.now_ms + 30 * MIN, `permit_until ${s.uninstall.permit_until}`);
  const again = await send({ type: 'SubmitToken', token });
  assert.equal(again.type, 'Error');
  assert.equal(again.code, 'used');
});

test('a token signed for a window challenge does not grant an uninstall permit', T, async (t) => {
  const { ok, status } = setup(t);
  const keys = await generatePartnerKeys();
  await ok({ type: 'SetPartner', public_key: keys.publicKey });
  const now = (await status()).now_ms;
  await ok({ type: 'PushWindows', windows: [{ id: 'w1', starts: now - MIN, ends: now + 4 * HOUR, lock: 'locked', mode: 'block', sites: ['reddit.com'], apps: [], unlock_delay_ms: HOUR }] });
  const c = await ok({ type: 'RequestChallenge', window_id: 'w1' });
  const token = await signUnlock(keys.privateKeyJwk, c.code, (await status()).now_ms);
  await ok({ type: 'SubmitToken', token });
  const s = await status();
  assert.equal(s.uninstall.permit_until, null);
});

test('restart on the same state keeps pending and a live permit', T, async (t) => {
  const { ok, status, advance, restart } = setup(t);
  const { unlock_at } = await ok({ type: 'RequestUninstallDelay' });
  await restart();
  let s = await status();
  assert.equal(s.uninstall.pending_at, unlock_at);
  await advance(unlock_at - s.now_ms + 1000);
  const permit = (await status()).uninstall.permit_until;
  assert.equal(permit, unlock_at + HOUR);
  await restart();
  s = await status();
  assert.equal(s.uninstall.permit_until, permit);
});
