const V1 = [
  `CREATE TABLE IF NOT EXISTS focus_lists (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     mode TEXT NOT NULL CHECK (mode IN ('block','allow')))`,
  `CREATE TABLE IF NOT EXISTS focus_items (
     list_id INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('site','app')),
     value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS focus_sessions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     list_id INTEGER NOT NULL,
     starts INTEGER NOT NULL,
     ends INTEGER NOT NULL,
     lock TEXT NOT NULL CHECK (lock IN ('none','locked','frozen')))`,
  `CREATE TABLE IF NOT EXISTS focus_schedules (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     list_id INTEGER NOT NULL,
     weekdays TEXT NOT NULL, -- JSON [0-6], Sunday=0
     start_time TEXT NOT NULL, -- 'HH:MM'
     end_time TEXT NOT NULL,
     lock TEXT NOT NULL CHECK (lock IN ('none','locked','frozen')))`,
  `CREATE TABLE IF NOT EXISTS focus_usage (
     day TEXT NOT NULL,
     kind TEXT NOT NULL,
     value TEXT NOT NULL,
     seconds INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS focus_partner (
     public_key TEXT NOT NULL,
     name TEXT NOT NULL)`,
];

const V2 = [
  'ALTER TABLE focus_sessions ADD COLUMN unlock_delay_ms INTEGER',
];

// SQLite cannot alter a CHECK constraint, so v3 rebuilds focus_items to allow kind 'folder'.
const V3 = [
  `CREATE TABLE focus_items_new (
     list_id INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('site','app','folder')),
     value TEXT NOT NULL)`,
  'INSERT INTO focus_items_new(rowid, list_id, kind, value) SELECT rowid, list_id, kind, value FROM focus_items',
  'DROP TABLE focus_items',
  'ALTER TABLE focus_items_new RENAME TO focus_items',
];

// v4: recurring schedules gain a name, an enabled flag, an end date, an unlock delay and a
// many-to-many link to lists. The legacy list_id column stays (NOT NULL); new rows write the first list id.
const V4 = [
  "ALTER TABLE focus_schedules ADD COLUMN name TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE focus_schedules ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE focus_schedules ADD COLUMN ends_on TEXT',
  'ALTER TABLE focus_schedules ADD COLUMN unlock_delay_ms INTEGER',
  `CREATE TABLE IF NOT EXISTS focus_schedule_lists (
     schedule_id INTEGER NOT NULL,
     list_id INTEGER NOT NULL,
     PRIMARY KEY (schedule_id, list_id))`,
  'INSERT OR IGNORE INTO focus_schedule_lists(schedule_id, list_id) SELECT id, list_id FROM focus_schedules',
];

// v5: time limits. AUTOINCREMENT so a deleted limit's id is never reused (the helper tombstones deleted ids).
const V5 = [
  `CREATE TABLE IF NOT EXISTS focus_limits (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     period TEXT NOT NULL,
     cap_secs INTEGER NOT NULL,
     lock TEXT NOT NULL DEFAULT 'none',
     unlock_delay_ms INTEGER,
     enabled INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS focus_limit_items (
     limit_id INTEGER NOT NULL,
     kind TEXT NOT NULL,
     value TEXT NOT NULL)`,
];

export async function migrateFocus(db) {
  await db.run('CREATE TABLE IF NOT EXISTS focus_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const rows = await db.all("SELECT value FROM focus_meta WHERE key = 'schema_version'");
  let version = rows.length ? Number(rows[0].value) : 0;
  if (!(version >= 1)) {
    await db.batch([
      ...V1.map(sql => ({ sql })),
      { sql: "INSERT OR REPLACE INTO focus_meta(key, value) VALUES ('schema_version', '1')" },
    ]);
    version = 1;
  }
  if (version < 2) {
    await db.batch([
      ...V2.map(sql => ({ sql })),
      { sql: "INSERT OR REPLACE INTO focus_meta(key, value) VALUES ('schema_version', '2')" },
    ]);
    version = 2;
  }
  if (version < 3) {
    await db.batch([
      ...V3.map(sql => ({ sql })),
      { sql: "INSERT OR REPLACE INTO focus_meta(key, value) VALUES ('schema_version', '3')" },
    ]);
    version = 3;
  }
  if (version < 4) {
    await db.batch([
      ...V4.map(sql => ({ sql })),
      { sql: "INSERT OR REPLACE INTO focus_meta(key, value) VALUES ('schema_version', '4')" },
    ]);
    version = 4;
  }
  if (version < 5) {
    await db.batch([
      ...V5.map(sql => ({ sql })),
      { sql: "INSERT OR REPLACE INTO focus_meta(key, value) VALUES ('schema_version', '5')" },
    ]);
  }
}
