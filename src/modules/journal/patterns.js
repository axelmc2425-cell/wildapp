// Pure, offline pattern spotting for journal entries. An entry is
// { day: 'YYYY-MM-DD', mood: 1-5|null, energy: 1-5|null, sleep: hours|null, text, tags: [] }.
const pad = (n) => String(n).padStart(2, '0');
const parseDay = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (day, n) => { const d = parseDay(day); d.setDate(d.getDate() + n); return fmtDay(d); };
const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const nums = (list) => list.filter(v => typeof v === 'number');
const avg = (list) => { const v = nums(list); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

export const weekdayName = (day) => NAMES[parseDay(day).getDay()];

export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// Monday to Sunday week that contains `day`.
export function weekRange(day) {
  const offset = (parseDay(day).getDay() + 6) % 7;
  const start = addDays(day, -offset);
  return { start, end: addDays(start, 6) };
}

const inRange = (entries, start, end) => entries.filter(e => e.day >= start && e.day <= end);

export function weeklyReview(entries, anyDay) {
  const { start, end } = weekRange(anyDay);
  const week = inRange(entries, start, end);
  const prev = inRange(entries, addDays(start, -7), addDays(start, -1));
  const moods = week.filter(e => typeof e.mood === 'number');
  const best = moods.reduce((b, e) => (!b || e.mood > b.mood ? e : b), null);
  const hard = moods.reduce((b, e) => (!b || e.mood < b.mood ? e : b), null);
  const tagCounts = new Map();
  for (const e of week) for (const t of e.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const avgMood = avg(week.map(e => e.mood));
  const prevMood = avg(prev.map(e => e.mood));
  return {
    start, end,
    daysLogged: week.length,
    avgMood, avgEnergy: avg(week.map(e => e.energy)), avgSleep: avg(week.map(e => e.sleep)),
    bestDay: best ? { day: best.day, mood: best.mood } : null,
    hardestDay: hard ? { day: hard.day, mood: hard.mood } : null,
    topTags: [...tagCounts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, 5),
    moodChange: avgMood !== null && prevMood !== null ? avgMood - prevMood : null,
    byDay: Array.from({ length: 7 }, (_, i) => { const day = addDays(start, i); const e = week.find(x => x.day === day); return { day, mood: e ? e.mood : null }; }),
  };
}

const STOP = new Set(('that this with from have been were will would could should there their about which when what your into more some than then '
  + 'them they also just like only over such very each other these those where while today really still much many most day days').split(' '));

function wordDocs(entries) {
  const df = new Map();
  for (const e of entries) {
    const seen = new Set((String(e.text || '').toLowerCase().match(/\p{L}{4,}/gu) || []).filter(w => !STOP.has(w)));
    for (const w of seen) df.set(w, (df.get(w) || 0) + 1);
  }
  return df;
}

const top = (df, other, k = 3) => [...df].filter(([w, n]) => n >= 2 && !other.has(w)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, k).map(([w]) => w);

export function observations(entries, { now }) {
  const out = [];
  // sleep vs mood
  const pairs = entries.filter(e => typeof e.mood === 'number' && typeof e.sleep === 'number');
  if (pairs.length >= 7) {
    const r = pearson(pairs.map(e => e.sleep), pairs.map(e => e.mood));
    const longer = pairs.filter(e => e.sleep >= 7).map(e => e.mood);
    const shorter = pairs.filter(e => e.sleep < 6.5).map(e => e.mood);
    if (r !== null && r >= 0.4 && longer.length >= 2 && shorter.length >= 2) {
      const a = avg(longer), b = avg(shorter);
      out.push({ kind: 'sleep', text: `Your mood tends to follow your sleep: with 7+ hours it averages ${a.toFixed(1)}, after under 6.5 hours ${b.toFixed(1)} (+${(a - b).toFixed(1)}).` });
    }
  }
  // best weekday
  const withMood = entries.filter(e => typeof e.mood === 'number');
  if (withMood.length >= 14) {
    const groups = new Map();
    for (const e of withMood) { const k = weekdayName(e.day); (groups.get(k) || groups.set(k, []).get(k)).push(e.mood); }
    const overall = avg(withMood.map(e => e.mood));
    let best = null;
    for (const [name, list] of groups) if (list.length >= 2 && (!best || avg(list) > best.avg)) best = { name, avg: avg(list) };
    if (best && best.avg - overall >= 0.5) out.push({ kind: 'weekday', text: `${best.name}s tend to be your best days (average mood ${best.avg.toFixed(1)}).` });
  }
  // words on good vs low days
  const good = wordDocs(withMood.filter(e => e.mood >= 4));
  const low = wordDocs(withMood.filter(e => e.mood <= 2));
  const goodWords = top(good, low);
  const lowWords = top(low, good);
  if (goodWords.length || lowWords.length) {
    const parts = [];
    if (goodWords.length) parts.push(`On your good days you often write about: ${goodWords.join(', ')}.`);
    if (lowWords.length) parts.push(`On low days: ${lowWords.join(', ')}.`);
    out.push({ kind: 'words', text: parts.join(' ') });
  }
  // streak
  const days = new Set(entries.map(e => e.day));
  let cur = days.has(now) ? now : days.has(addDays(now, -1)) ? addDays(now, -1) : null;
  let n = 0;
  while (cur && days.has(cur)) { n++; cur = addDays(cur, -1); }
  if (n >= 3) out.push({ kind: 'streak', text: `You've journaled ${n} days in a row.` });
  return out;
}

export function promptsFor(review) {
  const p = [];
  if (review.daysLogged < 3) p.push('What got in the way of writing this week, and what would make it easier?');
  if (review.avgMood !== null && review.avgMood <= 2.5) p.push('What drained you most this week, and what small thing helped even a little?');
  if (review.avgSleep !== null && review.avgSleep < 6.5) p.push('What is one change that would protect your sleep next week?');
  if (review.moodChange !== null && review.moodChange <= -1 && !(review.avgMood !== null && review.avgMood <= 2.5)) p.push('Your mood dipped compared with last week. What changed?');
  if (review.avgMood !== null && review.avgMood >= 4) p.push('What went well this week that you want more of next week?');
  if (!p.length) p.push('What are you grateful for this week?');
  return p.slice(0, 3);
}

const one = (n) => n.toFixed(1);

export function weekSummaryText(review, obs, prompts) {
  const lines = [`My week: ${review.start} to ${review.end}`, `Days journaled: ${review.daysLogged} of 7`];
  if (review.avgMood !== null) lines.push(`Average mood: ${one(review.avgMood)}/5`);
  if (review.avgEnergy !== null) lines.push(`Average energy: ${one(review.avgEnergy)}/5`);
  if (review.avgSleep !== null) lines.push(`Average sleep: ${one(review.avgSleep)} hours`);
  if (review.bestDay) lines.push(`Best day: ${review.bestDay.day} (mood ${review.bestDay.mood})`);
  if (review.hardestDay) lines.push(`Hardest day: ${review.hardestDay.day} (mood ${review.hardestDay.mood})`);
  if (review.moodChange !== null) lines.push(`Mood vs last week: ${review.moodChange >= 0 ? '+' : ''}${one(review.moodChange)}`);
  if (review.topTags.length) lines.push(`Themes: ${review.topTags.map(t => '#' + t.tag).join(' ')}`);
  if (obs.length) lines.push('', 'Patterns I noticed:', ...obs.map(o => `- ${o.text}`));
  if (prompts.length) lines.push('', 'Questions to reflect on:', ...prompts.map(q => `- ${q}`));
  return lines.join('\n');
}
