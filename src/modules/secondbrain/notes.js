import { extractLinks, extractTags } from './parse.js';
import { titleKey } from '../../core/titlekey.js';

const tagStatements = (idSql, idParams, body) => [
  { sql: `DELETE FROM tags WHERE note_id = ${idSql}`, params: idParams },
  ...extractTags(body).map(tag => ({ sql: `INSERT OR IGNORE INTO tags(note_id, tag) SELECT ${idSql}, ?`, params: [...idParams, tag] })),
];

const linkStatements = (idSql, idParams, body) => [
  { sql: `DELETE FROM links WHERE from_type = 'note' AND from_id = ${idSql}`, params: idParams },
  ...extractLinks(body).map(title => ({
    sql: `INSERT OR IGNORE INTO links(from_type, from_id, to_type, to_id)
          SELECT 'note', ${idSql}, 'note', id FROM notes WHERE title_key = ?`,
    params: [...idParams, titleKey(title)],
  })),
];

async function withTags(db, rows) {
  if (!rows.length) return [];
  const tags = await db.all(`SELECT note_id, tag FROM tags WHERE note_id IN (${rows.map(() => '?').join(',')}) ORDER BY tag`, rows.map(r => r.id));
  const byId = new Map();
  for (const t of tags) (byId.get(t.note_id) || byId.set(t.note_id, []).get(t.note_id)).push(t.tag);
  return rows.map(({ title_key, ...r }) => ({ ...r, tags: byId.get(r.id) || [] }));
}

export async function getNote(db, id) {
  const rows = await db.all('SELECT * FROM notes WHERE id = ?', [id]);
  return (await withTags(db, rows))[0] || null;
}

export async function findNoteByTitle(db, title) {
  const rows = await db.all('SELECT * FROM notes WHERE title_key = ?', [titleKey(title)]);
  return (await withTags(db, rows))[0] || null;
}

// Re-resolve the links of every note whose body mentions [[title]] (used after a title starts to exist).
async function relinkMentions(db, title) {
  const key = titleKey(title);
  const rows = await db.all("SELECT id, body FROM notes WHERE body LIKE '%[[%'");
  for (const r of rows) {
    if (extractLinks(r.body).some(t => titleKey(t) === key)) await db.batch(linkStatements('?', [r.id], r.body));
  }
}

// Re-resolve every note's links in one pass (used once after a bulk import).
export async function relinkAll(db) {
  const rows = await db.all("SELECT id, body FROM notes WHERE body LIKE '%[[%'");
  for (const r of rows) await db.batch(linkStatements('?', [r.id], r.body));
}

export async function createNote(db, { title, body = '' }, { relink = true } = {}) {
  const t = String(title || '').trim();
  if (!t) throw new Error('empty title');
  if (await findNoteByTitle(db, t)) throw new Error('duplicate title');
  const now = Date.now();
  const idSql = '(SELECT id FROM notes WHERE title_key = ?)';
  const idParams = [titleKey(t)];
  await db.batch([
    { sql: 'INSERT INTO notes(title, title_key, body, created, updated) VALUES (?, ?, ?, ?, ?)', params: [t, titleKey(t), body, now, now] },
    ...tagStatements(idSql, idParams, body),
    ...linkStatements(idSql, idParams, body),
  ]);
  if (relink) await relinkMentions(db, t);
  return findNoteByTitle(db, t);
}

// Only the fields you pass are written, so a rename and a body save can never overwrite each other.
export async function saveNote(db, id, { title, body } = {}) {
  const old = await getNote(db, id);
  if (!old) throw new Error('note not found');
  const sets = ['updated = ?'];
  const params = [Date.now()];
  let renamed = null;
  if (title !== undefined) {
    const t = String(title).trim();
    if (!t) throw new Error('empty title');
    const clash = await findNoteByTitle(db, t);
    if (clash && clash.id !== id) throw new Error('duplicate title');
    sets.push('title = ?', 'title_key = ?');
    params.push(t, titleKey(t));
    if (titleKey(t) !== titleKey(old.title)) renamed = t;
  }
  if (body !== undefined) {
    sets.push('body = ?');
    params.push(body);
  }
  const stmts = [{ sql: `UPDATE notes SET ${sets.join(', ')} WHERE id = ?`, params: [...params, id] }];
  if (body !== undefined) stmts.push(...tagStatements('?', [id], body), ...linkStatements('?', [id], body));
  await db.batch(stmts);
  if (renamed) await relinkMentions(db, renamed);
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
