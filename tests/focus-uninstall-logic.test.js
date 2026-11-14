import test from 'node:test';
import assert from 'node:assert/strict';
import {
  uninstallStatusText, validateWait, isWaitWeakening, formatCountdown, waitParts, partsToWait,
  MIN_WAIT_MS, MAX_WAIT_MS, DEFAULT_WAIT_MS,
} from '../src/modules/focus/uninstall-logic.js';
import { describeUnlockError } from '../src/modules/focus/lock-logic.js';

const H = 3600000;
const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);
const st = (o = {}) => ({ waitMs: 24 * H, pendingAt: null, permitUntil: null, known: true, ...o });

test('constants', () => {
  assert.equal(MIN_WAIT_MS, H);
  assert.equal(MAX_WAIT_MS, 7 * 24 * H);
  assert.equal(DEFAULT_WAIT_MS, 24 * H);
});

test('formatCountdown', () => {
  assert.equal(formatCountdown(24 * H - 60000), '23h 59m');
  assert.equal(formatCountdown(4 * 60000 + 5000), '4m 05s');
  assert.equal(formatCountdown(0), '0s');
  assert.equal(formatCountdown(-5), '0s');
  assert.equal(formatCountdown(9000), '9s');
  assert.equal(formatCountdown(2 * H), '2h 00m');
});

test('validateWait bounds', () => {
  assert.deepEqual(validateWait(H), { ok: true });
  assert.deepEqual(validateWait(7 * 24 * H), { ok: true });
  for (const bad of [H - 1, 7 * 24 * H + 1, NaN, '5', 1.5 * H + 0.5, null, undefined]) {
    const r = validateWait(bad);
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
  }
});

test('isWaitWeakening', () => {
  assert.equal(isWaitWeakening(24 * H, 12 * H), true);
  assert.equal(isWaitWeakening(24 * H, 24 * H), false);
  assert.equal(isWaitWeakening(24 * H, 48 * H), false);
});

test('waitParts round trip', () => {
  assert.deepEqual(waitParts(26 * H), { days: 1, hours: 2 });
  assert.equal(partsToWait({ days: 1, hours: 2 }), 26 * H);
  assert.equal(partsToWait({ days: 0, hours: 1 }), H);
});

test('status text: protected, no pending', () => {
  const r = uninstallStatusText(st(), NOW, 'ok', true);
  assert.match(r.headline, /protected/i);
  assert.match(r.detail, /24 hours/);
  assert.equal(r.tone, 'ok');
});

test('status text: pending countdown', () => {
  const r = uninstallStatusText(st({ pendingAt: NOW + 4 * 60000 + 5000 }), NOW, 'ok', true);
  assert.match(r.headline, /waiting/i);
  assert.match(r.detail, /4m 05s/);
  assert.equal(r.tone, 'warn');
});

test('status text: pending already past is not a countdown', () => {
  const r = uninstallStatusText(st({ pendingAt: NOW - 1000 }), NOW, 'ok', true);
  assert.match(r.headline, /can uninstall/i);
});

test('status text: permit active with clock', () => {
  const until = Date.UTC(2026, 0, 5, 14, 20);
  const r = uninstallStatusText(st({ permitUntil: until }), NOW, 'ok', true, 0);
  assert.match(r.headline, /You can uninstall until 14:20/);
  assert.equal(r.tone, 'open');
});

test('status text: permit expired falls back to protected', () => {
  const r = uninstallStatusText(st({ permitUntil: NOW - 1 }), NOW, 'ok', true);
  assert.match(r.headline, /protected/i);
});

test('status text: no partner hint', () => {
  const r = uninstallStatusText(st(), NOW, 'ok', false);
  assert.match(r.detail, /partner/i);
  assert.match(r.detail, /waiting period/i);
});

test('status text: helper down or unknown never says protected', () => {
  for (const kind of ['not-running', 'unknown', 'timeout', 'unavailable']) {
    const r = uninstallStatusText(st(), NOW, kind, true);
    assert.equal(r.headline, 'Enforcement is not running');
    assert.doesNotMatch(r.headline + r.detail, /protected/i);
    assert.equal(r.tone, 'down');
  }
  const r = uninstallStatusText(st({ known: false }), NOW, 'ok', true);
  assert.equal(r.headline, 'Enforcement is not running');
  assert.doesNotMatch(r.headline + r.detail, /protected/i);
  assert.equal(uninstallStatusText(undefined, NOW, 'ok', true).headline, 'Enforcement is not running');
});

test('error messages', () => {
  assert.equal(describeUnlockError({ code: 'needs-permit' }), "Shortening the wait needs your partner's code or a finished waiting period.");
  assert.equal(describeUnlockError({ code: 'no-pending-uninstall' }), 'There is no waiting period running.');
  assert.match(describeUnlockError({ code: 'bad-request' }), /1 hour|7 days/);
  assert.match(describeUnlockError({ code: 'bad-key' }), /partner key/);
});
