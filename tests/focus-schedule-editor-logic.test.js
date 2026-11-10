import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialDraft, toggleWeekday, applyPreset, setLock, draftToInput, lockNote, dateFromToday,
} from '../src/modules/focus/ui/schedule-editor-logic.js';

const utc = () => 0;
const NOW = Date.UTC(2026, 10, 10, 12, 0); // Tue 2026-11-10
const lists = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];

test('new draft defaults to weekdays 9 to 5, not locked, no lists', () => {
  const d = initialDraft(undefined, lists);
  assert.deepEqual(d.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(d.start, '09:00');
  assert.equal(d.end, '17:00');
  assert.equal(d.lock, 'none');
  assert.deepEqual(d.listIds, []);
  assert.equal(d.endsOn, '');
  assert.equal(d.id, undefined);
});

test('editing a schedule prefills it and drops lists that no longer exist', () => {
  const d = initialDraft({ id: 7, name: 'Work', listIds: [1, 9], weekdays: [3, 1], start: '08:00', end: '12:00', lock: 'locked', unlockDelayMs: 6 * 3600000, endsOn: '2026-12-01', enabled: true }, lists);
  assert.equal(d.id, 7);
  assert.deepEqual(d.listIds, [1]);
  assert.deepEqual(d.weekdays, [1, 3]);
  assert.equal(d.delayPreset, 6);
  assert.equal(d.delayCustom, '');
  const c = initialDraft({ id: 8, name: '', listIds: [1], weekdays: [1], start: '08:00', end: '12:00', lock: 'locked', unlockDelayMs: 5 * 3600000, endsOn: '2026-12-01' }, lists);
  assert.equal(c.delayCustom, '5');
});

test('toggleWeekday and presets', () => {
  let d = initialDraft(undefined, lists);
  d = toggleWeekday(d, 6);
  assert.deepEqual(d.weekdays, [1, 2, 3, 4, 5, 6]);
  d = toggleWeekday(d, 1);
  assert.deepEqual(d.weekdays, [2, 3, 4, 5, 6]);
  assert.deepEqual(applyPreset(d, 'every-day').weekdays, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(applyPreset(d, 'weekdays').weekdays, [1, 2, 3, 4, 5]);
});

test('switching to Locked fills endsOn with today + 28 days and keeps a chosen one', () => {
  assert.equal(dateFromToday(NOW, utc, 28), '2026-12-08');
  const d = setLock(initialDraft(undefined, lists), 'locked', NOW, utc);
  assert.equal(d.lock, 'locked');
  assert.equal(d.endsOn, '2026-12-08');
  assert.equal(d.delayPreset, 24);
  assert.equal(setLock({ ...d, endsOn: '2026-11-20' }, 'locked', NOW, utc).endsOn, '2026-11-20');
  assert.equal(setLock(d, 'none', NOW, utc).endsOn, '2026-12-08');
});

test('draftToInput returns the exact saveSchedule payload', () => {
  const d = { ...initialDraft(undefined, lists), name: ' Work ', listIds: [2, 1] };
  assert.deepEqual(draftToInput(d, NOW, utc), {
    ok: true,
    value: { name: 'Work', listIds: [1, 2], weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', lock: 'none', unlockDelayMs: null, endsOn: null },
  });
  const locked = setLock({ ...d, id: 4, delayPreset: 6 }, 'locked', NOW, utc);
  assert.deepEqual(draftToInput(locked, NOW, utc).value, {
    id: 4, name: 'Work', listIds: [1, 2], weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '17:00',
    lock: 'locked', unlockDelayMs: 6 * 3600000, endsOn: '2026-12-08',
  });
});

test('draftToInput keys errors by field', () => {
  const bad = { ...initialDraft(undefined, lists), weekdays: [], start: '09:00', end: '09:00' };
  const r = draftToInput(bad, NOW, utc);
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.errors).sort(), ['listIds', 'times', 'weekdays']);
  const noEnd = { ...setLock({ ...initialDraft(undefined, lists), listIds: [1] }, 'locked', NOW, utc), endsOn: '' };
  assert.equal(draftToInput(noEnd, NOW, utc).errors.endsOn, 'A locked schedule needs an end date.');
  const badDelay = { ...setLock({ ...initialDraft(undefined, lists), listIds: [1] }, 'locked', NOW, utc), delayCustom: '999' };
  assert.equal(draftToInput(badDelay, NOW, utc).errors.unlock, 'Enter a whole number of hours from 1 to 168.');
});

test('lockNote reuses the locked warning with the chosen delay', () => {
  const d = initialDraft(undefined, lists);
  assert.match(lockNote(d), /waiting period \(24 hours\)/);
  assert.match(lockNote({ ...d, delayPreset: 1 }), /\(1 hour\)/);
  assert.match(lockNote({ ...d, delayCustom: '5' }), /\(5 hours\)/);
});
