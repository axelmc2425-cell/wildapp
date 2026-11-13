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

/** perWeek is perDay * 7 and perMonth is perDay * 30 (flat conversions of the per-day average). */
export function periodAverages(days, range, today) {
  const sum = summarize(days, range, today);
  const perApp = [];
  for (const app of sum.topApps) {
    let activeDays = 0;
    for (const d of sum.perDay) if ((d.apps[app.name] ?? 0) > 0) activeDays += 1;
    perApp.push({ name: app.name, perActiveDay: activeDays ? app.secs / activeDays : 0, total: app.secs, activeDays });
  }
  return {
    perDay: sum.dailyAverage,
    perWeekday: sum.perWeekday,
    perWeek: sum.dailyAverage * 7,
    perMonth: sum.dailyAverage * 30,
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
      if (last && last.exe !== s.exe) switches += 1;
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
    lastEnd: list.length ? Math.max(...list.map((s) => s.end)) : null,
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

/** Joins adjacent same-program/site blocks separated by less than `minPx` pixels (merged gaps are drawn through). */
export function mergeTiny(blocks, secsPerPx, minPx = 1) {
  const limit = (Number.isFinite(secsPerPx) && secsPerPx > 0 ? secsPerPx : 0) * minPx;
  const out = [];
  for (const b of blocks ?? []) {
    const last = out[out.length - 1];
    if (last && last.exe === b.exe && (last.site ?? null) === (b.site ?? null) && b.start - last.end < limit) {
      last.end = Math.max(last.end, b.end);
    } else {
      out.push({ ...b });
    }
  }
  return out;
}

const BROWSER_RE = /(chrome|msedge|edge|firefox|brave|opera|vivaldi|arc|safari|iexplore)/i;

/** `kind` is 'app' or 'site'. peakHour uses the day-level hours of the days the item was used. */
export function appDrilldown(days, name, kind) {
  const key = kind === 'site' ? 'sites' : 'apps';
  const hourSum = new Array(24).fill(0);
  let anyHours = false;
  let total = 0;
  let grand = 0;
  const daily = [];
  const sites = new Map();
  const browser = kind === 'app' && BROWSER_RE.test(String(name));
  for (const row of [...(days ?? [])].filter(validDay).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    grand += num(row.total);
    const secs = num(row[key]?.[name]);
    if (secs <= 0) continue;
    total += secs;
    daily.push({ day: row.day, secs });
    if (hasHours(row)) {
      anyHours = true;
      for (let h = 0; h < 24; h += 1) hourSum[h] += num(row.hours[h]);
    }
    if (browser) for (const [site, s] of Object.entries(row.sites ?? {})) if (num(s) > 0) sites.set(site, (sites.get(site) ?? 0) + s);
  }
  let peakHour = null;
  if (anyHours) {
    let max = 0;
    hourSum.forEach((v, h) => { if (v > max) { max = v; peakHour = h; } });
  }
  return {
    total,
    activeDays: daily.length,
    perActiveDay: daily.length ? total / daily.length : 0,
    shareOfTotal: grand > 0 ? total / grand : 0,
    peakHour,
    daily,
    sites: [...sites].map(([n, secs]) => ({ name: n, secs })).sort((a, b) => b.secs - a.secs || (a.name < b.name ? -1 : 1)),
  };
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
