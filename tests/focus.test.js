import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrate } from '../src/core/schema.js';
import { DEFAULTS, initial, start, pause, tick, skip, remaining } from '../src/modules/focus/timer.js';
import { dayKey, todayMinutes, lastDays, streak } from '../src/modules/focus/stats.js';
import { logSession, listSessions, deleteSession, getSetting, setSetting, focusSearch } from '../src/modules/focus/repo.js';
import { noiseSamples } from '../src/modules/focus/sound.js';
import { createController } from '../src/modules/focus/controller.js';

const MIN = 60000;
async function fresh() {
  const db = await openNodeDb(join(mkdtempSync(join(tmpdir(), 'mybrain-')), 't.db'));
  await migrate(db);
  return db;
}

// ---- timer
test('a new timer is an idle work phase with the full work time left', () => {
  const s = initial(DEFAULTS);
  assert.equal(s.phase, 'work');
  assert.equal(s.status, 'idle');
  assert.equal(remaining(s, 1000), 25 * MIN);
});

test('start, pause and resume keep the remaining time', () => {
  let s = start(initial(DEFAULTS), 0);
  assert.equal(remaining(s, 5 * MIN), 20 * MIN);
  s = pause(s, 5 * MIN);
  assert.equal(s.status, 'paused');
  assert.equal(remaining(s, 99 * MIN), 20 * MIN);
  s = start(s, 100 * MIN);
  assert.equal(remaining(s, 110 * MIN), 10 * MIN);
});

test('tick before the end changes nothing; at the end the phase finishes', () => {
  const s = start(initial(DEFAULTS), 0);
  assert.equal(tick(s, 24 * MIN).finished, null);
  const r = tick(s, 25 * MIN);
  assert.deepEqual(r.finished, { phase: 'work', minutes: 25 });
  assert.equal(r.state.phase, 'short');
  assert.equal(r.state.status, 'idle');
  assert.equal(remaining(r.state, 0), 5 * MIN);
});

test('every fourth work phase is followed by a long break', () => {
  let s = initial(DEFAULTS);
  const phases = [];
  for (let i = 0; i < 8; i++) {
    s = start(s, 0);
    const r = tick(s, 999 * MIN);
    s = r.state;
    phases.push(s.phase);
  }
  assert.deepEqual(phases, ['short', 'work', 'short', 'work', 'short', 'work', 'long', 'work']);
});

test('skip moves to the next phase without finishing', () => {
  const s = skip(start(initial(DEFAULTS), 0));
  assert.equal(s.phase, 'short');
  assert.equal(s.status, 'idle');
});

test('custom lengths are used', () => {
  const s = initial({ work: 50, short: 10, long: 30, longEvery: 2 });
  assert.equal(remaining(s, 0), 50 * MIN);
});

// ---- stats
const at = (y, mo, d, h = 12) => new Date(y, mo, d, h).getTime();
const sess = (t, minutes, extra = {}) => ({ started: t, minutes, kind: 'work', completed: 1, ...extra });

test('todayMinutes counts completed work sessions of the local day only', () => {
  const now = at(2026, 5, 10, 18);
  const list = [sess(at(2026, 5, 10, 9), 25), sess(at(2026, 5, 10, 10), 25), sess(at(2026, 5, 9, 23), 25),
    sess(at(2026, 5, 10, 11), 5, { kind: 'break' }), sess(at(2026, 5, 10, 12), 25, { completed: 0 })];
  assert.equal(todayMinutes(list, now), 50);
});

test('lastDays returns n days oldest first with zero days included', () => {
  const now = at(2026, 5, 10);
  const days = lastDays([sess(at(2026, 5, 10), 30), sess(at(2026, 5, 8), 10)], now, 3);
  assert.deepEqual(days, [{ day: '2026-06-08', minutes: 10 }, { day: '2026-06-09', minutes: 0 }, { day: '2026-06-10', minutes: 30 }]);
  assert.equal(dayKey(at(2026, 0, 5)), '2026-01-05');
});

test('streak counts consecutive days and tolerates an empty today', () => {
  const list = [sess(at(2026, 5, 9), 25), sess(at(2026, 5, 8), 25), sess(at(2026, 5, 7), 25), sess(at(2026, 5, 5), 25)];
  assert.equal(streak(list, at(2026, 5, 10)), 3);
  assert.equal(streak([...list, sess(at(2026, 5, 10), 25)], at(2026, 5, 10)), 4);
  assert.equal(streak([], at(2026, 5, 10)), 0);
  assert.equal(streak([sess(at(2026, 5, 1), 25)], at(2026, 5, 10)), 0);
});

// ---- repo
test('sessions are logged, listed newest first and deleted', async () => {
  const db = await fresh();
  const a = await logSession(db, { started: 1000, minutes: 25, task: 'write [[Plan]]' });
  await logSession(db, { started: 2000, minutes: 25, task: 'code' });
  assert.deepEqual((await listSessions(db)).map(s => s.task), ['code', 'write [[Plan]]']);
  assert.deepEqual((await listSessions(db, { since: 1500 })).map(s => s.task), ['code']);
  await deleteSession(db, a.id);
  assert.equal((await listSessions(db)).length, 1);
});

test('settings round-trip with a default', async () => {
  const db = await fresh();
  assert.deepEqual(await getSetting(db, 'focus.timer', { work: 25 }), { work: 25 });
  await setSetting(db, 'focus.timer', { work: 40 });
  await setSetting(db, 'focus.timer', { work: 45 });
  assert.deepEqual(await getSetting(db, 'focus.timer', { work: 25 }), { work: 45 });
});

test('focusSearch finds sessions by task text, case-insensitively', async () => {
  const db = await fresh();
  await logSession(db, { started: Date.UTC(2026, 5, 1), minutes: 25, task: 'Draft the Report' });
  const hits = await focusSearch(db, 'report');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].module, 'focus');
  assert.equal(hits[0].title, 'Draft the Report');
});

// ---- sound
function seeded(seed) { let a = seed; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('noise samples stay within -1..1 and are deterministic for a seed', () => {
  for (const kind of ['white', 'brown', 'rain']) {
    const a = noiseSamples(kind, 2000, seeded(1));
    const b = noiseSamples(kind, 2000, seeded(1));
    assert.equal(a.length, 2000);
    assert.deepEqual([...a], [...b]);
    assert.ok(a.every(v => v >= -1 && v <= 1), kind);
  }
});

test('brown noise is smoother than white noise', () => {
  const lag = (x) => { let s = 0; for (let i = 1; i < x.length; i++) s += Math.abs(x[i] - x[i - 1]); return s / x.length; };
  assert.ok(lag(noiseSamples('brown', 5000, seeded(2))) < lag(noiseSamples('white', 5000, seeded(2))) / 3);
});

// ---- controller
test('the controller logs a work session when the phase finishes and keeps the task', async () => {
  const db = await fresh();
  let now = 10_000_000;
  const c = createController({ db, settings: DEFAULTS, now: () => now });
  const events = [];
  c.subscribe(e => events.push(e));
  c.start('Write report');
  now += 25 * MIN;
  await c.tick();
  const [s] = await listSessions(db);
  assert.equal(s.task, 'Write report');
  assert.equal(s.minutes, 25);
  assert.equal(s.started, 10_000_000);
  assert.equal(c.state().phase, 'short');
  assert.ok(events.some(e => e.type === 'finished' && e.phase === 'work'));
});

test('a break finishing is not logged, and pausing then resuming does not log early', async () => {
  const db = await fresh();
  let now = 0;
  const c = createController({ db, settings: DEFAULTS, now: () => now });
  c.start('x');
  now += 10 * MIN; c.pause(); now += 60 * MIN; c.start('x');
  await c.tick();
  assert.equal((await listSessions(db)).length, 0);
  now += 15 * MIN; await c.tick();
  assert.equal((await listSessions(db)).length, 1);
  c.start(); now += 5 * MIN; await c.tick();
  assert.equal((await listSessions(db)).length, 1);
  assert.equal(c.state().phase, 'work');
});
