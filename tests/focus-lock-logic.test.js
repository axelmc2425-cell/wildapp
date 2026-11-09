import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNLOCK_DELAY_PRESETS_H, resolveDelayHours, lockedWarning, describeUnlockError,
  windowIdForBlock, pendingUnlockFor, canStartLocked,
} from '../src/modules/focus/lock-logic.js';
import { lockedBlockToWindow } from '../src/modules/focus/expand.js';
import { groupSessions } from '../src/modules/focus/model.js';

test('presets', () => assert.deepEqual(UNLOCK_DELAY_PRESETS_H, [1, 6, 24]));

test('resolveDelayHours bounds', () => {
  assert.equal(resolveDelayHours({ custom: '0' }).ok, false);
  assert.deepEqual(resolveDelayHours({ custom: '1' }), { ok: true, hours: 1 });
  assert.deepEqual(resolveDelayHours({ custom: '168' }), { ok: true, hours: 168 });
  const over = resolveDelayHours({ custom: '169' });
  assert.equal(over.ok, false);
  assert.match(over.message, /1 to 168/);
  assert.equal(resolveDelayHours({ custom: '2.5' }).ok, false);
  assert.deepEqual(resolveDelayHours({ custom: '', preset: 6 }), { ok: true, hours: 6 });
  assert.equal(resolveDelayHours({ custom: '' }).ok, false);
  assert.deepEqual(resolveDelayHours({ custom: '12', preset: 6 }), { ok: true, hours: 12 });
  assert.equal(resolveDelayHours(undefined).ok, false);
});

test('lockedWarning', () => {
  assert.equal(lockedWarning(24), "You can't cancel this. Only your partner's code, or the waiting period (24 hours), ends it early.");
  assert.ok(lockedWarning(24).includes('24 hours'));
  assert.ok(lockedWarning(1).includes('1 hour'));
});

test('describeUnlockError covers every code and never throws', () => {
  const codes = ['bad-format', 'bad-signature', 'wrong-challenge', 'wrong-lock', 'used', 'challenge-expired', 'expired',
    'no-partner', 'no-such-lock', 'lock-active', 'bad-key', 'not-delayable', 'no-pending-unlock', 'bad-window', 'unreachable', 'persist-failed'];
  const seen = new Set();
  for (const code of codes) {
    const s = describeUnlockError(Object.assign(new Error('raw helper text'), { code }));
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 20, code);
    assert.ok(!s.includes('raw helper text'), code);
    seen.add(s);
  }
  assert.equal(seen.size, codes.length);
  for (const code of ['bad-format', 'bad-signature', 'wrong-challenge', 'wrong-lock', 'used', 'challenge-expired', 'expired']) {
    assert.match(describeUnlockError({ code }), /lock (is still|stays)/i, code);
  }
  assert.equal(describeUnlockError({ code: 'weird', message: 'helper says hi' }), 'helper says hi');
  for (const g of [null, undefined, 5, 'x', {}, [], { code: 7 }, { message: {} }, Symbol('s'), () => 1]) {
    assert.doesNotThrow(() => describeUnlockError(g));
    assert.equal(typeof describeUnlockError(g), 'string');
  }
});

test('windowIdForBlock equals lockedBlockToWindow id', () => {
  const lists = [{ id: 10, name: 'A', mode: 'block', items: [{ kind: 'site', value: 'a.com' }] },
    { id: 2, name: 'B', mode: 'block', items: [{ kind: 'site', value: 'b.com' }] }];
  const sessions = [
    { id: 1, listId: 10, starts: 1000, ends: 5000, lock: 'locked', unlockDelayMs: 3600000 },
    { id: 2, listId: 2, starts: 1000, ends: 5000, lock: 'locked', unlockDelayMs: 3600000 },
    { id: 3, listId: 10, starts: 1000, ends: 5000, lock: 'locked', unlockDelayMs: 3600000 },
  ];
  const [block] = groupSessions(sessions, lists, 0);
  const win = lockedBlockToWindow(sessions, new Map(lists.map((l) => [l.id, l])));
  assert.equal(windowIdForBlock(block), win.id);
  assert.equal(win.id, 'b1000-2.10');
});

test('pendingUnlockFor', () => {
  const st = { pending_unlocks: [{ window_id: 'w', unlock_at: 42 }, { window_id: 'bad', unlock_at: 'x' }] };
  assert.equal(pendingUnlockFor(st, 'w'), 42);
  assert.equal(pendingUnlockFor(st, 'other'), null);
  assert.equal(pendingUnlockFor(st, 'bad'), null);
  for (const s of [null, undefined, {}, { pending_unlocks: null }, { pending_unlocks: 'x' }, { pending_unlocks: [null, 3] }]) {
    assert.equal(pendingUnlockFor(s, 'w'), null);
  }
});

test('canStartLocked needs all four', () => {
  const ok = { selectedIds: [1], duration: { ok: true, minutes: 60 }, delay: { ok: true, hours: 24 }, confirmed: true };
  assert.equal(canStartLocked(ok), true);
  assert.equal(canStartLocked({ ...ok, selectedIds: [] }), false);
  assert.equal(canStartLocked({ ...ok, selectedIds: undefined }), false);
  assert.equal(canStartLocked({ ...ok, duration: { ok: false } }), false);
  assert.equal(canStartLocked({ ...ok, duration: undefined }), false);
  assert.equal(canStartLocked({ ...ok, delay: { ok: false } }), false);
  assert.equal(canStartLocked({ ...ok, delay: undefined }), false);
  assert.equal(canStartLocked({ ...ok, confirmed: false }), false);
  assert.equal(canStartLocked({ ...ok, confirmed: 'yes' }), false);
  assert.equal(canStartLocked({ ...ok, duration: { ok: true, minutes: 10080 } }), true);
  assert.equal(canStartLocked({ ...ok, duration: { ok: true, minutes: 10081 } }), false);
  assert.equal(canStartLocked(undefined), false);
});
