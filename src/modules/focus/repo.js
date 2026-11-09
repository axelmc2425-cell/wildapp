export async function logSession(db, { started, minutes, kind = 'work', task = '', completed = 1 }) {
  const r = await db.run('INSERT INTO focus_sessions(started, minutes, kind, task, completed) VALUES (?, ?, ?, ?, ?)',
    [started, minutes, kind, task, completed ? 1 : 0]);
  return { id: r.lastInsertId, started, minutes, kind, task, completed: completed ? 1 : 0 };
}

export async function listSessions(db, { since = 0, limit = 500 } = {}) {
  return db.all('SELECT * FROM focus_sessions WHERE started >= ? ORDER BY started DESC, id DESC LIMIT ?', [since, limit]);
}

export async function setSessionDone(db, id, done) {
  await db.run('UPDATE focus_sessions SET done = ? WHERE id = ?', [done ? 1 : 0, id]);
}

export async function deleteSession(db, id) {
  await db.run('DELETE FROM focus_sessions WHERE id = ?', [id]);
}

export async function getSetting(db, key, fallback) {
  const rows = await db.all('SELECT value FROM settings WHERE key = ?', [key]);
  if (!rows.length) return fallback;
  try { return JSON.parse(rows[0].value); } catch { return fallback; }
}

export async function setSetting(db, key, value) {
  await db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
}

export async function focusSearch(db, q) {
  const needle = q.toLowerCase();
  const rows = await db.all("SELECT id, started, minutes, task FROM focus_sessions WHERE task != '' ORDER BY started DESC");
  return rows
    .filter(r => r.task.toLowerCase().includes(needle))
    .slice(0, 15)
    .map(r => ({ module: 'focus', id: r.id, title: r.task, snippet: `${new Date(r.started).toLocaleDateString()} · ${r.minutes} min` }));
}
