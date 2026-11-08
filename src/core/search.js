const providers = new Map();

export function registerSearchProvider(name, fn) {
  providers.set(name, fn);
}

export async function searchAll(db, q) {
  const query = String(q || '').trim();
  if (!query) return [];
  const needle = query.toLowerCase();
  const hits = [];
  for (const fn of providers.values()) hits.push(...(await fn(db, query)));
  const titleHit = (h) => (h.title.toLowerCase().includes(needle) ? 0 : 1);
  return hits
    .map((h, i) => ({ h, i }))
    .sort((a, b) => titleHit(a.h) - titleHit(b.h) || a.i - b.i)
    .map(x => x.h)
    .slice(0, 30);
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

function snippetFor(body, query) {
  const text = body.replace(/\s+/g, ' ');
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, 100);
  const start = Math.max(0, at - 40);
  return (start > 0 ? '…' : '') + text.slice(start, at + query.length + 40) + (at + query.length + 40 < text.length ? '…' : '');
}

export async function notesSearchProvider(db, q) {
  // SQLite's LIKE only folds ASCII case, so queries with other letters are matched in JS.
  if (/[^\x00-\x7f]/.test(q)) {
    const needle = q.toLowerCase();
    const rows = await db.all('SELECT id, title, body FROM notes ORDER BY updated DESC, id DESC');
    const hits = [];
    for (const r of rows) {
      if (r.title.toLowerCase().includes(needle) || r.body.toLowerCase().includes(needle)) {
        hits.push({ module: 'secondbrain', id: r.id, title: r.title, snippet: snippetFor(r.body, q) });
        if (hits.length >= 30) break;
      }
    }
    return hits;
  }
  const like = '%' + escapeLike(q) + '%';
  const rows = await db.all(
    "SELECT id, title, body FROM notes WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' ORDER BY updated DESC, id DESC LIMIT 30",
    [like, like]);
  return rows.map(r => ({ module: 'secondbrain', id: r.id, title: r.title, snippet: snippetFor(r.body, q) }));
}
