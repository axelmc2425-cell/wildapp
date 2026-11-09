const STOP = new Set(('this that with from have been were will would could should there their about which when what '
  + 'your into more some than then them they also just like only over such very each other these those where while').split(' '));

function words(text) {
  const out = new Set();
  for (const m of String(text || '').toLowerCase().matchAll(/\p{L}{4,}/gu)) {
    if (!STOP.has(m[0])) out.add(m[0]);
  }
  return out;
}

export function relatedNotes(current, others, limit = 5) {
  const myWords = words(current.title + ' ' + current.body);
  const myTags = new Set(current.tags || []);
  const scored = [];
  for (const n of others) {
    if (n.id === current.id) continue;
    const sharedTags = (n.tags || []).filter(t => myTags.has(t)).length;
    let sharedWords = 0;
    for (const w of words(n.title + ' ' + n.body)) if (myWords.has(w)) sharedWords++;
    const score = 3 * sharedTags + sharedWords;
    if (score > 0) scored.push({ note: n, score });
  }
  scored.sort((a, b) => b.score - a.score || b.note.updated - a.note.updated || b.note.id - a.note.id);
  return scored.slice(0, limit);
}
