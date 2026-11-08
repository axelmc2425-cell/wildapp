import { titleKey } from './titlekey.js';

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

// Each step and its version bump are one transaction, so a crash can never leave a half-migrated database.
export async function migrate(db) {
  const [{ user_version: v }] = await db.all('PRAGMA user_version');
  if (v < 1) {
    await db.batch([...V1.map(sql => ({ sql })), { sql: 'PRAGMA user_version = 1' }]);
  }
  if (v < 2) {
    // v2: title_key makes title comparison case-insensitive for non-ASCII letters too.
    const rows = await db.all('SELECT id, title FROM notes');
    await db.batch([
      { sql: "ALTER TABLE notes ADD COLUMN title_key TEXT NOT NULL DEFAULT ''" },
      { sql: 'DROP INDEX notes_title_ci' },
      ...rows.map(r => ({ sql: 'UPDATE notes SET title_key = ? WHERE id = ?', params: [titleKey(r.title), r.id] })),
      { sql: 'CREATE UNIQUE INDEX notes_title_key ON notes(title_key)' },
      { sql: 'PRAGMA user_version = 2' },
    ]);
  }
}
