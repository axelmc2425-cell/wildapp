// Pure statistics for the Focus Room usage page. Day keys are 'YYYY-MM-DD' strings in the helper's
// local time zone; all day arithmetic is done on UTC day numbers, so no time zone is used here.
// `dayKey` is the single place that applies a UTC offset.

const DAY_MS = 86400000;
const MIN_MS = 60000;

function parts(day) {
  const [y, m, d] = day.split('-').map(Number);
  return { y, m, d };
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

function keyOf(y, m, d) {
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

function toNum(day) {
  const { y, m, d } = parts(day);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function fromNum(n) {
  const dt = new Date(n * DAY_MS);
  return keyOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** The local calendar day of an instant. `tzOffsetAt(utcMs)` returns minutes EAST of UTC. */
export function dayKey(ms, tzOffsetAt) {
  return fromNum(Math.floor((ms + tzOffsetAt(ms) * MIN_MS) / DAY_MS));
}

export function addDays(day, n) {
  return fromNum(toNum(day) + n);
}

// 0 = Monday .. 6 = Sunday
function weekdayIndex(day) {
  return (((toNum(day) + 3) % 7) + 7) % 7; // 1970-01-01 was a Thursday (index 3)
}

function daysBetween(from, to) {
  return toNum(to) - toNum(from) + 1;
}

function monthLength(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** @param {'day'|'week'|'month'|'year'} period @param {string} today day key inside the wanted period */
export function rangeFor(period, today) {
  let from;
  let to;
  const { y, m } = parts(today);
  if (period === 'day') {
    from = today;
    to = today;
  } else if (period === 'week') {
    from = addDays(today, -weekdayIndex(today));
    to = addDays(from, 6);
  } else if (period === 'month') {
    from = keyOf(y, m, 1);
    to = keyOf(y, m, monthLength(y, m));
  } else if (period === 'year') {
    from = keyOf(y, 1, 1);
    to = keyOf(y, 12, 31);
  } else {
    throw new Error(`Unknown period: ${period}`);
  }
  return { from, to, days: daysBetween(from, to) };
}

/** The range `n` periods after (or before, when negative) `range`. */
export function shiftRange(period, range, n) {
  const { y, m } = parts(range.from);
  if (period === 'day') return rangeFor('day', addDays(range.from, n));
  if (period === 'week') return rangeFor('week', addDays(range.from, 7 * n));
  if (period === 'month') {
    const idx = y * 12 + (m - 1) + n;
    return rangeFor('month', keyOf(Math.floor(idx / 12), (idx % 12 + 12) % 12 + 1, 1));
  }
  if (period === 'year') return rangeFor('year', keyOf(y + n, 1, 1));
  throw new Error(`Unknown period: ${period}`);
}

export function previousRange(period, range) {
  return shiftRange(period, range, -1);
}

function ranked(map) {
  const entries = [...map].filter(([, secs]) => secs > 0);
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const sum = entries.reduce((s, [, secs]) => s + secs, 0);
  return entries.map(([name, secs]) => ({ name, secs, share: secs / sum }));
}

function addInto(target, src) {
  for (const [name, secs] of Object.entries(src ?? {})) {
    if (Number.isFinite(secs) && secs > 0) target.set(name, (target.get(name) ?? 0) + secs);
  }
}

/**
 * @param {{day:string,total:number,apps?:object,sites?:object,other_browsing?:number}[]} days helper rows
 * @param {{from:string,to:string,days:number}} range
 * @param {string} today day key; days after it never count towards averages
 */
export function summarize(days, range, today) {
  const byDay = new Map();
  for (const row of days ?? []) {
    if (!row || typeof row.day !== 'string' || row.day < range.from || row.day > range.to) continue;
    const cur = byDay.get(row.day) ?? { total: 0, apps: new Map(), sites: new Map(), other: 0 };
    if (Number.isFinite(row.total) && row.total > 0) cur.total += row.total;
    if (Number.isFinite(row.other_browsing) && row.other_browsing > 0) cur.other += row.other_browsing;
    addInto(cur.apps, row.apps);
    addInto(cur.sites, row.sites);
    byDay.set(row.day, cur);
  }

  const lastElapsed = today < range.to ? today : range.to;
  const elapsed = lastElapsed < range.from ? 0 : daysBetween(range.from, lastElapsed);

  const perDay = [];
  const apps = new Map();
  const sites = new Map();
  const weekdaySum = new Array(7).fill(0);
  const weekdayCount = new Array(7).fill(0);
  let total = 0;
  let otherBrowsing = 0;
  let activeDays = 0;
  const first = toNum(range.from);
  for (let i = 0; i < range.days; i += 1) {
    const day = fromNum(first + i);
    const row = byDay.get(day);
    const dayTotal = row ? row.total : 0;
    perDay.push({
      day,
      total: dayTotal,
      apps: row ? Object.fromEntries(row.apps) : {},
      sites: row ? Object.fromEntries(row.sites) : {},
    });
    if (i < elapsed) {
      const wd = weekdayIndex(day);
      weekdayCount[wd] += 1;
      weekdaySum[wd] += dayTotal;
    }
    if (row) {
      total += dayTotal;
      otherBrowsing += row.other;
      if (dayTotal > 0) activeDays += 1;
      for (const [k, v] of row.apps) apps.set(k, (apps.get(k) ?? 0) + v);
      for (const [k, v] of row.sites) sites.set(k, (sites.get(k) ?? 0) + v);
    }
  }

  const topApps = ranked(apps);
  const topSites = ranked(sites);
  return {
    total,
    dailyAverage: elapsed > 0 ? total / elapsed : 0,
    activeDays,
    topApp: topApps[0] ?? null,
    topSite: topSites[0] ?? null,
    perDay,
    perWeekday: weekdaySum.map((s, i) => (weekdayCount[i] ? s / weekdayCount[i] : 0)),
    topApps,
    topSites,
    otherBrowsing,
  };
}

/** `pct` is signed percent change of current against previous; null when previous is 0. */
export function deltaVs(previousTotal, currentTotal) {
  if (!(previousTotal > 0)) return { pct: null, direction: 'none' };
  const pct = ((currentTotal - previousTotal) / previousTotal) * 100;
  return { pct, direction: pct > 0 ? 'up' : pct < 0 ? 'down' : 'same' };
}

export function formatDuration(secs) {
  const s = Number.isFinite(secs) && secs > 0 ? Math.floor(secs) : 0;
  if (s === 0) return '0m';
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
