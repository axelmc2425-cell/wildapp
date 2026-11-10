// Pure logic for recurring schedules: validation, description, next occurrence, lock state.
import { expandSchedule, localDayEnd } from './expand.js';
import { validateUnlockDelay } from './limits.js';

const DAY_MS = 86400000;
const MIN_MS = 60000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_NAME = 60;
const MAX_LOCKED_DAYS = 90;
// Occurrences in a weekly schedule are at most 7 days apart; the extra days cover the overnight look-back.
const NEXT_HORIZON_MS = 9 * DAY_MS;
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SYNTH_LIST = new Map([[0, { id: 0, mode: 'block', items: [{ kind: 'site', value: 'x.com' }] }]]);

// Day number (days since the epoch) of a 'YYYY-MM-DD' string, or null if it is not a real date.
function dateDay(s) {
  const m = DATE_RE.exec(String(s));
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

function localToday(nowMs, tzOffsetAt) {
  return Math.floor((nowMs + tzOffsetAt(nowMs) * MIN_MS) / DAY_MS);
}

/**
 * @param {{ name: string, listIds: number[], weekdays: number[], start: string, end: string,
 *   lock: string, unlockDelayMs: number|null, endsOn: string|null }} input
 */
export function validateSchedule(input, nowMs, tzOffsetAt) {
  const errors = {};
  const name = String(input.name ?? '').trim();
  if (name.length > MAX_NAME) errors.name = `Name can be at most ${MAX_NAME} characters.`;
  const listIds = [...new Set(input.listIds ?? [])].sort((a, b) => a - b);
  if (!listIds.length || !listIds.every((id) => Number.isInteger(id))) errors.listIds = 'Choose at least one list.';
  const weekdays = [...new Set(input.weekdays ?? [])].sort((a, b) => a - b);
  if (!weekdays.length || !weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    errors.weekdays = 'Choose at least one day.';
  }
  if (!TIME_RE.test(String(input.start)) || !TIME_RE.test(String(input.end))) {
    errors.times = 'Enter times as HH:MM.';
  } else if (input.start === input.end) {
    errors.times = 'Start and end must differ.';
  }
  const lock = input.lock;
  let unlockDelayMs = null;
  if (lock !== 'none' && lock !== 'locked') {
    errors.unlock = 'Choose None or Locked.';
  } else if (lock === 'locked') {
    if (validateUnlockDelay('locked', input.unlockDelayMs).ok) unlockDelayMs = input.unlockDelayMs;
    else errors.unlock = 'Choose how long unlocking takes (1 hour to 7 days).';
  }
  const endsOn = input.endsOn || null;
  if (endsOn === null) {
    if (lock === 'locked') errors.endsOn = 'A locked schedule needs an end date.';
  } else {
    const day = dateDay(endsOn);
    const ahead = day === null ? null : day - localToday(nowMs, tzOffsetAt);
    if (ahead === null) errors.endsOn = 'Enter the end date as YYYY-MM-DD.';
    else if (lock === 'locked' && (ahead < 1 || ahead > MAX_LOCKED_DAYS)) {
      errors.endsOn = `A locked schedule must end between 1 and ${MAX_LOCKED_DAYS} days from today.`;
    } else if (ahead < 0) errors.endsOn = 'The end date cannot be in the past.';
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: { name, listIds, weekdays, start: input.start, end: input.end, lock, unlockDelayMs, endsOn },
  };
}

function time12(t) {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** e.g. "Weekdays, 9:00 AM to 5:00 PM", "Mon, Wed, ...", "Every day, ...", "... (overnight)". */
export function describeSchedule(s, listNames) {
  const set = new Set(s.weekdays);
  let days;
  if (set.size === 7) days = 'Every day';
  else if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) days = 'Weekdays';
  else if (set.size === 2 && set.has(0) && set.has(6)) days = 'Weekends';
  else days = [1, 2, 3, 4, 5, 6, 0].filter((d) => set.has(d)).map((d) => DAY_SHORT[d]).join(', ');
  const overnight = s.end <= s.start ? ' (overnight)' : '';
  return `${days}, ${time12(s.start)} to ${time12(s.end)}${overnight}`;
}

// Occurrences of one schedule (windows) from `fromMs`, through the shared expand code.
function occurrences(s, listIds, fromMs, horizonMs, tzOffsetAt) {
  return expandSchedule({ ...s, listIds: listIds.length ? [0] : [] }, SYNTH_LIST, fromMs, horizonMs, tzOffsetAt);
}

/** @returns {{ state: 'running'|'upcoming'|'paused'|'ended', starts?: number, ends?: number }} */
export function nextOccurrence(s, nowMs, tzOffsetAt) {
  if (s.endsOn && nowMs >= localDayEnd(s.endsOn, tzOffsetAt)) return { state: 'ended' };
  if (!s.enabled) return { state: 'paused' };
  const ws = occurrences(s, s.listIds, nowMs - DAY_MS, NEXT_HORIZON_MS, tzOffsetAt)
    .filter((w) => w.ends > nowMs).sort((a, b) => a.starts - b.starts);
  const w = ws[0];
  if (!w) return s.endsOn ? { state: 'ended' } : { state: 'upcoming' };
  return { state: w.starts <= nowMs ? 'running' : 'upcoming', starts: w.starts, ends: w.ends };
}

/** A locked schedule cannot be changed until the end of its end date. */
export function isLockedActive(s, nowMs, tzOffsetAt) {
  return s.lock === 'locked' && !!s.endsOn && nowMs < localDayEnd(s.endsOn, tzOffsetAt);
}

/** Block-shaped objects for running locked occurrences, so the Unlock dialog can treat them like blocks. */
export function scheduleBlocks(schedules, listsById, nowMs, tzOffsetAt) {
  const out = [];
  for (const s of schedules) {
    if (s.lock !== 'locked' || !s.enabled) continue;
    const listIds = s.listIds.filter((id) => listsById.has(id));
    if (!listIds.length) continue;
    for (const w of occurrences(s, listIds, nowMs - DAY_MS, 2 * DAY_MS, tzOffsetAt)) {
      if (!(w.starts <= nowMs && nowMs < w.ends)) continue;
      out.push({
        key: w.id, windowId: w.id, lock: 'locked', unlockDelayMs: s.unlockDelayMs, ids: [],
        listIds, listNames: listIds.map((id) => listsById.get(id).name),
        starts: w.starts, ends: w.ends, state: 'running',
        progress: Math.min(1, Math.max(0, (nowMs - w.starts) / (w.ends - w.starts))),
        scheduleId: s.id,
      });
    }
  }
  return out;
}
