import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSchedule, describeSchedule, nextOccurrence, isLockedActive, scheduleBlocks,
} from '../src/modules/focus/schedule-logic.js';

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});
function ny(utcMs) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}
const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.UTC(2026, 0, 6, 17); // Tue 2026-01-06 12:00 EST
const rec = (o = {}) => ({
  id: 7, name: 'Work', listIds: [1], weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', lock: 'none',
  unlockDelayMs: null, endsOn: null, enabled: true, ...o,
});
const input = (o = {}) => ({
  name: 'Work', listIds: [1], weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', lock: 'none',
  unlockDelayMs: null, endsOn: null, ...o,
});

test('validateSchedule accepts a good unlocked input and normalizes it', () => {
  const r = validateSchedule(input({ name: '  Work  ', listIds: [2, 1, 2], weekdays: [5, 1, 1] }), NOW, ny);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, input({ listIds: [1, 2], weekdays: [1, 5] }));
});

test('validateSchedule errors', () => {
  const err = (o) => {
    const r = validateSchedule(input(o), NOW, ny);
    assert.equal(r.ok, false);
    return r.errors;
  };
  assert.ok(err({ listIds: [] }).listIds);
  assert.ok(err({ weekdays: [] }).weekdays);
  assert.ok(err({ weekdays: [7] }).weekdays);
  assert.ok(err({ start: '09:00', end: '09:00' }).times);
  assert.ok(err({ start: '9:00' }).times);
  assert.ok(err({ end: '24:00' }).times);
  assert.ok(err({ name: 'x'.repeat(61) }).name);
  assert.equal(validateSchedule(input({ name: 'x'.repeat(60) }), NOW, ny).ok, true);
  const L = { lock: 'locked', unlockDelayMs: H };
  assert.ok(err({ ...L, endsOn: null }).endsOn);
  assert.ok(err({ ...L, endsOn: '2026-01-06' }).endsOn); // today
  assert.ok(err({ ...L, endsOn: '2026-04-07' }).endsOn); // 91 days ahead
  assert.ok(err({ ...L, endsOn: 'nope' }).endsOn);
  assert.ok(err({ lock: 'locked', unlockDelayMs: H - 1, endsOn: '2026-01-10' }).unlock);
  assert.ok(err({ lock: 'locked', unlockDelayMs: null, endsOn: '2026-01-10' }).unlock);
  assert.ok(err({ lock: 'frozen' }).unlock);
});

test('validateSchedule locked boundaries and unlocked end date', () => {
  const L = { lock: 'locked', unlockDelayMs: H };
  assert.equal(validateSchedule(input({ ...L, endsOn: '2026-01-07' }), NOW, ny).ok, true); // 1 day ahead
  assert.equal(validateSchedule(input({ ...L, endsOn: '2026-04-06' }), NOW, ny).ok, true); // 90 days ahead
  assert.equal(validateSchedule(input({ endsOn: '2026-01-06' }), NOW, ny).ok, true);
  assert.equal(validateSchedule(input({ endsOn: '2026-01-05' }), NOW, ny).ok, false); // past
  const r = validateSchedule(input({ unlockDelayMs: 5 * H }), NOW, ny);
  assert.equal(r.value.unlockDelayMs, null); // unlocked carries no delay
});

test('validateSchedule treats today by the local zone, not UTC', () => {
  const lateNy = Date.UTC(2026, 0, 7, 3); // Tue 22:00 EST, already Wed in UTC
  const r = validateSchedule(input({ lock: 'locked', unlockDelayMs: H, endsOn: '2026-01-07' }), lateNy, ny);
  assert.equal(r.ok, true); // local today is 01-06
});

test('describeSchedule', () => {
  assert.equal(describeSchedule(rec(), []), 'Weekdays, 9:00 AM to 5:00 PM');
  assert.equal(describeSchedule(rec({ weekdays: [0, 1, 2, 3, 4, 5, 6] }), []), 'Every day, 9:00 AM to 5:00 PM');
  assert.equal(describeSchedule(rec({ weekdays: [3, 1] }), []), 'Mon, Wed, 9:00 AM to 5:00 PM');
  assert.equal(describeSchedule(rec({ weekdays: [0, 6] }), []), 'Weekends, 9:00 AM to 5:00 PM');
  assert.equal(describeSchedule(rec({ start: '23:00', end: '06:00' }), []), 'Weekdays, 11:00 PM to 6:00 AM (overnight)');
  assert.equal(describeSchedule(rec({ start: '00:00', end: '12:30' }), []), 'Weekdays, 12:00 AM to 12:30 PM');
});

test('nextOccurrence before, during and after an occurrence', () => {
  const s = rec();
  let r = nextOccurrence(s, Date.UTC(2026, 0, 5, 12), ny); // Mon 07:00 EST
  assert.equal(r.state, 'upcoming');
  assert.equal(iso(r.starts), '2026-01-05T14:00:00.000Z');
  assert.equal(iso(r.ends), '2026-01-05T22:00:00.000Z');
  r = nextOccurrence(s, Date.UTC(2026, 0, 5, 15), ny);
  assert.equal(r.state, 'running');
  assert.equal(iso(r.starts), '2026-01-05T14:00:00.000Z');
  r = nextOccurrence(s, Date.UTC(2026, 0, 5, 23), ny); // after Monday's, next is Tuesday
  assert.equal(r.state, 'upcoming');
  assert.equal(iso(r.starts), '2026-01-06T14:00:00.000Z');
});

test('nextOccurrence finds a next occurrence days away', () => {
  const r = nextOccurrence(rec({ weekdays: [1] }), NOW, ny); // Tuesday; next Monday 01-12
  assert.equal(r.state, 'upcoming');
  assert.equal(iso(r.starts), '2026-01-12T14:00:00.000Z');
});

test('nextOccurrence overnight started the previous day is running', () => {
  const s = rec({ weekdays: [1], start: '23:00', end: '06:00' });
  const r = nextOccurrence(s, Date.UTC(2026, 0, 6, 7), ny); // Tue 02:00 EST
  assert.equal(r.state, 'running');
  assert.equal(iso(r.starts), '2026-01-06T04:00:00.000Z'); // Mon 23:00 EST
  assert.equal(iso(r.ends), '2026-01-06T11:00:00.000Z'); // Tue 06:00 EST
});

test('nextOccurrence ended and paused', () => {
  assert.deepEqual(nextOccurrence(rec({ endsOn: '2026-01-05' }), NOW, ny), { state: 'ended' });
  assert.deepEqual(nextOccurrence(rec({ enabled: false }), NOW, ny), { state: 'paused' });
  assert.deepEqual(nextOccurrence(rec({ enabled: false, endsOn: '2026-01-05' }), NOW, ny), { state: 'ended' });
  // On the end date itself it still runs; once the day is over it has ended.
  assert.equal(nextOccurrence(rec({ endsOn: '2026-01-06' }), Date.UTC(2026, 0, 6, 15), ny).state, 'running');
  assert.equal(nextOccurrence(rec({ endsOn: '2026-01-06' }), Date.UTC(2026, 0, 6, 23), ny).state, 'ended');
});

test('nextOccurrence on the spring-forward day', () => {
  const s = rec({ weekdays: [0], start: '02:30', end: '03:30' });
  const r = nextOccurrence(s, Date.UTC(2026, 2, 8, 6), ny); // Sun 01:00 EST
  assert.equal(r.state, 'upcoming');
  assert.equal(iso(r.starts), '2026-03-08T07:00:00.000Z');
  assert.equal(iso(r.ends), '2026-03-08T07:30:00.000Z');
});

test('isLockedActive', () => {
  assert.equal(isLockedActive({ lock: 'locked', endsOn: '2026-01-06' }, NOW, ny), true); // end date is inclusive
  assert.equal(isLockedActive({ lock: 'locked', endsOn: '2026-01-05' }, NOW, ny), false);
  assert.equal(isLockedActive({ lock: 'none', endsOn: '2026-01-31' }, NOW, ny), false);
  assert.equal(isLockedActive({ lock: 'locked', endsOn: null }, NOW, ny), false);
  assert.equal(isLockedActive({ lock: 'locked', endsOn: '2026-01-06' }, Date.UTC(2026, 0, 7, 5), ny), false); // 00:00 local next day
});

test('scheduleBlocks returns one block per running locked occurrence', () => {
  const lists = new Map([[1, { name: 'Social' }], [2, { name: 'News' }]]);
  const s = rec({ lock: 'locked', unlockDelayMs: 2 * H, endsOn: '2026-01-31', listIds: [1, 2] });
  const now = Date.UTC(2026, 0, 6, 18); // Tue 13:00 EST, 4h into 8h
  const bs = scheduleBlocks([s], lists, now, ny);
  assert.equal(bs.length, 1);
  const starts = Date.UTC(2026, 0, 6, 14);
  assert.deepEqual(bs[0], {
    key: 'c7@' + starts, windowId: 'c7@' + starts, lock: 'locked', unlockDelayMs: 2 * H, ids: [],
    listIds: [1, 2], listNames: ['Social', 'News'], starts, ends: Date.UTC(2026, 0, 6, 22),
    state: 'running', progress: 0.5, scheduleId: 7,
  });
});

test('scheduleBlocks is empty when unlocked, paused, ended or not running', () => {
  const lists = new Map([[1, { name: 'Social' }]]);
  const L = { lock: 'locked', unlockDelayMs: H, endsOn: '2026-01-31' };
  assert.deepEqual(scheduleBlocks([rec()], lists, NOW, ny), []);
  assert.deepEqual(scheduleBlocks([rec(L)], lists, Date.UTC(2026, 0, 6, 23), ny), []); // after hours
  assert.deepEqual(scheduleBlocks([rec({ ...L, enabled: false })], lists, NOW, ny), []);
  assert.deepEqual(scheduleBlocks([rec({ ...L, endsOn: '2026-01-05' })], lists, NOW, ny), []);
  assert.equal(scheduleBlocks([rec(L), rec({ ...L, id: 8 })], lists, NOW, ny).length, 2);
});
