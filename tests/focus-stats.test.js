import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKey, addDays, rangeFor, previousRange, shiftRange, summarize, deltaVs, formatDuration,
} from '../src/modules/focus/stats.js';

test('dayKey applies the offset (minutes east) at the instant', () => {
  const ms = Date.UTC(2026, 0, 1, 23, 30);
  assert.equal(dayKey(ms, () => 0), '2026-01-01');
  assert.equal(dayKey(ms, () => 60), '2026-01-02');
  assert.equal(dayKey(ms, () => -300), '2026-01-01');
  assert.equal(dayKey(Date.UTC(2026, 0, 1, 2), () => -300), '2025-12-31');
  assert.equal(dayKey(Date.UTC(1969, 11, 31, 23), () => 0), '1969-12-31');
});

test('addDays crosses month, year and leap boundaries', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-11-11', 0), '2026-11-11');
});

test('rangeFor day and week (Monday start)', () => {
  assert.deepEqual(rangeFor('day', '2026-11-11'), { from: '2026-11-11', to: '2026-11-11', days: 1 });
  assert.deepEqual(rangeFor('week', '2026-11-11'), { from: '2026-11-09', to: '2026-11-15', days: 7 });
  assert.deepEqual(rangeFor('week', '2026-11-09'), { from: '2026-11-09', to: '2026-11-15', days: 7 });
  assert.deepEqual(rangeFor('week', '2026-11-15'), { from: '2026-11-09', to: '2026-11-15', days: 7 }); // Sunday
  assert.deepEqual(rangeFor('week', '2027-01-01'), { from: '2026-12-28', to: '2027-01-03', days: 7 });
});

test('rangeFor month and year incl. leap years', () => {
  assert.deepEqual(rangeFor('month', '2024-02-10'), { from: '2024-02-01', to: '2024-02-29', days: 29 });
  assert.equal(rangeFor('month', '2026-02-10').days, 28);
  assert.deepEqual(rangeFor('month', '2026-12-31'), { from: '2026-12-01', to: '2026-12-31', days: 31 });
  assert.deepEqual(rangeFor('month', '2027-01-01'), { from: '2027-01-01', to: '2027-01-31', days: 31 });
  assert.deepEqual(rangeFor('year', '2026-05-05'), { from: '2026-01-01', to: '2026-12-31', days: 365 });
  assert.equal(rangeFor('year', '2024-05-05').days, 366);
  assert.throws(() => rangeFor('decade', '2026-05-05'));
});

test('previousRange and shiftRange', () => {
  const jan = rangeFor('month', '2027-01-15');
  assert.deepEqual(previousRange('month', jan), { from: '2026-12-01', to: '2026-12-31', days: 31 });
  assert.deepEqual(shiftRange('month', jan, 1), { from: '2027-02-01', to: '2027-02-28', days: 28 });
  assert.deepEqual(shiftRange('month', jan, -13), { from: '2025-12-01', to: '2025-12-31', days: 31 });
  assert.deepEqual(shiftRange('month', jan, 25), { from: '2029-02-01', to: '2029-02-28', days: 28 });
  const wk = rangeFor('week', '2026-11-11');
  assert.deepEqual(previousRange('week', wk), { from: '2026-11-02', to: '2026-11-08', days: 7 });
  assert.deepEqual(shiftRange('week', wk, 2), { from: '2026-11-23', to: '2026-11-29', days: 7 });
  assert.deepEqual(previousRange('day', rangeFor('day', '2026-03-01')), { from: '2026-02-28', to: '2026-02-28', days: 1 });
  assert.deepEqual(previousRange('year', rangeFor('year', '2025-06-01')), { from: '2024-01-01', to: '2024-12-31', days: 366 });
  assert.deepEqual(shiftRange('year', rangeFor('year', '2025-06-01'), 1), { from: '2026-01-01', to: '2026-12-31', days: 365 });
  assert.deepEqual(shiftRange('month', jan, 0), jan);
});

const row = (day, apps = {}, sites = {}, other = 0) => ({
  day,
  total: Object.values(apps).reduce((a, b) => a + b, 0),
  apps, sites, other_browsing: other,
});

test('summarize averages over elapsed days only, empty days count as zero', () => {
  const range = rangeFor('month', '2026-11-10'); // 30 days, 10 elapsed
  const s = summarize([row('2026-11-03', { 'a.exe': 60 }), row('2026-11-10', { 'a.exe': 40 })], range, '2026-11-10');
  assert.equal(s.total, 100);
  assert.equal(s.dailyAverage, 10);
  assert.equal(s.activeDays, 2);
  assert.equal(s.perDay.length, 30);
  assert.equal(s.perDay[0].day, '2026-11-01');
  assert.equal(s.perDay[2].total, 60);
  assert.equal(s.perDay[29].total, 0);
});

test('summarize with today after the range divides by the whole range; before it by zero', () => {
  const range = rangeFor('week', '2026-11-11');
  assert.equal(summarize([row('2026-11-09', { a: 70 })], range, '2026-12-01').dailyAverage, 10);
  const future = summarize([row('2026-11-09', { a: 70 })], range, '2026-11-01');
  assert.equal(future.dailyAverage, 0);
  assert.equal(future.perWeekday.every((x) => x === 0), true);
});

test('summarize empty input gives zeros and null tops', () => {
  const s = summarize([], rangeFor('week', '2026-11-11'), '2026-11-11');
  assert.equal(s.total, 0);
  assert.equal(s.dailyAverage, 0);
  assert.equal(s.activeDays, 0);
  assert.equal(s.topApp, null);
  assert.equal(s.topSite, null);
  assert.deepEqual(s.topApps, []);
  assert.deepEqual(s.topSites, []);
  assert.equal(s.otherBrowsing, 0);
  assert.equal(s.perDay.length, 7);
  assert.deepEqual(s.perWeekday, [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(summarize(undefined, rangeFor('day', '2026-11-11'), '2026-11-11').total, 0);
});

test('summarize top lists are sorted descending and shares sum to 1', () => {
  const range = rangeFor('week', '2026-11-11');
  const s = summarize([
    row('2026-11-09', { 'a.exe': 30, 'b.exe': 10 }, { youtube: 20 }, 5),
    row('2026-11-10', { 'a.exe': 10, 'c.exe': 40 }, { reddit: 60, youtube: 20 }, 7),
  ], range, '2026-11-11');
  assert.deepEqual(s.topApps.map((a) => [a.name, a.secs]), [['a.exe', 40], ['c.exe', 40], ['b.exe', 10]]);
  assert.deepEqual(s.topSites.map((a) => [a.name, a.secs]), [['reddit', 60], ['youtube', 40]]);
  assert.ok(Math.abs(s.topApps.reduce((x, a) => x + a.share, 0) - 1) < 1e-9);
  assert.ok(Math.abs(s.topSites.reduce((x, a) => x + a.share, 0) - 1) < 1e-9);
  assert.equal(s.topApp.name, 'a.exe'); // tie broken by name
  assert.equal(s.topSite.name, 'reddit');
  assert.equal(s.topSite.share, 0.6);
  assert.equal(s.otherBrowsing, 12);
  assert.deepEqual(s.perDay[1].apps, { 'a.exe': 10, 'c.exe': 40 });
});

test('summarize ignores rows outside the range and bad numbers', () => {
  const range = rangeFor('week', '2026-11-11');
  const s = summarize([
    row('2026-11-08', { a: 99 }), row('2026-11-16', { a: 99 }),
    { day: '2026-11-10', total: NaN, apps: { a: -5, b: NaN, c: 3 }, sites: {}, other_browsing: -1 },
  ], range, '2026-11-11');
  assert.equal(s.total, 0);
  assert.deepEqual(s.topApps.map((a) => a.name), ['c']);
  assert.equal(s.otherBrowsing, 0);
});

test('perWeekday averages per weekday over elapsed days only', () => {
  // Month Nov 2026: Nov 1 is a Sunday. Elapsed through Wed Nov 11.
  const range = rangeFor('month', '2026-11-11');
  const s = summarize([
    row('2026-11-02', { a: 100 }), // Mon
    row('2026-11-09', { a: 300 }), // Mon
    row('2026-11-01', { a: 70 }), // Sun (only one Sunday elapsed: Nov 1 and Nov 8)
    row('2026-11-11', { a: 50 }), // Wed
    row('2026-11-18', { a: 999 }), // future Wed: ignored by averages
  ], range, '2026-11-11');
  assert.equal(s.perWeekday[0], 200); // Mon: (100+300)/2
  assert.equal(s.perWeekday[2], 25); // Wed: 50 / 2 elapsed Wednesdays (Nov 4, 11)
  assert.equal(s.perWeekday[6], 35); // Sun: 70 / 2 (Nov 1, 8)
  assert.equal(s.perWeekday[3], 0); // Thu: Nov 5 only, empty
  assert.equal(s.total, 70 + 100 + 300 + 50 + 999); // total still counts rows in range
});

test('perWeekday over a leap-year February', () => {
  const range = rangeFor('month', '2024-02-29'); // Feb 1 2024 is a Thursday; 29 days, all elapsed
  const s = summarize([row('2024-02-29', { a: 90 })], range, '2024-02-29'); // Thu, 5 Thursdays
  assert.equal(s.perWeekday[3], 18);
  assert.equal(s.dailyAverage, 90 / 29);
});

test('deltaVs', () => {
  assert.deepEqual(deltaVs(0, 50), { pct: null, direction: 'none' });
  assert.deepEqual(deltaVs(0, 0), { pct: null, direction: 'none' });
  assert.deepEqual(deltaVs(100, 150), { pct: 50, direction: 'up' });
  assert.deepEqual(deltaVs(200, 150), { pct: -25, direction: 'down' });
  assert.deepEqual(deltaVs(80, 80), { pct: 0, direction: 'same' });
  assert.deepEqual(deltaVs(100, 0), { pct: -100, direction: 'down' });
});

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(59.9), '59s');
  assert.equal(formatDuration(60), '1m');
  assert.equal(formatDuration(720), '12m');
  assert.equal(formatDuration(3599), '59m');
  assert.equal(formatDuration(3600), '1h 0m');
  assert.equal(formatDuration(11520), '3h 12m');
  assert.equal(formatDuration(90061), '25h 1m');
  assert.equal(formatDuration(-5), '0m');
  assert.equal(formatDuration(NaN), '0m');
});
