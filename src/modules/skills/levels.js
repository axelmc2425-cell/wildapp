// Practice time to level: level n starts at HOURS[n] hours of practice.
const HOURS = [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000];
const NAMES = ['Curious', 'Beginner', 'Learner', 'Practitioner', 'Skilled', 'Proficient', 'Advanced', 'Expert', 'Master', 'Grandmaster'];

export function levelFor(minutes) {
  const hours = minutes / 60;
  let level = 0;
  for (let i = 0; i < HOURS.length; i++) if (hours >= HOURS[i]) level = i;
  const max = level === HOURS.length - 1;
  return {
    level,
    name: NAMES[level],
    hours,
    nextAtHours: max ? null : HOURS[level + 1],
    progress: max ? 1 : (hours - HOURS[level]) / (HOURS[level + 1] - HOURS[level]),
  };
}
