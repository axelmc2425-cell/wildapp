const V1 = [
  `CREATE TABLE notes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     body TEXT NOT NULL DEFAULT '',
     created INTEGER NOT NULL,
     updated INTEGER NOT NULL)`,
  'CREATE UNIQUE INDEX notes_title_ci ON notes(lower(title))',
  `CREATE TABLE tags (
     note_id INTEGER NOT NULL,
     tag TEXT NOT NULL,
     PRIMARY KEY (note_id, tag))`,
  'CREATE INDEX tags_tag ON tags(tag)',
  `CREATE TABLE links (
     from_type TEXT NOT NULL,
     from_id INTEGER NOT NULL,
     to_type TEXT NOT NULL,
     to_id INTEGER NOT NULL,
     PRIMARY KEY (from_type, from_id, to_type, to_id))`,
  'CREATE INDEX links_to ON links(to_type, to_id)',
];

export async function migrate(db) {
  const [{ user_version }] = await db.all('PRAGMA user_version');
  if (user_version >= 1) return;
  await db.batch(V1.map(sql => ({ sql })));
  await db.run('PRAGMA user_version = 1');
}
