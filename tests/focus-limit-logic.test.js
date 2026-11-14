import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateLimit, toWire, isWeakening, formatLeft, statusText, capParts, partsToCap,
} from '../src/modules/focus/limit-logic.js';

const base = () => ({
  id: 1, name: 'Games', period: 'daily', capSecs: 3600, lock: 'none', unlockDelayMs: null,
  enabled: true, apps: ['game.exe', 'b.exe'], sites: ['youtube.com'],
});
const v = (patch) => validateLimit({ ...base(), ...patch });

test('validateLimit accepts a good limit', () => {
  assert.deepEqual(v({}), { ok: true, errors: {} });
});

test('validateLimit name', () => {
  assert.ok(v({ name: '' }).errors.name);
  assert.ok(v({ name: '   ' }).errors.name);
  assert.ok(v({ name: 'x'.repeat(65) }).errors.name);
  assert.equal(v({ name: 'x'.repeat(64) }).ok, true);
  assert.ok(v({ name: 'a\nb' }).errors.name);
});

test('validateLimit items', () => {
  assert.ok(v({ apps: [], sites: [] }).errors.items);
  const many = (n) => Array.from({ length: n }, (_, i) => `a${i}.exe`);
  assert.equal(v({ apps: many(100), sites: [] }).ok, true);
  assert.ok(v({ apps: many(100), sites: ['x.com'] }).errors.items);
  assert.ok(v({ apps: many(50), sites: Array.from({ length: 51 }, (_, i) => `s${i}.com`) }).errors.items);
  assert.ok(v({ sites: ['a b.com'] }).errors.items);
  assert.ok(v({ apps: ['C:\\x.exe'] }).errors.items);
});

test('validateLimit cap bounds', () => {
  assert.ok(v({ capSecs: 59 }).errors.cap);
  assert.equal(v({ capSecs: 60 }).ok, true);
  assert.equal(v({ capSecs: 86400 }).ok, true);
  assert.ok(v({ capSecs: 86401 }).errors.cap);
  assert.equal(v({ period: 'weekly', capSecs: 168 * 3600 }).ok, true);
  assert.ok(v({ period: 'weekly', capSecs: 168 * 3600 + 1 }).errors.cap);
  assert.ok(v({ period: 'monthly' }).errors.cap);
});

test('validateLimit delay rules', () => {
  assert.ok(v({ lock: 'locked', unlockDelayMs: null }).errors.delay);
  assert.ok(v({ lock: 'locked', unlockDelayMs: 3_599_999 }).errors.delay);
  assert.equal(v({ lock: 'locked', unlockDelayMs: 3_600_000 }).ok, true);
  assert.equal(v({ lock: 'locked', unlockDelayMs: 604_800_000 }).ok, true);
  assert.ok(v({ lock: 'locked', unlockDelayMs: 604_800_001 }).errors.delay);
  assert.ok(v({ lock: 'none', unlockDelayMs: 3_600_000 }).errors.delay);
  assert.ok(v({ lock: 'frozen' }).errors.delay);
});

test('toWire shape', () => {
  assert.deepEqual(toWire(base()), {
    id: 'limit-1', name: 'Games', apps: ['game.exe', 'b.exe'], sites: ['youtube.com'],
    period: 'daily', cap_secs: 3600, lock: 'none',
  });
  const w = toWire({ ...base(), id: 7, lock: 'locked', unlockDelayMs: 3_600_000 });
  assert.equal(w.id, 'limit-7');
  assert.equal(w.unlock_delay_ms, 3_600_000);
  assert.ok(!('unlock_delay_ms' in toWire(base())));
});

test('isWeakening matches the Rust table', () => {
  const old = { ...base(), capSecs: 3600, apps: ['a.exe', 'b.exe'], sites: [] };
  const mod = (p) => ({ ...old, apps: [...old.apps], sites: [...old.sites], ...p });
  assert.equal(isWeakening(old, mod({})), false);
  assert.equal(isWeakening(old, mod({ name: 'renamed' })), false);
  assert.equal(isWeakening(old, mod({ capSecs: 7200 })), true);
  assert.equal(isWeakening(old, mod({ capSecs: 1800 })), false);
  assert.equal(isWeakening(old, mod({ apps: ['a.exe'] })), true);
  assert.equal(isWeakening(old, mod({ apps: ['a.exe', 'b.exe', 'c.exe'] })), false);
  assert.equal(isWeakening(old, mod({ apps: ['a.exe'], sites: ['youtube.com'] })), true);
  assert.equal(isWeakening(old, mod({ period: 'weekly' })), true);
  assert.equal(isWeakening({ ...old, lock: 'locked', unlockDelayMs: 3_600_000 }, mod({ lock: 'none', unlockDelayMs: null })), true);
  assert.equal(isWeakening(old, mod({ apps: ['A.EXE', 'b.exe'] })), false);
  // wait changes
  const lk = { ...old, lock: 'locked', unlockDelayMs: 86_400_000 };
  assert.equal(isWeakening(lk, { ...lk, unlockDelayMs: 3_600_000 }), true);
  assert.equal(isWeakening(lk, { ...lk, unlockDelayMs: 172_800_000 }), false);
  assert.equal(isWeakening(lk, { ...lk, unlockDelayMs: 86_400_000 }), false);
  assert.equal(isWeakening(old, lk), false);
});

test('formatLeft', () => {
  assert.equal(formatLeft(0, 3600), '1h 0m left');
  assert.equal(formatLeft(600, 3600), '50m left');
  assert.equal(formatLeft(60, 3660), '1h 0m left');
  assert.equal(formatLeft(3540, 3600), '1m left');
  assert.equal(formatLeft(3600, 3600), 'Used up');
  assert.equal(formatLeft(4000, 3600), 'Used up');
  assert.equal(formatLeft(0, 3540), '59m left');
});

test('statusText never claims numbers when the helper is down', () => {
  const st = { used_secs: 10, cap_secs: 3600, blocked: false };
  for (const k of ['not-running', 'unavailable', 'timeout', 'unknown', 'persist-failed']) {
    const r = statusText(base(), st, k);
    assert.equal(r.text, 'Enforcement is not running');
    assert.ok(!/\d/.test(r.text));
    assert.equal(r.tone, 'warn');
  }
});

test('statusText with a live helper', () => {
  assert.deepEqual(statusText(base(), { used_secs: 600, cap_secs: 3600, blocked: false }, 'ok'), { text: '50m left', tone: 'ok' });
  const b = statusText(base(), { used_secs: 3600, cap_secs: 3600, blocked: true, period_ends_day: '2026-11-15' }, 'ok');
  assert.equal(b.tone, 'blocked');
  assert.match(b.text, /^Used up/);
  assert.match(b.text, /2026-11-15/);
  assert.equal(statusText({ ...base(), enabled: false }, undefined, 'ok').tone, 'muted');
  assert.equal(statusText(base(), undefined, 'ok').tone, 'muted');
});

test('statusText says nothing is being counted when usage tracking is off', () => {
  const r = statusText(base(), { used_secs: 600, cap_secs: 3600, blocked: false }, 'ok', true);
  assert.deepEqual(r, { text: 'Not counting right now', tone: 'warn' });
  assert.ok(!/left/.test(r.text));
  // A block that already holds is still reported; a paused limit stays paused.
  assert.equal(statusText(base(), { used_secs: 3600, cap_secs: 3600, blocked: true }, 'ok', true).tone, 'blocked');
  assert.equal(statusText({ ...base(), enabled: false }, undefined, 'ok', true).text, 'Paused');
  assert.equal(statusText(base(), { used_secs: 600, cap_secs: 3600, blocked: false }, 'ok', false).tone, 'ok');
});

test('capParts and partsToCap', () => {
  assert.deepEqual(capParts(5400), { hours: 1, minutes: 30 });
  assert.deepEqual(capParts(60), { hours: 0, minutes: 1 });
  assert.equal(partsToCap({ hours: 1, minutes: 30 }), 5400);
  assert.equal(partsToCap({ hours: 24, minutes: 0 }), 86400);
  assert.equal(partsToCap(capParts(7260)), 7260);
});
