// Push the next 30 days of focus windows (sessions + expanded schedules) to the helper.
import { sessionToWindow, lockedBlockToWindow, expandSchedule } from './expand.js';
import { validateForPush, MAX_WINDOWS } from './limits.js';

const HORIZON_MS = 30 * 86400000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validSchedule(s, list) {
  if (!list) return null;
  let weekdays;
  try { weekdays = typeof s.weekdays === 'string' ? JSON.parse(s.weekdays) : s.weekdays; } catch { return null; }
  if (!Array.isArray(weekdays) || !weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  if (!TIME_RE.test(String(s.start_time)) || !TIME_RE.test(String(s.end_time))) return null;
  // Task 3 replaces this inline conversion with listSchedules rows.
  return {
    id: s.id, name: '', listIds: [s.list_id], weekdays, start: s.start_time, end: s.end_time,
    lock: s.lock, unlockDelayMs: null, endsOn: null, enabled: true,
  };
}

/** Keep one window per id (largest unlock delay, then latest end); a duplicate id would fail the whole push. */
export function dedupeById(windows) {
  const best = new Map();
  for (const w of windows) {
    const p = best.get(w.id);
    const d = w.unlock_delay_ms ?? 0;
    const pd = p ? (p.unlock_delay_ms ?? 0) : 0;
    if (!p || d > pd || (d === pd && w.ends > p.ends)) best.set(w.id, w);
  }
  return { windows: [...best.values()], dropped: windows.length - best.size };
}

export async function syncWindows(db, client, nowMs, tzOffsetAt) {
  const [lists, items, sessions, schedules] = await Promise.all([
    db.all('SELECT id, mode FROM focus_lists'),
    db.all('SELECT list_id, kind, value FROM focus_items'),
    db.all('SELECT id, list_id, starts, ends, lock, unlock_delay_ms FROM focus_sessions'),
    db.all('SELECT id, list_id, weekdays, start_time, end_time, lock FROM focus_schedules'),
  ]);
  const byId = new Map(lists.map((l) => [l.id, { id: l.id, mode: l.mode, items: [] }]));
  for (const it of items) byId.get(it.list_id)?.items.push({ kind: it.kind, value: it.value });

  const windows = [];
  let skipped = 0;
  // Locked sessions sharing starts, ends and unlock delay are one block: one helper window.
  const blocks = new Map();
  for (const s of sessions) {
    const list = byId.get(s.list_id);
    if (!list) { skipped++; continue; }
    if (s.lock === 'locked') {
      const delay = s.unlock_delay_ms ?? null;
      const key = `${s.starts}:${s.ends}:${delay}`;
      if (!blocks.has(key)) blocks.set(key, []);
      blocks.get(key).push({ listId: s.list_id, starts: s.starts, ends: s.ends, unlockDelayMs: delay });
    } else {
      windows.push(sessionToWindow(s, list));
    }
  }
  // Blocks differing only by delay would share a window id (the helper rejects duplicate ids), so
  // they merge into one window with the longest delay.
  const merged = new Map();
  for (const group of blocks.values()) {
    const w = lockedBlockToWindow(group, byId);
    const prev = merged.get(w.id);
    if (!prev || w.unlock_delay_ms > prev.unlock_delay_ms
      || (w.unlock_delay_ms === prev.unlock_delay_ms && w.ends > prev.ends)) merged.set(w.id, w);
  }
  windows.push(...merged.values());
  for (const s of schedules) {
    const list = byId.get(s.list_id);
    const sched = validSchedule(s, list);
    if (!sched) { skipped++; continue; }
    try {
      windows.push(...expandSchedule(sched, byId, nowMs, HORIZON_MS, tzOffsetAt));
    } catch { skipped++; }
  }
  // The helper rejects a whole push if any window is invalid, so drop invalid ones here. That
  // includes frozen windows (the helper rejects them until sub-project 4 ships frozen mode),
  // allow-mode windows without apps, and windows with a bad site or app entry.
  const dd = dedupeById(windows);
  skipped += dd.dropped;
  const valid = dd.windows.filter((w) => {
    if (validateForPush(w).ok) return true;
    skipped++;
    return false;
  });
  // Windows starting at or beyond the horizon are not yet due; a later sync pushes them.
  let live = valid.filter((w) => w.ends > nowMs && w.starts < nowMs + HORIZON_MS);
  // The helper caps a push (and its store) at MAX_WINDOWS; keep the soonest ones.
  if (live.length > MAX_WINDOWS) {
    // Locked windows win over none windows so a new lock never silently fails to push.
    live.sort((a, b) => (b.lock === 'locked') - (a.lock === 'locked') || a.starts - b.starts);
    skipped += live.length - MAX_WINDOWS;
    live = live.slice(0, MAX_WINDOWS);
  }
  await client.pushWindows(live);
  return { pushed: live.length, skipped };
}
