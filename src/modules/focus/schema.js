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
  }
}
