// Pure draft logic for the schedule editor. No DOM, no clock: callers pass nowMs and tzOffsetAt.
import { validateSchedule } from '../schedule-logic.js';
import { UNLOCK_DELAY_PRESETS_H, resolveDelayHours, lockedWarning } from '../lock-logic.js';

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
export const DEFAULT_LOCKED_DAYS = 28;
export const DEFAULT_DELAY_H = 24;
const WEEKDAYS = [1, 2, 3, 4, 5];

/** @param {object} [schedule] a ScheduleRec to edit @param {{id: number}[]} [lists] lists that still exist */
export function initialDraft(schedule, lists = []) {
  if (!schedule) {
    return {
      name: '', listIds: [], weekdays: [...WEEKDAYS], start: '09:00', end: '17:00',
      lock: 'none', delayPreset: DEFAULT_DELAY_H, delayCustom: '', endsOn: '',
    };
  }
  const known = new Set(lists.map((l) => l.id));
  const hours = Number.isFinite(schedule.unlockDelayMs) ? schedule.unlockDelayMs / HOUR_MS : DEFAULT_DELAY_H;
  const preset = UNLOCK_DELAY_PRESETS_H.includes(hours);
  return {
    id: schedule.id,
    name: schedule.name || '',
    listIds: schedule.listIds.filter((id) => known.has(id)),
    weekdays: [...schedule.weekdays].sort((a, b) => a - b),
    start: schedule.start, end: schedule.end,
    lock: schedule.lock === 'locked' ? 'locked' : 'none',
    delayPreset: preset ? hours : DEFAULT_DELAY_H,
    delayCustom: !preset && Number.isInteger(hours) && hours >= 1 ? String(hours) : '',
    endsOn: schedule.endsOn || '',
  };
}

export function toggleWeekday(draft, d) {
  const has = draft.weekdays.includes(d);
  const weekdays = has ? draft.weekdays.filter((x) => x !== d) : [...draft.weekdays, d];
  return { ...draft, weekdays: weekdays.sort((a, b) => a - b) };
}

/** @param {'weekdays'|'every-day'} preset */
export function applyPreset(draft, preset) {
  return { ...draft, weekdays: preset === 'every-day' ? [0, 1, 2, 3, 4, 5, 6] : [...WEEKDAYS] };
}

export function toggleList(draft, id) {
  const has = draft.listIds.includes(id);
  return { ...draft, listIds: (has ? draft.listIds.filter((x) => x !== id) : [...draft.listIds, id]).sort((a, b) => a - b) };
}

/** 'YYYY-MM-DD' of the local day `days` from today. */
export function dateFromToday(nowMs, tzOffsetAt, days) {
  const day = Math.floor((nowMs + tzOffsetAt(nowMs) * 60000) / DAY_MS);
  return new Date((day + days) * DAY_MS).toISOString().slice(0, 10);
}

/** Switches Normal/Locked. Switching to Locked with no end date fills in today + 28 days. */
export function setLock(draft, lock, nowMs, tzOffsetAt) {
  const endsOn = lock === 'locked' && !draft.endsOn ? dateFromToday(nowMs, tzOffsetAt, DEFAULT_LOCKED_DAYS) : draft.endsOn;
  return { ...draft, lock, endsOn };
}

/** @returns {{ok: true, value: object} | {ok: false, errors: Record<string, string>}} value is the saveSchedule payload */
export function draftToInput(draft, nowMs, tzOffsetAt) {
  const locked = draft.lock === 'locked';
  const delay = resolveDelayHours({ preset: draft.delayPreset, custom: draft.delayCustom });
  const input = {
    name: draft.name, listIds: draft.listIds, weekdays: draft.weekdays, start: draft.start, end: draft.end,
    lock: draft.lock, unlockDelayMs: locked && delay.ok ? delay.hours * HOUR_MS : null,
    endsOn: draft.endsOn || null,
  };
  const v = validateSchedule(input, nowMs, tzOffsetAt);
  if (!v.ok) {
    const errors = { ...v.errors };
    if (locked && !delay.ok && errors.unlock) errors.unlock = delay.message;
    return { ok: false, errors };
  }
  return { ok: true, value: draft.id !== undefined ? { ...v.value, id: draft.id } : v.value };
}

/** The warning shown with the Locked choice. */
export function lockNote(draft) {
  const delay = resolveDelayHours({ preset: draft.delayPreset, custom: draft.delayCustom });
  return lockedWarning(delay.ok ? delay.hours : draft.delayPreset);
}
