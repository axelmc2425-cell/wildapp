// SM-2 spaced repetition. Days are local calendar days written 'YYYY-MM-DD'.
export const GRADES = { again: 1, hard: 3, good: 4, easy: 5 };

const pad = (n) => String(n).padStart(2, '0');

export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + n));
}

// card: { ease, interval, reps }. Returns the card's next { ease, interval, reps, due }.
export function review(card, quality, today) {
  if (quality < 3) {
    return { ease: Math.max(1.3, card.ease - 0.2), interval: 1, reps: 0, due: addDays(today, 1) };
  }
  const reps = card.reps + 1;
  const ease = Math.max(1.3, card.ease + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  const interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(card.interval * ease);
  return { ease, interval, reps, due: addDays(today, interval) };
}
