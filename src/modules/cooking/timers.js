// Kitchen timers as plain data. All functions are pure; `now` is a timestamp in ms.
export function addTimer(list, { label, seconds }, now) {
  const id = list.reduce((m, t) => Math.max(m, t.id), 0) + 1;
  return [...list, { id, label, seconds, endsAt: now + seconds * 1000, done: false }];
}

export const remainingSeconds = (t, now) => Math.max(0, Math.ceil((t.endsAt - now) / 1000));
export const expiredIds = (list, now) => list.filter(t => !t.done && t.endsAt <= now).map(t => t.id);
export const markDone = (list, id) => list.map(t => (t.id === id ? { ...t, done: true } : t));
export const removeTimer = (list, id) => list.filter(t => t.id !== id);
