// Pure photo timeline logic. A photo is { id, taken (ms), album_id, caption, file }. All dates are local.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');

export function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const newestFirst = (a, b) => b.taken - a.taken || b.id - a.id;

export function groupByMonth(photos) {
  const groups = new Map();
  for (const p of [...photos].sort(newestFirst)) {
    const d = new Date(p.taken);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    if (!groups.has(key)) groups.set(key, { key, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, photos: [] });
    groups.get(key).photos.push(p);
  }
  return [...groups.values()];
}

export function onThisDay(photos, now) {
  const today = new Date(now);
  const groups = new Map();
  for (const p of [...photos].sort(newestFirst)) {
    const d = new Date(p.taken);
    if (d.getMonth() !== today.getMonth() || d.getDate() !== today.getDate() || d.getFullYear() >= today.getFullYear()) continue;
    const yearsAgo = today.getFullYear() - d.getFullYear();
    if (!groups.has(yearsAgo)) groups.set(yearsAgo, { yearsAgo, photos: [] });
    groups.get(yearsAgo).photos.push(p);
  }
  return [...groups.values()].sort((a, b) => a.yearsAgo - b.yearsAgo);
}

const dayNumber = (ms) => { const d = new Date(ms); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000); };

function tripName(fromMs, toMs) {
  const a = new Date(fromMs), b = new Date(toMs);
  const m = (d) => MONTHS[d.getMonth()].slice(0, 3);
  if (a.getFullYear() !== b.getFullYear()) return `${m(a)} ${a.getDate()}, ${a.getFullYear()} – ${m(b)} ${b.getDate()}, ${b.getFullYear()}`;
  if (a.getMonth() !== b.getMonth()) return `${m(a)} ${a.getDate()} – ${m(b)} ${b.getDate()}, ${a.getFullYear()}`;
  return `${m(a)} ${a.getDate()}–${b.getDate()}, ${a.getFullYear()}`;
}

// Clusters of photos not yet in an album: a gap of gapDays or more starts a new cluster. A cluster is a
// trip when it has at least minPhotos photos over 2..maxDays days. Returns [{ name, from, to, photoIds }], newest first.
export function suggestTrips(photos, { gapDays = 3, minPhotos = 5, maxDays = 21 } = {}) {
  const list = photos.filter(p => p.album_id == null).sort((a, b) => a.taken - b.taken || a.id - b.id);
  const clusters = [];
  let cur = null;
  for (const p of list) {
    const day = dayNumber(p.taken);
    if (!cur || day - cur.lastDay >= gapDays) { cur = { photos: [], firstDay: day, lastDay: day }; clusters.push(cur); }
    cur.photos.push(p);
    cur.lastDay = day;
  }
  return clusters
    .filter(c => c.photos.length >= minPhotos && c.lastDay - c.firstDay + 1 >= 2 && c.lastDay - c.firstDay + 1 <= maxDays)
    .map(c => ({ name: tripName(c.photos[0].taken, c.photos.at(-1).taken), from: c.photos[0].taken, to: c.photos.at(-1).taken, photoIds: c.photos.map(p => p.id) }))
    .sort((a, b) => b.from - a.from);
}
