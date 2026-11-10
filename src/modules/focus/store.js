// Persistence for the Focus Room UI: block lists, their items, and sessions.
import { checkEntry } from './entry.js';
import { MAX_DURATION_MS, validateUnlockDelay } from './limits.js';
import { validateSchedule, isLockedActive, nextOccurrence } from './schedule-logic.js';
import { localDayEnd } from './expand.js';
import { makeTzOffsetAt } from './tz.js';

const MAX_ITEMS = 512;
const MAX_NAME = 60;
const DAY_MS = 86400000;

/** @typedef {{ id: number, name: string, mode: 'block', sites: string[], apps: string[], folders: string[] }} ListRec */
/** @typedef {{ id: number, name: string, listIds: number[], weekdays: number[], start: string, end: string, lock: 'none'|'locked', unlockDelayMs: number|null, endsOn: string|null, enabled: boolean }} ScheduleRec */
/** @typedef {{ id: number, listId: number, starts: number, ends: number, lock: 'none'|'locked'|'frozen', unlockDelayMs: number|null }} SessionRec */

const placeholders = (n) => Array(n).fill('?').join(',');

/** @returns {Promise<ListRec[]>} */
export async function listLists(db) {
  const lists = await db.all('SELECT id, name, mode FROM focus_lists');
  const items = await db.all('SELECT list_id, kind, value FROM focus_items ORDER BY rowid');
  const byId = new Map(lists.map(l => [l.id, { id: l.id, name: l.name, mode: 'block', sites: [], apps: [], folders: [] }]));
  for (const it of items) {
    const rec = byId.get(it.list_id);
    if (rec) (it.kind === 'site' ? rec.sites : it.kind === 'folder' ? rec.folders : rec.apps).push(it.value);
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
  if (bad.length) errors[kind === 'site' ? 'sites' : kind === 'folder' ? 'folders' : 'apps'] = bad;
}

/**
 * @param {{ id?: number, name: string, sites: string[], apps: string[], folders?: string[] }} input
 * @returns {Promise<{ ok: true, id: number } | { ok: false, errors: { name?: string, items?: string, sites?: {value: string, message: string}[], apps?: {value: string, message: string}[], folders?: {value: string, message: string}[] } }>}
 */
export async function saveList(db, input, nowMs = Date.now(), tzOffsetAt = makeTzOffsetAt()) {
  const errors = {};
  if (input.id !== undefined) {
    const [held] = await db.all("SELECT MAX(ends) AS ends FROM focus_sessions WHERE list_id = ? AND lock <> 'none' AND ends > ?", [input.id, nowMs]);
    if (held && held.ends != null) {
      return { ok: false, errors: { name: 'That list is part of a locked block.' }, lockedUntil: held.ends };
    }
    const heldUntil = await scheduleHoldsList(db, input.id, nowMs, tzOffsetAt);
    if (heldUntil !== null) {
      return { ok: false, errors: { name: 'That list is part of a locked schedule.' }, lockedUntil: heldUntil };
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
  const sites = [], apps = [], folders = [];
  checkAll('site', input.sites, errors, sites);
  checkAll('app', input.apps, errors, apps);
  checkAll('folder', input.folders, errors, folders);
  if (!errors.sites && !errors.apps && !errors.folders && sites.length + apps.length + folders.length > MAX_ITEMS) {
    errors.items = 'A list can hold up to 512 entries.';
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  const itemStmts = (listIdSql, listIdParams) => [
    ...sites.map(v => ({ sql: `INSERT INTO focus_items(list_id, kind, value) VALUES (${listIdSql}, 'site', ?)`, params: [...listIdParams, v] })),
    ...apps.map(v => ({ sql: `INSERT INTO focus_items(list_id, kind, value) VALUES (${listIdSql}, 'app', ?)`, params: [...listIdParams, v] })),
    ...folders.map(v => ({ sql: `INSERT INTO focus_items(list_id, kind, value) VALUES (${listIdSql}, 'folder', ?)`, params: [...listIdParams, v] })),
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
export async function deleteList(db, id, nowMs, tzOffsetAt = makeTzOffsetAt()) {
  const running = await db.all('SELECT 1 AS x FROM focus_sessions WHERE list_id = ? AND ends > ? LIMIT 1', [id, nowMs]);
  if (running.length) return { ok: false, reason: 'running' };
  if (await scheduleHoldsList(db, id, nowMs, tzOffsetAt) !== null) return { ok: false, reason: 'running' };
  await db.batch([
    { sql: 'DELETE FROM focus_schedule_lists WHERE list_id = ?', params: [id] },
    { sql: 'DELETE FROM focus_schedules WHERE id NOT IN (SELECT schedule_id FROM focus_schedule_lists)' },
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

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseWeekdays(raw) {
  try {
    const w = JSON.parse(raw);
    return Array.isArray(w) && w.every(d => Number.isInteger(d) && d >= 0 && d <= 6) ? w : null;
  } catch { return null; }
}

/**
 * Like listSchedules, but also counts rows skipped because they are unreadable
 * (bad weekdays JSON/values or bad start/end times).
 * @returns {Promise<{ schedules: ScheduleRec[], bad: number }>}
 */
export async function listSchedulesChecked(db) {
  const rows = await db.all('SELECT id, name, weekdays, start_time, end_time, lock, enabled, ends_on, unlock_delay_ms FROM focus_schedules ORDER BY id');
  const links = await db.all('SELECT schedule_id, list_id FROM focus_schedule_lists ORDER BY list_id');
  const byId = new Map();
  let bad = 0;
  for (const r of rows) {
    const weekdays = parseWeekdays(r.weekdays);
    if (!weekdays || !HHMM.test(String(r.start_time)) || !HHMM.test(String(r.end_time))) { bad++; continue; }
    byId.set(r.id, {
      id: r.id, name: r.name, listIds: [], weekdays, start: r.start_time, end: r.end_time,
      lock: r.lock, unlockDelayMs: r.unlock_delay_ms ?? null, endsOn: r.ends_on ?? null, enabled: r.enabled !== 0,
    });
  }
  for (const l of links) byId.get(l.schedule_id)?.listIds.push(l.list_id);
  return { schedules: [...byId.values()], bad };
}

/** @returns {Promise<ScheduleRec[]>} ordered by id; unreadable rows are skipped */
export async function listSchedules(db) {
  return (await listSchedulesChecked(db)).schedules;
}

async function getSchedule(db, id) {
  return (await listSchedules(db)).find(s => s.id === id) ?? null;
}

/**
 * End instant of a still-active locked schedule that uses the list (the latest, if several), else null.
 * @returns {Promise<number|null>}
 */
export async function scheduleHoldsList(db, listId, nowMs, tzOffsetAt) {
  let until = null;
  for (const s of await listSchedules(db)) {
    if (!s.listIds.includes(listId) || !isLockedActive(s, nowMs, tzOffsetAt)) continue;
    let end = localDayEnd(s.endsOn, tzOffsetAt);
    const run = nextOccurrence({ ...s, enabled: true }, nowMs, tzOffsetAt);
    if (run.state === 'running' && run.ends > end) end = run.ends;
    if (until === null || end > until) until = end;
  }
  return until;
}

/**
 * @param {Omit<ScheduleRec, 'id'|'enabled'> & { id?: number }} input
 * @returns {Promise<{ ok: true, id: number } | { ok: false, errors: Record<string, string> }>}
 */
export async function saveSchedule(db, input, nowMs, tzOffsetAt) {
  let existing = null;
  if (input.id !== undefined) {
    existing = await getSchedule(db, input.id);
    if (!existing) throw new Error('no such schedule');
    if (isLockedActive(existing, nowMs, tzOffsetAt)) {
      return { ok: false, errors: { name: `That schedule is locked until ${existing.endsOn}.` } };
    }
  }
  const v = validateSchedule(input, nowMs, tzOffsetAt);
  if (!v.ok) return v;
  const { name, listIds, weekdays, start, end, lock, unlockDelayMs, endsOn } = v.value;
  const known = new Set((await db.all('SELECT id FROM focus_lists')).map(l => l.id));
  if (!listIds.every(id => known.has(id))) return { ok: false, errors: { listIds: 'Choose lists that exist.' } };

  const linkStmts = (idSql, idParams) => listIds.map(l => ({
    sql: `INSERT INTO focus_schedule_lists(schedule_id, list_id) VALUES (${idSql}, ?)`, params: [...idParams, l],
  }));
  const cols = [name, JSON.stringify(weekdays), start, end, lock, endsOn, unlockDelayMs];
  if (existing) {
    const id = existing.id;
    await db.batch([
      { sql: 'UPDATE focus_schedules SET list_id = ?, name = ?, weekdays = ?, start_time = ?, end_time = ?, lock = ?, ends_on = ?, unlock_delay_ms = ? WHERE id = ?', params: [listIds[0], ...cols, id] },
      { sql: 'DELETE FROM focus_schedule_lists WHERE schedule_id = ?', params: [id] },
      ...linkStmts('?', [id]),
    ]);
    return { ok: true, id };
  }
  await db.batch([
    { sql: 'INSERT INTO focus_schedules(list_id, name, weekdays, start_time, end_time, lock, ends_on, unlock_delay_ms, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)', params: [listIds[0], ...cols] },
    ...linkStmts('(SELECT MAX(id) FROM focus_schedules)', []),
  ]);
  const [row] = await db.all('SELECT MAX(id) AS id FROM focus_schedules');
  return { ok: true, id: row.id };
}

/** @returns {Promise<{ ok: true } | { ok: false, reason: 'locked'|'missing' }>} */
export async function setScheduleEnabled(db, id, enabled, nowMs, tzOffsetAt) {
  const s = await getSchedule(db, id);
  if (!s) return { ok: false, reason: 'missing' };
  if (isLockedActive(s, nowMs, tzOffsetAt)) return { ok: false, reason: 'locked' };
  await db.run('UPDATE focus_schedules SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  return { ok: true };
}

/** @returns {Promise<{ ok: true } | { ok: false, reason: 'locked'|'missing' }>} */
export async function deleteSchedule(db, id, nowMs, tzOffsetAt) {
  const s = await getSchedule(db, id);
  if (!s) return { ok: false, reason: 'missing' };
  if (isLockedActive(s, nowMs, tzOffsetAt)) return { ok: false, reason: 'locked' };
  await db.batch([
    { sql: 'DELETE FROM focus_schedule_lists WHERE schedule_id = ?', params: [id] },
    { sql: 'DELETE FROM focus_schedules WHERE id = ?', params: [id] },
  ]);
  return { ok: true };
}
