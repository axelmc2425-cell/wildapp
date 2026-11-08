import { DatabaseSync } from 'node:sqlite';

// Db adapter over node:sqlite, used by tests and the screenshot harness.
export async function openNodeDb(path) {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON');
  const bind = (params) => (params || []).map(p => (p === undefined ? null : p));
  return {
    async all(sql, params) {
      return raw.prepare(sql).all(...bind(params));
    },
    async run(sql, params) {
      const r = raw.prepare(sql).run(...bind(params));
      return { lastInsertId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    async batch(stmts) {
      raw.exec('BEGIN');
      try {
        for (const s of stmts) raw.prepare(s.sql).run(...bind(s.params));
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
