import { extractLinks, extractTags } from './parse.js';

const LINK_FROM = (idSql) =>
  `INSERT OR IGNORE INTO links(from_type, from_id, to_type, to_id)
   SELECT 'note', ${idSql}, 'note', id FROM notes WHERE lower(title) = lower(?)`;

// Statements that (re)write the tags and links of one note. idSql/idParams identify the note.
function derivedStatements(idSql, idParams, body) {
  const stmts = [
    { sql: `DELETE FROM tags WHERE note_id = ${idSql}`, params: idParams },
    { sql: `DELETE FROM links WHERE from_type = 'note' AND from_id = ${idSql}`, params: idParams },
  ];
  for (const tag of extractTags(body)) {
    stmts.push({ sql: `INSERT OR IGNORE INTO tags(note_id, tag) SELECT ${idSql}, ?`, params: [...idParams, tag] });
  }
  for (const title of extractLinks(body)) {
    stmts.push({ sql: LINK_FROM(idSql), params: [...idParams, title] });
  }
  return stmts;
}

async function withTags(db, rows) {
  if (!rows.length) return [];
  const tags = await db.all(`SELECT note_id, tag FROM tags WHERE note_id IN (${rows.map(() => '?').join(',')}) ORDER BY tag`, rows.map(r => r.id));
  const byId = new Map();
  for (const t of tags) (byId.get(t.note_id) || byId.set(t.note_id, []).get(t.note_id)).push(t.tag);
  return rows.map(r => ({ ...r, tags: byId.get(r.id) || [] }));
}

export async function getNote(db, id) {
  const rows = await db.all('SELECT * FROM notes WHERE id = ?', [id]);
  return (await withTags(db, rows))[0] || null;
}

export async function findNoteByTitle(db, title) {
  const rows = await db.all('SELECT * FROM notes WHERE lower(title) = lower(?)', [String(title).trim()]);
  return (await withTags(db, rows))[0] || null;
}

// Re-resolve the links of every note whose body mentions [[title]] (used after a title starts to exist).
async function relinkMentions(db, title) {
  const key = title.toLowerCase();
  const rows = await db.all("SELECT id, body FROM notes WHERE body LIKE '%[[%'");
  for (const r of rows) {
    if (extractLinks(r.body).some(t => t.toLowerCase() === key)) {
      await db.batch(derivedStatements('?', [r.id], r.body).filter(s => !s.sql.includes('tags')));
    }
  }
}

export async function createNote(db, { title, body = '' }) {
  const t = String(title || '').trim();
  if (!t) throw new Error('empty title');
  if (await findNoteByTitle(db, t)) throw new Error('duplicate title');
  const now = Date.now();
  const idSql = '(SELECT id FROM notes WHERE lower(title) = lower(?))';
  await db.batch([
    { sql: 'INSERT INTO notes(title, body, created, updated) VALUES (?, ?, ?, ?)', params: [t, body, now, now] },
    ...derivedStatements(idSql, [t], body),
  ]);
  await relinkMentions(db, t);
  return findNoteByTitle(db, t);
}

export async function saveNote(db, id, { title, body } = {}) {
  const old = await getNote(db, id);
  if (!old) throw new Error('note not found');
  const t = title === undefined ? old.title : String(title).trim();
  const b = body === undefined ? old.body : body;
  if (!t) throw new Error('empty title');
  const clash = await findNoteByTitle(db, t);
  if (clash && clash.id !== id) throw new Error('duplicate title');
  await db.batch([
    { sql: 'UPDATE notes SET title = ?, body = ?, updated = ? WHERE id = ?', params: [t, b, Date.now(), id] },
    ...derivedStatements('?', [id], b),
  ]);
  if (t.toLowerCase() !== old.title.toLowerCase()) await relinkMentions(db, t);
  return getNote(db, id);
}

export async function deleteNote(db, id) {
  await db.batch([
    { sql: 'DELETE FROM tags WHERE note_id = ?', params: [id] },
    { sql: "DELETE FROM links WHERE (from_type = 'note' AND from_id = ?) OR (to_type = 'note' AND to_id = ?)", params: [id, id] },
    { sql: 'DELETE FROM notes WHERE id = ?', params: [id] },
  ]);
}

export async function listNotes(db, { tag } = {}) {
  const rows = tag
    ? await db.all('SELECT n.* FROM notes n JOIN tags t ON t.note_id = n.id WHERE t.tag = ? ORDER BY n.updated DESC, n.id DESC', [String(tag).toLowerCase()])
    : await db.all('SELECT * FROM notes ORDER BY updated DESC, id DESC');
  return withTags(db, rows);
}

export async function backlinks(db, id) {
  const rows = await db.all(
    `SELECT n.* FROM links l JOIN notes n ON n.id = l.from_id
     WHERE l.from_type = 'note' AND l.to_type = 'note' AND l.to_id = ? AND l.from_id != ?
     ORDER BY n.updated DESC, n.id DESC`, [id, id]);
  return withTags(db, rows);
}

export async function unresolvedLinks(body, db) {
  const out = [];
  for (const t of extractLinks(body)) if (!(await findNoteByTitle(db, t))) out.push(t);
  return out;
}
