import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hourlyAverages, weekdayHourGrid, periodAverages, focusMetrics, activeStreaks,
  timelineWindow, mergeTiny, appDrilldown, itemPeakHour, formatDurationSecs,
} from '../src/modules/focus/stats-detail.js';
import { rangeFor } from '../src/modules/focus/stats.js';

const hrs = (map) => { const a = new Array(24).fill(0); for (const [h, v] of Object.entries(map)) a[h] = v; return a; };
const row = (day, total, extra = {}) => ({ day, total, apps: {}, sites: {}, other_browsing: 0, ...extra });
const allFinite = (v) => {
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(allFinite);
  if (v && typeof v === 'object') return Object.values(v).every(allFinite);
  return true;
};

test('hourlyAverages averages only days with a 24-long hours array', () => {
  const r = hourlyAverages([
    row('2026-11-09', 3600, { hours: hrs({ 14: 3600 }) }),
    row('2026-11-10', 1800, { hours: hrs({ 14: 1800 }) }),
    row('2026-11-11', 999, { hours: [] }),
    row('2026-11-12', 999),
  ]);
  assert.equal(r.daysCounted, 2);
  assert.equal(r.hours.length, 24);
  assert.equal(r.hours[14], 2700);
  assert.equal(r.hours[3], 0);
});

test('hourlyAverages on empty input is zeros', () => {
  const r = hourlyAverages([]);
  assert.equal(r.daysCounted, 0);
  assert.deepEqual(r.hours, new Array(24).fill(0));
  assert.ok(allFinite(hourlyAverages(undefined)));
});

test('weekdayHourGrid is Monday-based with per-weekday counts', () => {
  // 2026-11-09 is a Monday, 2026-11-16 the next Monday, 2026-11-15 a Sunday.
  const g = weekdayHourGrid([
    row('2026-11-09', 1, { hours: hrs({ 9: 3600 }) }),
    row('2026-11-16', 1, { hours: hrs({ 9: 1800 }) }),
    row('2026-11-15', 1, { hours: hrs({ 20: 600 }) }),
    row('2026-11-10', 1),
  ]);
  assert.equal(g.grid.length, 7);
  assert.ok(g.grid.every((r) => r.length === 24));
  assert.equal(g.grid[0][9], 2700);
  assert.equal(g.grid[6][20], 600);
  assert.deepEqual(g.counts, [2, 0, 0, 0, 0, 0, 1]);
  assert.ok(allFinite(weekdayHourGrid([])));
});

test('periodAverages counts empty days up to today as zero and averages apps over days used', () => {
  const range = rangeFor('week', '2026-11-11'); // Mon 09 .. Sun 15; today Wed 11
  const days = [
    row('2026-11-09', 3600, { apps: { 'a.exe': 3600 } }),
    row('2026-11-11', 7200, { apps: { 'a.exe': 3600, 'b.exe': 3600 } }),
  ];
  const r = periodAverages(days, range, '2026-11-11');
  assert.equal(r.perDay, 3600); // 10800 / 3 elapsed days
  assert.equal(r.perWeek, null); // only 3 days elapsed: not an average yet
  assert.equal(r.perMonth, null);
  assert.equal(r.perWeekday.length, 7);
  assert.equal(r.perWeekday[0], 3600);
  assert.equal(r.perWeekday[1], 0);
  assert.deepEqual(r.perApp.map((a) => a.name), ['a.exe', 'b.exe']);
  assert.deepEqual(r.perApp[0], { name: 'a.exe', perActiveDay: 3600, total: 7200, activeDays: 2 });
  assert.deepEqual(r.perApp[1], { name: 'b.exe', perActiveDay: 3600, total: 3600, activeDays: 1 });
  const empty = periodAverages([], range, '2026-11-01'); // today before the range
  assert.ok(allFinite(empty));
  assert.equal(empty.perDay, 0);
  assert.deepEqual(empty.perApp, []);
});

test('focusMetrics merges adjacent same-program stretches and counts program changes', () => {
  const m = focusMetrics([
    { start: 0, end: 600, exe: 'A', site: null },
    { start: 600, end: 900, exe: 'A', site: null },
    { start: 900, end: 960, exe: 'B', site: null },
  ]);
  assert.equal(m.longestStretchSecs, 900);
  assert.equal(m.longestStretchExe, 'A');
  assert.equal(m.activeSecs, 960);
  assert.equal(m.stretchCount, 2);
  assert.equal(m.firstStart, 0);
  assert.equal(m.lastEnd, 960);
  assert.equal(m.switchesPerActiveHour, 1 / (960 / 3600));
});

test('focusMetrics: site changes inside a browser do not break a stretch or count as switches', () => {
  const m = focusMetrics([
    { start: 0, end: 100, exe: 'chrome.exe', site: 'a.com' },
    { start: 101, end: 300, exe: 'chrome.exe', site: 'b.com' }, // 1 s gap is still one run
  ]);
  assert.equal(m.longestStretchSecs, 300);
  assert.equal(m.stretchCount, 1);
  assert.equal(m.switchesPerActiveHour, 0);
});

test('focusMetrics: a gap over 2 s splits a run of the same program', () => {
  const m = focusMetrics([
    { start: 0, end: 100, exe: 'A', site: null },
    { start: 103, end: 150, exe: 'A', site: null },
  ]);
  assert.equal(m.longestStretchSecs, 100);
  assert.equal(m.stretchCount, 2);
  assert.equal(m.switchesPerActiveHour, 0);
});

test('focusMetrics on nothing is all zeros and finite', () => {
  for (const input of [[], undefined, [{ start: 5, end: 5, exe: 'A', site: null }]]) {
    const m = focusMetrics(input);
    assert.ok(allFinite(m));
    assert.equal(m.longestStretchSecs, 0);
    assert.equal(m.switchesPerActiveHour, 0);
    assert.equal(m.activeSecs, 0);
    assert.equal(m.stretchCount, 0);
    assert.equal(m.longestStretchExe, null);
    assert.equal(m.firstStart, null);
    assert.equal(m.lastEnd, null);
  }
});

test('activeStreaks: a gap resets current but keeps best', () => {
  const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-08', '2026-11-09'].map((d) => row(d, 60));
  days.push(row('2026-11-06', 0));
  assert.deepEqual(activeStreaks(days, '2026-11-09'), { current: 2, best: 4 });
  assert.deepEqual(activeStreaks(days, '2026-11-12'), { current: 0, best: 4 });
});

test('activeStreaks: an idle today does not break a streak that ran up to yesterday', () => {
  const days = ['2026-11-07', '2026-11-08'].map((d) => row(d, 60));
  assert.deepEqual(activeStreaks(days, '2026-11-09'), { current: 2, best: 2 });
  assert.deepEqual(activeStreaks([], '2026-11-09'), { current: 0, best: 0 });
});

test('timelineWindow clips to the window and drops empty pieces', () => {
  const s = [
    { start: 50, end: 150, exe: 'A', site: null },
    { start: 150, end: 160, exe: 'B', site: 's.com' },
    { start: 300, end: 400, exe: 'C', site: null },
    { start: 0, end: 100, exe: 'D', site: null },
  ];
  const w = timelineWindow(s, 100, 200);
  assert.deepEqual(w, [
    { start: 100, end: 150, exe: 'A', site: null },
    { start: 150, end: 160, exe: 'B', site: 's.com' },
  ]);
  assert.deepEqual(timelineWindow(undefined, 0, 10), []);
});

test('mergeTiny merges adjacent same-key blocks across sub-pixel gaps', () => {
  const blocks = [
    { start: 0, end: 10, exe: 'A', site: null },
    { start: 10, end: 20, exe: 'A', site: null },
    { start: 20.5, end: 30, exe: 'A', site: null }, // 0.5 s gap at 1 s/px: invisible
    { start: 30, end: 40, exe: 'B', site: null },
    { start: 45, end: 50, exe: 'B', site: null }, // 5 px gap stays
  ];
  assert.deepEqual(mergeTiny(blocks, 1), [
    { start: 0, end: 30, exe: 'A', site: null, activeSecs: 29.5, count: 3 },
    { start: 30, end: 40, exe: 'B', site: null, activeSecs: 10, count: 1 },
    { start: 45, end: 50, exe: 'B', site: null, activeSecs: 5, count: 1 },
  ]);
  assert.deepEqual(mergeTiny([], 1), []);
});

test('appDrilldown summarises one app across days', () => {
  const days = [
    row('2026-11-09', 4000, { apps: { 'chrome.exe': 3000, 'a.exe': 1000 }, sites: { 'x.com': 2000, 'y.com': 500 }, hours: hrs({ 9: 3000, 10: 1000 }) }),
    row('2026-11-10', 2000, { apps: { 'a.exe': 2000 }, hours: hrs({ 11: 2000 }) }),
    row('2026-11-11', 2000, { apps: { 'chrome.exe': 1000 }, sites: { 'x.com': 500 } }),
  ];
  const d = appDrilldown(days, 'chrome.exe', 'app');
  assert.equal(d.total, 4000);
  assert.equal(d.activeDays, 2);
  assert.equal(d.perActiveDay, 2000);
  assert.equal(d.shareOfTotal, 0.5);
  assert.equal(d.sitesApproximate, false);
  assert.equal('peakHour' in d, false);
  assert.deepEqual(d.daily, [{ day: '2026-11-09', secs: 3000 }, { day: '2026-11-11', secs: 1000 }]);
  assert.deepEqual(d.sites, [{ name: 'x.com', secs: 2500 }, { name: 'y.com', secs: 500 }]);

  const s = appDrilldown(days, 'x.com', 'site');
  assert.equal(s.total, 2500);
  assert.equal(s.activeDays, 2);
  assert.deepEqual(s.sites, []);

  const none = appDrilldown(days, 'nope.exe', 'app');
  assert.ok(allFinite(none));
  assert.equal(none.total, 0);
  assert.deepEqual(none.daily, []);
  assert.equal(appDrilldown([], 'a', 'app').shareOfTotal, 0);
});

test('periodAverages perWeek/perMonth appear only after 7 / 28 elapsed days', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => row(`2026-11-${String(i + 1).padStart(2, '0')}`, 3600));
  const at = (n) => periodAverages(mk(n), rangeFor('month', '2026-11-01'), `2026-11-${String(n).padStart(2, '0')}`);
  assert.deepEqual([at(1).perWeek, at(1).perMonth], [null, null]);
  assert.deepEqual([at(6).perWeek, at(6).perMonth], [null, null]);
  assert.deepEqual([at(7).perWeek, at(7).perMonth], [3600 * 7, null]);
  assert.deepEqual([at(28).perWeek, at(28).perMonth], [3600 * 7, Math.round(3600 * 365.25 / 12)]);
});

test('appDrilldown: only exact browser exe names are browsers; two browsers flag approximate sites', () => {
  const days = [row('2026-11-09', 100, { apps: { 'chrome.exe': 50, 'firefox.exe': 40, 'knowledge.exe': 5, 'search.exe': 5 }, sites: { 'x.com': 60 } })];
  assert.deepEqual(appDrilldown(days, 'knowledge.exe', 'app').sites, []);
  assert.deepEqual(appDrilldown(days, 'search.exe', 'app').sites, []);
  const c = appDrilldown(days, 'CHROME.EXE', 'app');
  assert.equal(c.total, 0); // names are exact keys; case only matters for browser detection
  const c2 = appDrilldown(days, 'chrome.exe', 'app');
  assert.deepEqual(c2.sites, [{ name: 'x.com', secs: 60 }]);
  assert.equal(c2.sitesApproximate, true);
});

test('appDrilldown merges duplicate rows for the same day', () => {
  const d = appDrilldown([row('2026-11-09', 10, { apps: { 'a.exe': 10 } }), row('2026-11-09', 20, { apps: { 'a.exe': 20 } })], 'a.exe', 'app');
  assert.equal(d.activeDays, 1);
  assert.deepEqual(d.daily, [{ day: '2026-11-09', secs: 30 }]);
  assert.equal(d.perActiveDay, 30);
  assert.equal(d.shareOfTotal, 1);
});

test('itemPeakHour sums the item own seconds per local hour, splitting at hour boundaries', () => {
  const hourOf = (t) => Math.floor(t / 3600) % 24;
  const st = [
    { start: 0 * 3600, end: 5 * 3600, exe: 'busy.exe', site: null }, // busiest hours overall: 0-4
    { start: 7 * 3600 + 3000, end: 8 * 3600 + 1000, exe: 'A.exe', site: 's.com' }, // 600 s in h7, 1000 s in h8
    { start: 8 * 3600 + 2000, end: 8 * 3600 + 2300, exe: 'a.exe', site: null },     // +300 in h8
    { start: 9 * 3600, end: 9 * 3600 + 1200, exe: 'other.exe', site: 's.com' },     // 1200 in h9
  ];
  assert.equal(itemPeakHour(st, 'a.exe', 'app', hourOf), 8);
  assert.equal(itemPeakHour(st, 'busy.exe', 'app', hourOf), 0);
  assert.equal(itemPeakHour(st, 's.com', 'site', hourOf), 9); // 600 + 1000 across 7/8 vs 1200 in h9
  assert.equal(itemPeakHour(st, 'nope.exe', 'app', hourOf), null);
  assert.equal(itemPeakHour([], 'a.exe', 'app', hourOf), null);
  assert.equal(itemPeakHour(undefined, 'a.exe', 'app', hourOf), null);
  // a stretch that crosses an hour exactly: 30 s before, 90 s after
  assert.equal(itemPeakHour([{ start: 3570, end: 3690, exe: 'z.exe', site: null }], 'z.exe', 'app', hourOf), 1);
});

test('focusMetrics: a program change after an idle gap is a resume, not a switch', () => {
  const m = focusMetrics([
    { start: 0, end: 600, exe: 'A', site: null },
    { start: 600 + 1800, end: 3000, exe: 'B', site: null },
  ]);
  assert.equal(m.switchesPerActiveHour, 0);
  assert.equal(m.stretchCount, 2);
});

test('formatDurationSecs', () => {
  assert.equal(formatDurationSecs(3849), '1h 04m 09s');
  assert.equal(formatDurationSecs(0), '0s');
  assert.equal(formatDurationSecs(42), '42s');
  assert.equal(formatDurationSecs(185), '3m 05s');
  assert.equal(formatDurationSecs(3600), '1h 00m 00s');
  assert.equal(formatDurationSecs(NaN), '0s');
  assert.equal(formatDurationSecs(-5), '0s');
  assert.equal(formatDurationSecs(59), '59s');
  assert.equal(formatDurationSecs(60), '1m 00s');
  assert.equal(formatDurationSecs(3661), '1h 01m 01s');
  assert.equal(formatDurationSecs(86400), '24h 00m 00s');
  assert.equal(formatDurationSecs(90061), '25h 01m 01s');
});
