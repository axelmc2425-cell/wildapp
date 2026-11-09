// Pure helpers for the Focus Room home view (no DOM).

/** The first `max` items and how many more there are. */
export function chipSummary(items, max = 6) {
  const list = Array.isArray(items) ? items : [];
  const m = Number.isInteger(max) && max >= 0 ? max : 6;
  return { shown: list.slice(0, m), more: Math.max(0, list.length - m) };
}

/** Local clock time such as "5:00 PM"; never throws, even for absurd timestamps. */
export function formatClock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'later';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'later';
  try { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return 'later'; }
}

/** Whole minutes left (rounded up), used to announce the countdown once a minute. */
export function minutesLeft(msLeft) {
  if (typeof msLeft !== 'number' || !Number.isFinite(msLeft) || msLeft <= 0) return 0;
  return Math.ceil(msLeft / 60000);
}
