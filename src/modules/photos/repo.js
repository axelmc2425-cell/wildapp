import { dayOf } from './timeline.js';

// imported: [{ file, taken_ms, original }] as returned by the photo_import command. Returns how many were new.
export async function addPhotos(db, imported, now = Date.now()) {
  const [{ n: before }] = await db.all('SELECT COUNT(*) AS n FROM photos');
  if (imported.length) {
    await db.batch(imported.map(p => ({
      sql: "INSERT OR IGNORE INTO photos(file, taken, added, album_id, caption) VALUES (?, ?, ?, NULL, '')",
      params: [p.file, p.taken_ms, now],
    })));
  }
  const [{ n: after }] = await db.all('SELECT COUNT(*) AS n FROM photos');
  return after - before;
}

export async function listPhotos(db, { albumId } = {}) {
  return albumId === undefined
    ? db.all('SELECT * FROM photos ORDER BY taken DESC, id DESC')
    : db.all('SELECT * FROM photos WHERE album_id = ? ORDER BY taken DESC, id DESC', [albumId]);
}

export async function getPhoto(db, id) {
  const [p] = await db.all('SELECT * FROM photos WHERE id = ?', [id]);
  return p || null;
}

export async function setCaption(db, id, caption) {
  await db.run('UPDATE photos SET caption = ? WHERE id = ?', [String(caption), id]);
}

// Removes the database row and returns the file path so the caller can delete the file; null if there was no such photo.
export async function deletePhotoRow(db, id) {
  const p = await getPhoto(db, id);
  if (!p) return null;
  await db.run('DELETE FROM photos WHERE id = ?', [id]);
  return p.file;
}

export async function createAlbum(db, name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('album needs a name');
  const r = await db.run('INSERT INTO albums(name, created) VALUES (?, ?)', [n, Date.now()]);
  return { id: r.lastInsertId, name: n };
}

export async function listAlbums(db) {
  return db.all(
    `SELECT a.id, a.name, COUNT(p.id) AS count,
            (SELECT file FROM photos WHERE album_id = a.id ORDER BY taken DESC, id DESC LIMIT 1) AS cover
     FROM albums a LEFT JOIN photos p ON p.album_id = a.id GROUP BY a.id ORDER BY a.id`);
}

export async function renameAlbum(db, id, name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('album needs a name');
  await db.run('UPDATE albums SET name = ? WHERE id = ?', [n, id]);
}

// Deleting an album keeps its photos.
export async function deleteAlbum(db, id) {
  await db.batch([
    { sql: 'UPDATE photos SET album_id = NULL WHERE album_id = ?', params: [id] },
    { sql: 'DELETE FROM albums WHERE id = ?', params: [id] },
  ]);
}

export async function setAlbum(db, photoIds, albumId) {
  if (!photoIds.length) return;
  await db.run(`UPDATE photos SET album_id = ? WHERE id IN (${photoIds.map(() => '?').join(',')})`, [albumId, ...photoIds]);
}

export async function photosSearch(db, q) {
  const needle = q.toLowerCase();
  const rows = await db.all('SELECT p.*, a.name AS albumName FROM photos p LEFT JOIN albums a ON a.id = p.album_id ORDER BY p.taken DESC, p.id DESC');
  const base = (f) => f.split('/').pop();
  return rows
    .filter(p => p.caption.toLowerCase().includes(needle) || (p.albumName || '').toLowerCase().includes(needle)
      || dayOf(p.taken).includes(needle) || base(p.file).toLowerCase().includes(needle))
    .slice(0, 15)
    .map(p => ({ module: 'photos', id: p.id, title: p.caption || base(p.file), snippet: dayOf(p.taken) + (p.albumName ? ` · ${p.albumName}` : '') }));
}
