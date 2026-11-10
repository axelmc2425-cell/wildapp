import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionToWindow, expandSchedule, lockedBlockToWindow, localDayEnd } from '../src/modules/focus/expand.js';

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});
// Minutes east of UTC for America/New_York at a UTC instant.
function nyOffset(utcMs) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}
const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const list = { id: 1, mode: 'block', items: [{ kind: 'site', value: 'x.com' }] };
const sched = (o) => ({
  id: 7, name: '', listIds: [1], weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', lock: 'none',
  unlockDelayMs: null, endsOn: null, enabled: true, ...o,
});
const byId = (...ls) => new Map(ls.map((l) => [l.id, l]));
const lists1 = byId(list);

test('nyOffset helper sanity', () => {
  assert.equal(nyOffset(Date.UTC(2026, 0, 15, 12)), -300);
  assert.equal(nyOffset(Date.UTC(2026, 6, 15, 12)), -240);
});

test('sessionToWindow normalizes, dedupes, skips invalid', () => {
  const w = sessionToWindow({ id: 3, starts: 10, ends: 20, lock: 'locked' }, {
    id: 1, mode: 'allow',
    items: [
      { kind: 'site', value: 'https://www.X.com/a' }, { kind: 'site', value: 'x.com' }, { kind: 'site', value: 'nope' },
      { kind: 'app', value: 'Slack' }, { kind: 'app', value: 'C:\\Apps\\slack.exe' }, { kind: 'app', value: '' },
    ],
  });
  assert.deepEqual(w, { id: 's3', starts: 10, ends: 20, lock: 'locked', mode: 'allow', sites: ['x.com'], apps: ['slack.exe'] });
});

test('weekdays 9-17 over one week yields 5 windows', () => {
  const from = Date.UTC(2026, 0, 5, 5); // Mon 00:00 EST
  const ws = expandSchedule(sched({}), lists1, from, 7 * 24 * H, nyOffset);
  assert.equal(ws.length, 5);
  assert.equal(iso(ws[0].starts), '2026-01-05T14:00:00.000Z');
  assert.equal(iso(ws[0].ends), '2026-01-05T22:00:00.000Z');
  assert.equal(ws[0].id, 'c7@' + ws[0].starts);
  assert.equal(ws[0].mode, 'block');
  assert.deepEqual(ws[0].sites, ['x.com']);
});

test('overnight Friday 22:00-02:00 is one 4h window ending Saturday 02:00', () => {
  const from = Date.UTC(2026, 0, 5, 5);
  const ws = expandSchedule(sched({ weekdays: [5], start: '22:00', end: '02:00', lock: 'frozen' }), lists1, from, 7 * 24 * H, nyOffset);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].ends - ws[0].starts, 4 * H);
  assert.equal(iso(ws[0].starts), '2026-01-10T03:00:00.000Z');
  assert.equal(iso(ws[0].ends), '2026-01-10T07:00:00.000Z'); // Sat 02:00 EST
  assert.equal(ws[0].lock, 'frozen');
});

test('occurrence in progress at fromMs is included', () => {
  const from = Date.UTC(2026, 0, 6, 17); // Tue 12:00 EST
  const ws = expandSchedule(sched({}), lists1, from, H, nyOffset);
  assert.equal(ws.length, 1);
  assert.equal(iso(ws[0].starts), '2026-01-06T14:00:00.000Z');
  // overnight occurrence that started the previous day
  const from2 = Date.UTC(2026, 0, 10, 6); // Sat 01:00 EST
  const ws2 = expandSchedule(sched({ weekdays: [5], start: '22:00', end: '02:00' }), lists1, from2, H, nyOffset);
  assert.equal(ws2.length, 1);
  assert.equal(iso(ws2[0].starts), '2026-01-10T03:00:00.000Z');
});

test('occurrences outside the range are excluded', () => {
  const from = Date.UTC(2026, 0, 6, 23); // Tue 18:00 EST, after the window
  assert.equal(expandSchedule(sched({ weekdays: [2] }), lists1, from, H, nyOffset).length, 0);
});

test('spring forward 2026-03-08 02:30-03:30 yields one window (gap resolves to instant after gap)', () => {
  const from = Date.UTC(2026, 2, 8, 0); // Sat evening local
  const ws = expandSchedule(sched({ weekdays: [0], start: '02:30', end: '03:30' }), lists1, from, 2 * 24 * H, nyOffset);
  assert.equal(ws.length, 1);
  assert.equal(iso(ws[0].starts), '2026-03-08T07:00:00.000Z'); // 03:00 EDT, first instant after gap
  assert.equal(iso(ws[0].ends), '2026-03-08T07:30:00.000Z'); // 03:30 EDT
});

test('fall back 2026-11-01 01:30-02:30 yields one window (ambiguous start = first occurrence)', () => {
  const from = Date.UTC(2026, 10, 1, 0);
  const ws = expandSchedule(sched({ weekdays: [0], start: '01:30', end: '02:30' }), lists1, from, 2 * 24 * H, nyOffset);
  assert.equal(ws.length, 1);
  assert.equal(iso(ws[0].starts), '2026-11-01T05:30:00.000Z'); // 01:30 EDT
  assert.equal(iso(ws[0].ends), '2026-11-01T07:30:00.000Z'); // 02:30 EST
});

const DELAY = 3600000;
const lsess = (id, listId, o = {}) => ({ id, listId, starts: 1000, ends: 5000, lock: 'locked', unlockDelayMs: DELAY, ...o });

test('two lists in one locked block become one window with the union of items', () => {
  const listsById = new Map([
    [1, { id: 1, mode: 'block', items: [{ kind: 'site', value: 'x.com' }, { kind: 'app', value: 'Slack' }] }],
    [2, { id: 2, mode: 'block', items: [{ kind: 'site', value: 'https://www.X.com/' }, { kind: 'site', value: 'y.com' }, { kind: 'app', value: 'slack.exe' }] }],
  ]);
  const w = lockedBlockToWindow([lsess(1, 1), lsess(2, 2)], listsById);
  assert.equal(w.id, 'b1000-1.2');
  assert.deepEqual(w.sites.sort(), ['x.com', 'y.com']);
  assert.deepEqual(w.apps, ['slack.exe']);
  assert.equal(w.lock, 'locked');
  assert.equal(w.mode, 'block');
  assert.equal(w.starts, 1000);
  assert.equal(w.ends, 5000);
});

test('locked windows carry unlock_delay_ms', () => {
  const listsById = new Map([[1, list]]);
  assert.equal(lockedBlockToWindow([lsess(1, 1, { unlockDelayMs: 7200000 })], listsById).unlock_delay_ms, 7200000);
});

test('window id is stable across calls and independent of row order', () => {
  const listsById = new Map([[3, list], [10, list], [2, list]]);
  const a = lockedBlockToWindow([lsess(1, 3), lsess(2, 10), lsess(3, 2)], listsById);
  const b = lockedBlockToWindow([lsess(3, 2), lsess(1, 3), lsess(2, 10)], listsById);
  assert.equal(a.id, b.id);
  assert.equal(a.id, 'b1000-2.3.10');
});

test('folders become app_folders only when non-empty; ids and shapes unchanged otherwise', () => {
  const l = { id: 1, mode: 'block', items: [{ kind: 'site', value: 'x.com' }, { kind: 'folder', value: 'C:/Games/Foo/' }, { kind: 'folder', value: 'C:\\Games\\Foo' }, { kind: 'folder', value: 'rel' }] };
  const w = sessionToWindow({ id: 3, starts: 10, ends: 20, lock: 'none' }, l);
  assert.deepEqual(w.app_folders, ['C:\\Games\\Foo']);
  assert.ok(!('app_folders' in sessionToWindow({ id: 3, starts: 10, ends: 20, lock: 'none' }, list)));
  const ws = expandSchedule(sched({}), byId(l), Date.UTC(2026, 0, 5, 5), 7 * 24 * H, nyOffset);
  assert.ok(ws.every((x) => x.app_folders.length === 1 && x.app_folders[0] === 'C:\\Games\\Foo'));
  assert.ok(expandSchedule(sched({}), lists1, Date.UTC(2026, 0, 5, 5), 7 * 24 * H, nyOffset).every((x) => !('app_folders' in x)));
});

test('a locked block unions folders across lists', () => {
  const byId = new Map([
    [1, { id: 1, mode: 'block', items: [{ kind: 'folder', value: 'C:\\A' }, { kind: 'folder', value: 'C:\\B' }] }],
    [2, { id: 2, mode: 'block', items: [{ kind: 'folder', value: 'C:\\B' }, { kind: 'folder', value: 'C:\\C' }] }],
    [3, { id: 3, mode: 'block', items: [{ kind: 'site', value: 'x.com' }] }],
  ]);
  const s = (listId) => ({ listId, starts: 1000, ends: 2000, unlockDelayMs: 3600000 });
  assert.deepEqual(lockedBlockToWindow([s(1), s(2)], byId).app_folders, ['C:\\A', 'C:\\B', 'C:\\C']);
  assert.ok(!('app_folders' in lockedBlockToWindow([s(3)], byId)));
});

test('localDayEnd is 00:00 local the day after endsOn', () => {
  assert.equal(iso(localDayEnd('2026-01-10', () => 0)), '2026-01-11T00:00:00.000Z');
  assert.equal(iso(localDayEnd('2026-01-10', () => -300)), '2026-01-11T05:00:00.000Z');
  assert.equal(iso(localDayEnd('2026-12-31', () => 0)), '2027-01-01T00:00:00.000Z');
});

test('localDayEnd across a DST-gap midnight resolves to the first instant after the gap', () => {
  // Zone whose spring-forward skips 00:00-01:00 local on 2026-03-08 (offset -300 -> -240 at 05:00Z).
  const gap = (utc) => (utc < Date.UTC(2026, 2, 8, 5) ? -300 : -240);
  assert.equal(iso(localDayEnd('2026-03-07', gap)), '2026-03-08T05:00:00.000Z');
  assert.equal(iso(localDayEnd('2026-03-07', nyOffset)), '2026-03-08T05:00:00.000Z');
});

test('schedule over two lists unions sites, apps and folders', () => {
  const a = { id: 1, mode: 'block', items: [{ kind: 'site', value: 'x.com' }, { kind: 'app', value: 'Slack' }] };
  const b = { id: 2, mode: 'block', items: [{ kind: 'site', value: 'https://www.X.com/' }, { kind: 'site', value: 'y.com' }, { kind: 'folder', value: 'C:\\Games\\Foo' }] };
  const ws = expandSchedule(sched({ listIds: [1, 2] }), byId(a, b), Date.UTC(2026, 0, 5, 5), 24 * H, nyOffset);
  assert.equal(ws.length, 1);
  assert.deepEqual(ws[0].sites.sort(), ['x.com', 'y.com']);
  assert.deepEqual(ws[0].apps, ['slack.exe']);
  assert.deepEqual(ws[0].app_folders, ['C:\\Games\\Foo']);
  assert.equal(ws[0].mode, 'block');
});

test('missing lists are ignored; none left gives no windows', () => {
  const from = Date.UTC(2026, 0, 5, 5);
  assert.equal(expandSchedule(sched({ listIds: [1, 99] }), lists1, from, 24 * H, nyOffset).length, 1);
  assert.deepEqual(expandSchedule(sched({ listIds: [99] }), lists1, from, 24 * H, nyOffset), []);
});

test('disabled schedule gives no windows', () => {
  assert.deepEqual(expandSchedule(sched({ enabled: false }), lists1, Date.UTC(2026, 0, 5, 5), 7 * 24 * H, nyOffset), []);
});

test('endsOn yesterday gives no windows', () => {
  const from = Date.UTC(2026, 0, 7, 5); // Wed 00:00 EST
  assert.deepEqual(expandSchedule(sched({ endsOn: '2026-01-06' }), lists1, from, 7 * 24 * H, nyOffset), []);
});

test('endsOn today keeps today and drops later days', () => {
  const from = Date.UTC(2026, 0, 7, 5); // Wed
  const ws = expandSchedule(sched({ endsOn: '2026-01-07' }), lists1, from, 7 * 24 * H, nyOffset);
  assert.equal(ws.length, 1);
  assert.equal(iso(ws[0].starts), '2026-01-07T14:00:00.000Z');
});

test('endsOn keeps an overnight occurrence that starts that day whole and drops the next day', () => {
  const from = Date.UTC(2026, 0, 5, 5);
  const ws = expandSchedule(sched({ weekdays: [5, 6], start: '22:00', end: '02:00', endsOn: '2026-01-09' }), lists1, from, 7 * 24 * H, nyOffset);
  assert.equal(ws.length, 1);
  assert.equal(iso(ws[0].starts), '2026-01-10T03:00:00.000Z'); // Fri 22:00 EST
  assert.equal(iso(ws[0].ends), '2026-01-10T07:00:00.000Z'); // Sat 02:00 EST, past the end date, kept whole
});

test('locked occurrence carries unlock_delay_ms; unlocked does not', () => {
  const from = Date.UTC(2026, 0, 5, 5);
  const locked = expandSchedule(sched({ lock: 'locked', unlockDelayMs: 7200000 }), lists1, from, 24 * H, nyOffset);
  assert.equal(locked[0].unlock_delay_ms, 7200000);
  assert.equal(locked[0].lock, 'locked');
  assert.ok(!('unlock_delay_ms' in expandSchedule(sched({}), lists1, from, 24 * H, nyOffset)[0]));
});

test('schedule window ids are stable across calls', () => {
  const from = Date.UTC(2026, 0, 5, 5);
  const a = expandSchedule(sched({ listIds: [1] }), lists1, from, 7 * 24 * H, nyOffset).map((w) => w.id);
  const b = expandSchedule(sched({ listIds: [1] }), lists1, from + H, 7 * 24 * H, nyOffset).map((w) => w.id);
  assert.deepEqual(a.slice(1), b.slice(1));
  assert.ok(a.every((id) => /^c7@\d+$/.test(id)));
});
