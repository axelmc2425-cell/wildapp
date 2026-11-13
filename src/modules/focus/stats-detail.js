// Pure detail statistics for the Focus Room (hour-of-day averages, focus metrics, timeline layout,
// drill-downs). Builds on stats.js; day keys are 'YYYY-MM-DD' and Monday is weekday 0.
import { addDays, summarize, weekdayIndex } from './stats.js';

const GAP_SECS = 2; // a gap of up to this still counts as one unbroken run

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const hasHours = (row) => !!row && Array.isArray(row.hours) && row.hours.length === 24;
const validDay = (row) => !!row && typeof row.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day);

export function hourlyAverages(days) {
  const sum = new Array(24).fill(0);
  let daysCounted = 0;
  for (const row of days ?? []) {
    if (!hasHours(row)) continue;
    daysCounted += 1;
    for (let h = 0; h < 24; h += 1) sum[h] += num(row.hours[h]);
  }
  return { hours: sum.map((s) => (daysCounted ? s / daysCounted : 0)), daysCounted };
}

export function weekdayHourGrid(days) {
  const sums = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const counts = new Array(7).fill(0);
  for (const row of days ?? []) {
    if (!validDay(row) || !hasHours(row)) continue;
    const wd = weekdayIndex(row.day);
    counts[wd] += 1;
    for (let h = 0; h < 24; h += 1) sums[wd][h] += num(row.hours[h]);
  }
  const grid = sums.map((r, wd) => r.map((s) => (counts[wd] ? s / counts[wd] : 0)));
  return { grid, counts };
}

/**
 * perWeek (perDay * 7) is null until 7 days have elapsed in the range, and perMonth (perDay * 365.25/12,
 * rounded) is null until 28 have: before that they would be extrapolations, not averages.
 */
export function periodAverages(days, range, today) {
  const sum = summarize(days, range, today);
  const lastElapsed = today < range.to ? today : range.to;
  const elapsed = lastElapsed < range.from ? 0 : (Date.parse(lastElapsed) - Date.parse(range.from)) / 86400000 + 1;
  const perApp = [];
  for (const app of sum.topApps) {
    let activeDays = 0;
    for (const d of sum.perDay) if ((d.apps[app.name] ?? 0) > 0) activeDays += 1;
    perApp.push({ name: app.name, perActiveDay: activeDays ? app.secs / activeDays : 0, total: app.secs, activeDays });
  }
  return {
    perDay: sum.dailyAverage,
    perWeekday: sum.perWeekday,
    perWeek: elapsed >= 7 ? sum.dailyAverage * 7 : null,
    perMonth: elapsed >= 28 ? Math.round(sum.dailyAverage * (365.25 / 12)) : null,
    perApp,
  };
}

function cleanStretches(stretches) {
  return (Array.isArray(stretches) ? stretches : [])
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

export function focusMetrics(stretches) {
  const list = cleanStretches(stretches);
  const runs = [];
  let switches = 0;
  let activeSecs = 0;
  for (const s of list) {
    activeSecs += s.end - s.start;
    const last = runs[runs.length - 1];
    if (last && last.exe === s.exe && s.start - last.end <= GAP_SECS) {
      last.end = Math.max(last.end, s.end);
    } else {
      if (last && last.exe !== s.exe && s.start - last.end <= GAP_SECS) switches += 1;
      runs.push({ exe: s.exe, start: s.start, end: s.end });
    }
  }
  let best = null;
  for (const r of runs) if (!best || r.end - r.start > best.end - best.start) best = r;
  return {
    longestStretchSecs: best ? best.end - best.start : 0,
    longestStretchExe: best ? best.exe : null,
    switchesPerActiveHour: activeSecs > 0 ? switches / (activeSecs / 3600) : 0,
    firstStart: list.length ? list[0].start : null,
    lastEnd: list.length ? list.reduce((m, s) => Math.max(m, s.end), -Infinity) : null,
    activeSecs,
    stretchCount: runs.length,
  };
}

export function activeStreaks(days, today) {
  const active = new Set();
  for (const row of days ?? []) {
    if (validDay(row) && row.day <= today && num(row.total) > 0) active.add(row.day);
  }
  const sorted = [...active].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of sorted) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  let cursor = active.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (active.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  return { current, best };
}

export function timelineWindow(stretches, fromSec, toSec) {
  const out = [];
  for (const s of cleanStretches(stretches)) {
    const start = Math.max(s.start, fromSec);
    const end = Math.min(s.end, toSec);
    if (end > start) out.push({ start, end, exe: s.exe, site: s.site ?? null });
  }
  return out;
}

/**
 * Joins adjacent same-program/site blocks separated by less than `minPx` pixels (merged gaps are drawn through).
 * Every returned block carries `activeSecs` (sum of its constituents' own durations, gaps excluded) and `count`.
 */
export function mergeTiny(blocks, secsPerPx, minPx = 1) {
  const limit = (Number.isFinite(secsPerPx) && secsPerPx > 0 ? secsPerPx : 0) * minPx;
  const out = [];
  for (const b of blocks ?? []) {
    const own = Math.max(0, b.end - b.start);
    const last = out[out.length - 1];
    if (last && last.exe === b.exe && (last.site ?? null) === (b.site ?? null) && b.start - last.end < limit) {
      last.end = Math.max(last.end, b.end);
      last.activeSecs += own;
      last.count += 1;
    } else {
      out.push({ ...b, activeSecs: own, count: 1 });
    }
  }
  return out;
}

const BROWSERS = new Set(['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe']);
const baseName = (exe) => String(exe).split(/[\\/]/).pop().toLowerCase();
const isBrowser = (exe) => BROWSERS.has(baseName(exe));

/**
 * `kind` is 'app' or 'site'. `sites` lists sites only for a browser; `sitesApproximate` is true when more
 * than one browser has usage, because site totals are not attributed per browser.
 */
export function appDrilldown(days, name, kind) {
  const key = kind === 'site' ? 'sites' : 'apps';
  const byDay = new Map(); // duplicate rows for one day are merged
  for (const row of days ?? []) {
    if (!validDay(row)) continue;
    const cur = byDay.get(row.day) ?? { total: 0, item: 0, sites: {}, browsers: new Set() };
    cur.total += num(row.total);
    cur.item += num(row[key]?.[name]);
    for (const [site, s] of Object.entries(row.sites ?? {})) cur.sites[site] = (cur.sites[site] ?? 0) + num(s);
    for (const [app, s] of Object.entries(row.apps ?? {})) if (num(s) > 0 && isBrowser(app)) cur.browsers.add(baseName(app));
    byDay.set(row.day, cur);
  }
  const browser = kind === 'app' && isBrowser(name);
  let total = 0;
  let grand = 0;
  const daily = [];
  const sites = new Map();
  const browsers = new Set();
  for (const day of [...byDay.keys()].sort()) {
    const r = byDay.get(day);
    grand += r.total;
    r.browsers.forEach((b) => browsers.add(b));
    if (r.item <= 0) continue;
    total += r.item;
    daily.push({ day, secs: r.item });
    if (browser) for (const [site, s] of Object.entries(r.sites)) if (s > 0) sites.set(site, (sites.get(site) ?? 0) + s);
  }
  return {
    total,
    activeDays: daily.length,
    perActiveDay: daily.length ? total / daily.length : 0,
    shareOfTotal: grand > 0 ? total / grand : 0,
    daily,
    sites: [...sites].map(([n, secs]) => ({ name: n, secs })).sort((a, b) => b.secs - a.secs || (a.name < b.name ? -1 : 1)),
    sitesApproximate: browser && browsers.size > 1,
  };
}

/**
 * The hour (0-23) in which the item's own stretches add up to the most seconds, or null when it has none.
 * `hourOf(unixSec)` gives the local hour of an instant; stretches are split at hour changes found by
 * probing every 60 s and bisecting to the exact second, so the split is exact.
 */
export function itemPeakHour(stretches, name, kind, hourOf) {
  const want = String(name).toLowerCase();
  const secs = new Array(24).fill(0);
  for (const s of cleanStretches(stretches)) {
    const match = kind === 'site' ? s.site != null && String(s.site).toLowerCase() === want : String(s.exe).toLowerCase() === want;
    if (!match) continue;
    let from = s.start;
    while (from < s.end) {
      const h = hourOf(from);
      let hi = Math.min(from + 60, s.end);
      if (hourOf(hi - 1) === h) { // no change inside this slice (a change then back within 60 s is not expected)
        secs[h] += hi - from;
        from = hi;
        continue;
      }
      let lo = from; // hourOf(lo) === h, hourOf(hi - 1) !== h: find the first second with another hour
      let top = hi - 1;
      while (top - lo > 1) {
        const mid = Math.floor((lo + top) / 2);
        if (hourOf(mid) === h) lo = mid; else top = mid;
      }
      secs[h] += top - from;
      from = top;
    }
  }
  let peak = null;
  let max = 0;
  secs.forEach((v, h) => { if (v > max) { max = v; peak = h; } });
  return peak;
}

const p2 = (n) => String(n).padStart(2, '0');

export function formatDurationSecs(secs) {
  const s = Number.isFinite(secs) && secs > 0 ? Math.floor(secs) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${p2(m)}m ${p2(r)}s`;
  if (m > 0) return `${m}m ${p2(r)}s`;
  return `${r}s`;
}
