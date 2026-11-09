// Persistence for the Focus Room UI: block lists, their items, and sessions.
import { checkEntry } from './entry.js';
import { MAX_DURATION_MS, validateUnlockDelay } from './limits.js';

const MAX_ITEMS = 512;
const MAX_NAME = 60;
const DAY_MS = 86400000;

/** @typedef {{ id: number, name: string, mode: 'block', sites: string[], apps: string[] }} ListRec */
/** @typedef {{ id: number, listId: number, starts: number, ends: number, lock: 'none'|'locked'|'frozen', unlockDelayMs: number|null }} SessionRec */

const placeholders = (n) => Array(n).fill('?').join(',');

/** @returns {Promise<ListRec[]>} */
export async function listLists(db) {
  const lists = await db.all('SELECT id, name, mode FROM focus_lists');
  const items = await db.all('SELECT list_id, kind, value FROM focus_items ORDER BY rowid');
  const byId = new Map(lists.map(l => [l.id, { id: l.id, name: l.name, mode: 'block', sites: [], apps: [] }]));
  for (const it of items) {
    const rec = byId.get(it.list_id);
    if (rec) (it.kind === 'site' ? rec.sites : rec.apps).push(it.value);
  }
  return [...byId.values()].sort((a, b) => {
    const x = a.name.toLowerCase(), y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.id - b.id;
  });
}

function checkAll(kind, raws, errors, out) {
  const bad = [];
  for (const raw of Array.isArray(raws) ? raws : []) {
    const r = checkEntry(kind, raw);
    if (r.ok) { if (!out.includes(r.value)) out.push(r.value); }
    else bad.push({ value: raw, message: r.message });
  }
  if (bad.length) errors[kind === 'site' ? 'sites' : 'apps'] = bad;
}

/**
 * @param {{ id?: number, name: string, sites: string[], apps: string[] }} input
 * @returns {Promise<{ ok: true, id: number } | { ok: false, errors: { name?: string, items?: string, sites?: {value: string, message: string}[], apps?: {value: string, message: string}[] } }>}
 */
export async function saveList(db, input, nowMs = Date.now()) {
  const errors = {};
  if (input.id !== undefined) {
    const [held] = await db.all("SELECT MAX(ends) AS ends FROM focus_sessions WHERE list_id = ? AND lock <> 'none' AND ends > ?", [input.id, nowMs]);
    if (held && held.ends != null) {
      return { ok: false, errors: { name: 'That list is part of a locked block.' }, lockedUntil: held.ends };
    }
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') errors.name = 'Give the list a name.';
  else if (name.length > MAX_NAME) errors.name = 'Keep the name under 60 characters.';
  else {
    const lower = name.toLowerCase();
    const clash = (await db.all('SELECT id, name FROM focus_lists'))
      .some(l => l.id !== input.id && l.name.toLowerCase() === lower);
    if (clash) errors.name = 'A list with this name already exists.';
  }
  const sites = [], apps = [];
  checkAll('site', input.sites, errors, sites);
  checkAll('app', input.apps, errors, apps);
  if (!errors.sites && !errors.apps && sites.length + apps.length > MAX_ITEMS) {
    errors.items = 'A list can hold up to 512 entries.';
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  const itemStmts = (listIdSql, listIdParams) => [
    ...sites.map(v => ({ sql: `INSERT INTO focus_items(list_id, kind, value) VALUES (${listIdSql}, 'site', ?)`, params: [...listIdParams, v] })),
    ...apps.map(v => ({ sql: `INSERT INTO focus_items(list_id, kind, value) VALUES (${listIdSql}, 'app', ?)`, params: [...listIdParams, v] })),
  ];

  if (input.id !== undefined) {
    const id = input.id;
    const exists = await db.all('SELECT id FROM focus_lists WHERE id = ?', [id]);
    if (!exists.length) throw new Error('no such list');
    await db.batch([
      { sql: 'UPDATE focus_lists SET name = ? WHERE id = ?', params: [name, id] },
      { sql: 'DELETE FROM focus_items WHERE list_id = ?', params: [id] },
      ...itemStmts('?', [id]),
    ]);
    return { ok: true, id };
  }
  // The new row's id is the largest AUTOINCREMENT id; last_insert_rowid() would be
  // overwritten by the item inserts themselves.
  await db.batch([
    { sql: "INSERT INTO focus_lists(name, mode) VALUES (?, 'block')", params: [name] },
    ...itemStmts('(SELECT MAX(id) FROM focus_lists)', []),
  ]);
  const [row] = await db.all('SELECT MAX(id) AS id FROM focus_lists');
  return { ok: true, id: row.id };
}

/** @returns {Promise<{ok: true} | {ok: false, reason: 'running'}>} */
export async function deleteList(db, id, nowMs) {
  const running = await db.all('SELECT 1 AS x FROM focus_sessions WHERE list_id = ? AND ends > ? LIMIT 1', [id, nowMs]);
  if (running.length) return { ok: false, reason: 'running' };
  await db.batch([
    { sql: 'DELETE FROM focus_sessions WHERE list_id = ?', params: [id] },
    { sql: 'DELETE FROM focus_items WHERE list_id = ?', params: [id] },
    { sql: 'DELETE FROM focus_lists WHERE id = ?', params: [id] },
  ]);
  return { ok: true };
}

/** @returns {Promise<number[]>} new session ids, in listIds order */
export async function createSessions(db, { listIds, starts, ends, lock = 'none', unlockDelayMs = null }) {
  if (!(ends > starts)) throw new Error('bad times');
  if (lock !== 'none' && lock !== 'locked') throw new Error('bad lock');
  if (!validateUnlockDelay(lock, unlockDelayMs).ok) throw new Error('bad unlock delay');
  if (lock === 'locked' && ends - starts > MAX_DURATION_MS.locked) throw new Error('locked block too long');
  if (!listIds.length) return [];
  await db.batch(listIds.map(listId => ({
    sql: 'INSERT INTO focus_sessions(list_id, starts, ends, lock, unlock_delay_ms) VALUES (?, ?, ?, ?, ?)',
    params: [listId, starts, ends, lock, unlockDelayMs],
  })));
  const rows = await db.all('SELECT id FROM focus_sessions ORDER BY id DESC LIMIT ?', [listIds.length]);
  return rows.map(r => r.id).reverse();
}

export async function setSessionsEnd(db, ids, ends) {
  if (!ids.length) return;
  await db.batch(ids.map(id => ({ sql: 'UPDATE focus_sessions SET ends = ? WHERE id = ?', params: [ends, id] })));
}

export async function deleteSessions(db, ids) {
  if (!ids.length) return;
  const locked = await db.all(`SELECT 1 AS x FROM focus_sessions WHERE lock <> 'none' AND id IN (${placeholders(ids.length)}) LIMIT 1`, ids);
  if (locked.length) throw new Error('locked');
  await db.run(`DELETE FROM focus_sessions WHERE id IN (${placeholders(ids.length)})`, ids);
}

/** Removes sessions of any lock kind; only for unlock/reconcile, never the normal cancel path. */
export async function endLockedSessions(db, ids) {
  if (!ids.length) return;
  await db.run(`DELETE FROM focus_sessions WHERE id IN (${placeholders(ids.length)})`, ids);
}

/** @returns {Promise<SessionRec[]>} */
export async function listSessions(db) {
  const rows = await db.all('SELECT id, list_id, starts, ends, lock, unlock_delay_ms FROM focus_sessions ORDER BY id');
  return rows.map(r => ({ id: r.id, listId: r.list_id, starts: r.starts, ends: r.ends, lock: r.lock, unlockDelayMs: r.unlock_delay_ms ?? null }));
}

/** Deletes sessions that ended more than keepMs before nowMs; returns how many. */
export async function purgeFinished(db, nowMs, keepMs = DAY_MS) {
  const r = await db.run('DELETE FROM focus_sessions WHERE ends < ?', [nowMs - keepMs]);
  return r.changes;
}
