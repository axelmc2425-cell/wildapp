// Expand focus sessions and recurring schedules into concrete windows (pure).
import { normalizeDomain, normalizeApp } from './match.js';

const DAY_MS = 86400000;
const MIN_MS = 60000;

/** @typedef {{ id: number, mode: 'block'|'allow', items: { kind: 'site'|'app', value: string }[] }} List */

function listTargets(list) {
  const sites = new Set();
  const apps = new Set();
  for (const item of list.items) {
    if (item.kind === 'site') {
      const d = normalizeDomain(item.value);
      if (d) sites.add(d);
    } else if (item.kind === 'app') {
      const a = typeof item.value === 'string' && item.value.trim() ? normalizeApp(item.value) : null;
      if (a) apps.add(a);
    }
  }
  return { sites: [...sites], apps: [...apps] };
}

/** @returns {import('./limits.js').Window} */
export function sessionToWindow(session, list) {
  const { sites, apps } = listTargets(list);
  return { id: 's' + session.id, starts: session.starts, ends: session.ends, lock: session.lock, mode: list.mode, sites, apps };
}

/**
 * One window for a locked block: sessions sharing starts, ends, lock and unlockDelayMs, one per list.
 * The id depends only on the block (times and the sorted list ids), never on row order.
 * @param {{ listId: number, starts: number, ends: number, unlockDelayMs: number|null }[]} sessions
 * @param {Map<number, List>} listsById
 * @returns {import('./limits.js').Window}
 */
export function lockedBlockToWindow(sessions, listsById) {
  const { starts, ends, unlockDelayMs } = sessions[0];
  const listIds = [...new Set(sessions.map((s) => s.listId))].sort((a, b) => a - b);
  const sites = new Set();
  const apps = new Set();
  for (const id of listIds) {
    const t = listTargets(listsById.get(id));
    t.sites.forEach((x) => sites.add(x));
    t.apps.forEach((x) => apps.add(x));
  }
  return {
    id: 'b' + starts + '-' + listIds.join('.'), starts, ends, lock: 'locked', mode: 'block',
    sites: [...sites], apps: [...apps], unlock_delay_ms: unlockDelayMs,
  };
}

// Convert wall-clock time (expressed as if it were UTC ms) to a UTC instant.
// Ambiguous (fall-back) times resolve to the first occurrence; times in a
// spring-forward gap resolve to the first instant after the gap.
function wallToUtc(localMs, tzOffsetAt) {
  const guess = localMs - tzOffsetAt(localMs) * MIN_MS;
  const utc = localMs - tzOffsetAt(guess) * MIN_MS;
  if (utc + tzOffsetAt(utc) * MIN_MS === localMs) return utc;
  // Gap: offsets differ between utc and guess; find the first minute using the later offset.
  const target = tzOffsetAt(Math.max(utc, guess));
  let lo = Math.min(utc, guess);
  let hi = Math.max(utc, guess);
  while (hi - lo > MIN_MS) {
    const mid = lo + Math.floor((hi - lo) / MIN_MS / 2) * MIN_MS;
    if (tzOffsetAt(mid) === target) hi = mid;
    else lo = mid;
  }
  return hi;
}

function parseTime(t) {
  const [h, m] = String(t).split(':').map(Number);
  return (h * 60 + m) * MIN_MS;
}

export function expandSchedule(schedule, list, fromMs, horizonMs, tzOffsetAt) {
  const { sites, apps } = listTargets(list);
  const toMs = fromMs + horizonMs;
  const startOfDay = parseTime(schedule.start_time);
  const endOfDay = parseTime(schedule.end_time);
  const overnight = endOfDay <= startOfDay;
  const firstDay = Math.floor((fromMs + tzOffsetAt(fromMs) * MIN_MS) / DAY_MS) - 1;
  const lastDay = Math.floor((toMs + tzOffsetAt(toMs) * MIN_MS) / DAY_MS) + 1;
  const out = [];
  for (let day = firstDay; day <= lastDay; day++) {
    const dayMs = day * DAY_MS;
    if (!schedule.weekdays.includes(new Date(dayMs).getUTCDay())) continue;
    const starts = wallToUtc(dayMs + startOfDay, tzOffsetAt);
    const ends = wallToUtc(dayMs + endOfDay + (overnight ? DAY_MS : 0), tzOffsetAt);
    if (!(ends > starts) || starts >= toMs || ends <= fromMs) continue;
    out.push({
      id: 'c' + schedule.id + '@' + starts, starts, ends,
      lock: schedule.lock, mode: list.mode, sites: [...sites], apps: [...apps],
    });
  }
  return out;
}
