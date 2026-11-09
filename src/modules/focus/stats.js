const pad = (n) => String(n).padStart(2, '0');

export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const counts = (s) => s.kind === 'work' && s.completed;

function minutesByDay(sessions) {
  const m = new Map();
  for (const s of sessions) if (counts(s)) m.set(dayKey(s.started), (m.get(dayKey(s.started)) || 0) + s.minutes);
  return m;
}

const shiftDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };

export function todayMinutes(sessions, now) {
  return minutesByDay(sessions).get(dayKey(now)) || 0;
}

export function lastDays(sessions, now, n = 7) {
  const m = minutesByDay(sessions);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = dayKey(shiftDays(now, -i));
    out.push({ day, minutes: m.get(day) || 0 });
  }
  return out;
}

// Consecutive days with a completed work session, ending today (or yesterday if today has none yet).
export function streak(sessions, now) {
  const m = minutesByDay(sessions);
  let i = m.has(dayKey(now)) ? 0 : 1;
  let n = 0;
  while (m.has(dayKey(shiftDays(now, -i)))) { n++; i++; }
  return n;
}

// Longest run of consecutive days with a completed work session, across the whole list.
export function bestStreak(sessions) {
  const days = [...new Set(sessions.filter(counts).map(s => dayKey(s.started)))].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const key of days) {
    const [y, m, d] = key.split('-').map(Number);
    const t = new Date(y, m - 1, d).getTime();
    run = prev !== null && Math.round((t - prev) / 86400000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}

// Work sessions the owner marked as finished in the last n days.
export function finishedCount(sessions, now, n = 7) {
  const since = now - n * 86400000;
  return sessions.filter(s => s.kind === 'work' && s.done && s.started >= since).length;
}

// Progress toward the daily goal, or null when the goal is off (0).
export function goalProgress(minutes, goal) {
  if (!goal) return null;
  return { pct: Math.min(100, Math.round((minutes / goal) * 100)), reached: minutes >= goal };
}
