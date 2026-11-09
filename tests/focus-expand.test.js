import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionToWindow, expandSchedule } from '../src/modules/focus/expand.js';

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
const sched = (o) => ({ id: 7, weekdays: [1, 2, 3, 4, 5], start_time: '09:00', end_time: '17:00', lock: 'none', ...o });

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
  const ws = expandSchedule(sched({}), list, from, 7 * 24 * H, nyOffset);
  assert.equal(ws.length, 5);
  assert.equal(iso(ws[0].starts), '2026-01-05T14:00:00.000Z');
  assert.equal(iso(ws[0].ends), '2026-01-05T22:00:00.000Z');
  assert.equal(ws[0].id, 'c7@' + ws[0].starts);
  assert.equal(ws[0].mode, 'block');
  assert.deepEqual(ws[0].sites, ['x.com']);
});

test('overnight Friday 22:00-02:00 is one 4h window ending Saturday 02:00', () => {
  const from = Date.UTC(2026, 0, 5, 5);
  const ws = expandSchedule(sched({ weekdays: [5], start_time: '22:00', end_time: '02:00', lock: 'frozen' }), list, from, 7 * 24 * H, nyOffset);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].ends - ws[0].starts, 4 * H);
  assert.equal(iso(ws[0].starts), '2026-01-10T03:00:00.000Z');
  assert.equal(iso(ws[0].ends), '2026-01-10T07:00:00.000Z'); // Sat 02:00 EST
  assert.equal(ws[0].lock, 'frozen');
});

test('occurrence in progress at fromMs is included', () => {
  const from = Date.UTC(2026, 0, 6, 17); // Tue 12:00 EST
  const ws = expandSchedule(sched({}), list, from, H, nyOffset);
  assert.equal(ws.length, 1);
  assert.equal(iso(ws[0].starts), '2026-01-06T14:00:00.000Z');
  // overnight occurrence that started the previous day
  const from2 = Date.UTC(2026, 0, 10, 6); // Sat 01:00 EST
  const ws2 = expandSchedule(sched({ weekdays: [5], start_time: '22:00', end_time: '02:00' }), list, from2, H, nyOffset);
  assert.equal(ws2.length, 1);
  assert.equal(iso(ws2[0].starts), '2026-01-10T03:00:00.000Z');
});

test('occurrences outside the range are excluded', () => {
  const from = Date.UTC(2026, 0, 6, 23); // Tue 18:00 EST, after the window
  assert.equal(expandSchedule(sched({ weekdays: [2] }), list, from, H, nyOffset).length, 0);
});

test('spring forward 2026-03-08 02:30-03:30 yields one window (gap resolves to instant after gap)', () => {
  const from = Date.UTC(2026, 2, 8, 0); // Sat evening local
  const ws = expandSchedule(sched({ weekdays: [0], start_time: '02:30', end_time: '03:30' }), list, from, 2 * 24 * H, nyOffset);
  assert.equal(ws.length, 1);
  assert.equal(iso(ws[0].starts), '2026-03-08T07:00:00.000Z'); // 03:00 EDT, first instant after gap
  assert.equal(iso(ws[0].ends), '2026-03-08T07:30:00.000Z'); // 03:30 EDT
});

test('fall back 2026-11-01 01:30-02:30 yields one window (ambiguous start = first occurrence)', () => {
  const from = Date.UTC(2026, 10, 1, 0);
  const ws = expandSchedule(sched({ weekdays: [0], start_time: '01:30', end_time: '02:30' }), list, from, 2 * 24 * H, nyOffset);
  assert.equal(ws.length, 1);
  assert.equal(iso(ws[0].starts), '2026-11-01T05:30:00.000Z'); // 01:30 EDT
  assert.equal(iso(ws[0].ends), '2026-11-01T07:30:00.000Z'); // 02:30 EST
});
