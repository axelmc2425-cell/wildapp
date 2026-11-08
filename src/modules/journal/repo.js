const DAY = /^\d{4}-\d{2}-\d{2}$/;

const parse = (r) => (r ? { ...r, tags: r.tags ? r.tags.split(',').filter(Boolean) : [] } : null);

function scale(name, v, lo, hi, label) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'number' || !(v >= lo && v <= hi)) throw new Error(label);
  return v;
}

export async function getEntry(db, day) {
  const [r] = await db.all('SELECT * FROM journal WHERE day = ?', [day]);
  return parse(r);
}

export async function getEntryById(db, id) {
  const [r] = await db.all('SELECT * FROM journal WHERE id = ?', [id]);
  return parse(r);
}

// Creates the entry for `day` or updates it; fields you leave out (undefined) keep their stored value.
export async function saveEntry(db, entry) {
  if (!DAY.test(String(entry.day || ''))) throw new Error('invalid day (use YYYY-MM-DD)');
  const mood = scale('mood', entry.mood, 1, 5, 'mood must be 1 to 5');
  const energy = scale('energy', entry.energy, 1, 5, 'energy must be 1 to 5');
  const sleep = scale('sleep', entry.sleep, 0, 24, 'sleep must be between 0 and 24 hours');
  const old = await getEntry(db, entry.day);
  const tags = entry.tags === undefined ? old?.tags : entry.tags.map(t => String(t).trim().replace(/,/g, '')).filter(Boolean);
  const merged = {
    mood: mood === undefined ? old?.mood ?? null : mood,
    energy: energy === undefined ? old?.energy ?? null : energy,
    sleep: sleep === undefined ? old?.sleep ?? null : sleep,
    text: entry.text === undefined ? old?.text ?? '' : String(entry.text),
    tags: (tags || []).join(','),
  };
  await db.run(
    `INSERT INTO journal(day, mood, energy, sleep, text, tags, updated) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET mood = excluded.mood, energy = excluded.energy, sleep = excluded.sleep,
       text = excluded.text, tags = excluded.tags, updated = excluded.updated`,
    [entry.day, merged.mood, merged.energy, merged.sleep, merged.text, merged.tags, Date.now()]);
  return getEntry(db, entry.day);
}

export async function listEntries(db, { from = '0000-00-00', to = '9999-99-99', limit = 2000 } = {}) {
  return (await db.all('SELECT * FROM journal WHERE day >= ? AND day <= ? ORDER BY day DESC LIMIT ?', [from, to, limit])).map(parse);
}

export async function deleteEntry(db, day) {
  await db.run('DELETE FROM journal WHERE day = ?', [day]);
}

export async function journalSearch(db, q) {
  const needle = q.toLowerCase();
  return (await listEntries(db))
    .filter(e => e.day.includes(needle) || e.text.toLowerCase().includes(needle) || e.tags.some(t => t.toLowerCase().includes(needle)))
    .slice(0, 15)
    .map(e => ({ module: 'journal', id: e.id, title: e.day, snippet: e.text.replace(/\s+/g, ' ').slice(0, 90) }));
}
