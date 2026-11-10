// Expand focus sessions and recurring schedules into concrete windows (pure).
import { normalizeDomain, normalizeApp } from './match.js';
import { normalizeFolder } from './folders.js';

const DAY_MS = 86400000;
const MIN_MS = 60000;

/** @typedef {{ id: number, mode: 'block'|'allow', items: { kind: 'site'|'app'|'folder', value: string }[] }} List */

function listTargets(list) {
  const sites = new Set();
  const apps = new Set();
  const folders = new Set();
  for (const item of list.items) {
    if (item.kind === 'site') {
      const d = normalizeDomain(item.value);
      if (d) sites.add(d);
    } else if (item.kind === 'app') {
      const a = typeof item.value === 'string' && item.value.trim() ? normalizeApp(item.value) : null;
      if (a) apps.add(a);
    } else if (item.kind === 'folder') {
      const f = normalizeFolder(item.value);
      if (f) folders.add(f);
    }
  }
  return { sites: [...sites], apps: [...apps], folders: [...folders] };
}

/** @returns {import('./limits.js').Window} */
export function sessionToWindow(session, list) {
  const { sites, apps, folders } = listTargets(list);
  const w = { id: 's' + session.id, starts: session.starts, ends: session.ends, lock: session.lock, mode: list.mode, sites, apps };
  if (folders.length) w.app_folders = folders;
  return w;
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
  const folders = new Set();
  for (const id of listIds) {
    const t = listTargets(listsById.get(id));
    t.sites.forEach((x) => sites.add(x));
    t.apps.forEach((x) => apps.add(x));
    t.folders.forEach((x) => folders.add(x));
  }
  const w = {
    id: 'b' + starts + '-' + listIds.join('.'), starts, ends, lock: 'locked', mode: 'block',
    sites: [...sites], apps: [...apps], unlock_delay_ms: unlockDelayMs,
  };
  if (folders.size) w.app_folders = [...folders];
  return w;
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

/** Instant of 00:00 local on the day after `endsOn` ('YYYY-MM-DD', inclusive end date). */
export function localDayEnd(endsOn, tzOffsetAt) {
  const [y, m, d] = String(endsOn).split('-').map(Number);
  return wallToUtc(Date.UTC(y, m - 1, d + 1), tzOffsetAt);
}

/**
 * Concrete windows of a recurring schedule overlapping [fromMs, fromMs + horizonMs).
 * Targets are the union over the schedule's lists (missing lists ignored); a disabled schedule, one
 * with no live list, or an occurrence starting at or after the end of `endsOn` yields nothing.
 * @param {{ id: number, listIds: number[], weekdays: number[], start: string, end: string, lock: string,
 *   unlockDelayMs?: number|null, endsOn?: string|null, enabled: boolean }} schedule
 * @param {Map<number, List>} listsById
 */
export function expandSchedule(schedule, listsById, fromMs, horizonMs, tzOffsetAt) {
  if (!schedule.enabled) return [];
  const sites = new Set();
  const apps = new Set();
  const folders = new Set();
  let live = 0;
  for (const id of schedule.listIds) {
    const list = listsById.get(id);
    if (!list) continue;
    live++;
    const t = listTargets(list);
    t.sites.forEach((x) => sites.add(x));
    t.apps.forEach((x) => apps.add(x));
    t.folders.forEach((x) => folders.add(x));
  }
  if (!live) return [];
  const toMs = fromMs + horizonMs;
  const cutoff = schedule.endsOn ? localDayEnd(schedule.endsOn, tzOffsetAt) : Infinity;
  const startOfDay = parseTime(schedule.start);
  const endOfDay = parseTime(schedule.end);
  const overnight = endOfDay <= startOfDay;
  const firstDay = Math.floor((fromMs + tzOffsetAt(fromMs) * MIN_MS) / DAY_MS) - 1;
  const lastDay = Math.floor((toMs + tzOffsetAt(toMs) * MIN_MS) / DAY_MS) + 1;
  const out = [];
  for (let day = firstDay; day <= lastDay; day++) {
    const dayMs = day * DAY_MS;
    if (!schedule.weekdays.includes(new Date(dayMs).getUTCDay())) continue;
    const starts = wallToUtc(dayMs + startOfDay, tzOffsetAt);
    const ends = wallToUtc(dayMs + endOfDay + (overnight ? DAY_MS : 0), tzOffsetAt);
    if (!(ends > starts) || starts >= toMs || ends <= fromMs || starts >= cutoff) continue;
    const w = {
      id: 'c' + schedule.id + '@' + starts, starts, ends,
      lock: schedule.lock, mode: 'block', sites: [...sites], apps: [...apps],
    };
    if (folders.size) w.app_folders = [...folders];
    if (schedule.lock === 'locked') w.unlock_delay_ms = schedule.unlockDelayMs ?? null;
    out.push(w);
  }
  return out;
}
