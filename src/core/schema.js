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
// Module tables, one numbered step each (v3..v8). Every step and its version bump are one transaction.
const MODULE_STEPS = [
  [3, []], // was Focus Room tables; the Focus Room module now creates and migrates its own tables (src/modules/focus/schema.js)
  [4, [ // cooking
    `CREATE TABLE pantry (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       name_key TEXT NOT NULL UNIQUE,
       qty REAL NOT NULL DEFAULT 0,
       unit TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE recipes (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       title TEXT NOT NULL,
       title_key TEXT NOT NULL UNIQUE,
       servings REAL NOT NULL DEFAULT 1,
       ingredients TEXT NOT NULL DEFAULT '[]',
       steps TEXT NOT NULL DEFAULT '',
       kcal REAL NOT NULL DEFAULT 0,
       protein REAL NOT NULL DEFAULT 0,
       carbs REAL NOT NULL DEFAULT 0,
       fat REAL NOT NULL DEFAULT 0,
       cost REAL NOT NULL DEFAULT 0,
       created INTEGER NOT NULL)`,
  ]],
  [5, [ // money
    `CREATE TABLE scenarios (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       json TEXT NOT NULL,
       updated INTEGER NOT NULL)`,
  ]],
  [6, [ // skills
    `CREATE TABLE skills (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       parent_id INTEGER,
       created INTEGER NOT NULL)`,
    `CREATE TABLE practice (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       skill_id INTEGER NOT NULL,
       minutes INTEGER NOT NULL,
       day TEXT NOT NULL,
       note TEXT NOT NULL DEFAULT '')`,
    'CREATE INDEX practice_skill ON practice(skill_id)',
    `CREATE TABLE cards (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       skill_id INTEGER NOT NULL,
       front TEXT NOT NULL,
       back TEXT NOT NULL,
       ease REAL NOT NULL DEFAULT 2.5,
       interval INTEGER NOT NULL DEFAULT 0,
       reps INTEGER NOT NULL DEFAULT 0,
       due TEXT NOT NULL,
       created INTEGER NOT NULL)`,
    'CREATE INDEX cards_due ON cards(due)',
  ]],
  [7, [ // photos
    `CREATE TABLE albums (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       created INTEGER NOT NULL)`,
    `CREATE TABLE photos (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       file TEXT NOT NULL UNIQUE,
       taken INTEGER NOT NULL,
       added INTEGER NOT NULL,
       album_id INTEGER,
       caption TEXT NOT NULL DEFAULT '')`,
    'CREATE INDEX photos_taken ON photos(taken)',
  ]],
  [8, [ // journal
    `CREATE TABLE journal (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       day TEXT NOT NULL UNIQUE,
       mood INTEGER,
       energy INTEGER,
       sleep REAL,
       text TEXT NOT NULL DEFAULT '',
       tags TEXT NOT NULL DEFAULT '',
       updated INTEGER NOT NULL)`,
  ]],
];

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
  for (const [version, statements] of MODULE_STEPS) {
    if (v < version) {
      await db.batch([...statements.map(sql => ({ sql })), { sql: `PRAGMA user_version = ${version}` }]);
    }
  }
}
