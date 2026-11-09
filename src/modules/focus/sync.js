// Push the next 30 days of focus windows (sessions + expanded schedules) to the helper.
import { sessionToWindow, expandSchedule } from './expand.js';
import { validateWindow } from './limits.js';

const HORIZON_MS = 30 * 86400000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validSchedule(s, list) {
  if (!list) return null;
  let weekdays;
  try { weekdays = typeof s.weekdays === 'string' ? JSON.parse(s.weekdays) : s.weekdays; } catch { return null; }
  if (!Array.isArray(weekdays) || !weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  if (!TIME_RE.test(String(s.start_time)) || !TIME_RE.test(String(s.end_time))) return null;
  return { ...s, weekdays };
}

export async function syncWindows(db, client, nowMs, tzOffsetAt) {
  const [lists, items, sessions, schedules] = await Promise.all([
    db.all('SELECT id, mode FROM focus_lists'),
    db.all('SELECT list_id, kind, value FROM focus_items'),
    db.all('SELECT id, list_id, starts, ends, lock FROM focus_sessions'),
    db.all('SELECT id, list_id, weekdays, start_time, end_time, lock FROM focus_schedules'),
  ]);
  const byId = new Map(lists.map((l) => [l.id, { id: l.id, mode: l.mode, items: [] }]));
  for (const it of items) byId.get(it.list_id)?.items.push({ kind: it.kind, value: it.value });

  const windows = [];
  let skipped = 0;
  for (const s of sessions) {
    const list = byId.get(s.list_id);
    if (!list) { skipped++; continue; }
    windows.push(sessionToWindow(s, list));
  }
  for (const s of schedules) {
    const list = byId.get(s.list_id);
    const sched = validSchedule(s, list);
    if (!sched) { skipped++; continue; }
    try {
      windows.push(...expandSchedule(sched, list, nowMs, HORIZON_MS, tzOffsetAt));
    } catch { skipped++; }
  }
  // The helper rejects a whole push if any window is invalid, so drop invalid ones here.
  const valid = windows.filter((w) => {
    if (validateWindow(w).ok) return true;
    skipped++;
    return false;
  });
  // Windows starting at or beyond the horizon are not yet due; a later sync pushes them.
  const live = valid.filter((w) => w.ends > nowMs && w.starts < nowMs + HORIZON_MS);
  await client.pushWindows(live);
  return { pushed: live.length, skipped };
}
