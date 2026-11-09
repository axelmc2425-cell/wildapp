import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCountdown, groupSessions, parseDuration, classifyHelperFailure,
  bannerFor, describePushProblem, detailRows,
} from '../src/modules/focus/model.js';

test('formatCountdown', () => {
  assert.equal(formatCountdown(8040000), '2 h 14 min left');
  assert.equal(formatCountdown(7200000), '2 h left');
  assert.equal(formatCountdown(840000), '14 min left');
  assert.equal(formatCountdown(839001), '14 min left');
  assert.equal(formatCountdown(59000), '59 s left');
  assert.equal(formatCountdown(60000), '1 min left');
  assert.equal(formatCountdown(59001), '1 min left');
  assert.equal(formatCountdown(59999), '1 min left');
  assert.equal(formatCountdown(3599001), '1 h left');
  assert.equal(formatCountdown(3599999), '1 h left');
  assert.equal(formatCountdown(3600000), '1 h left');
  assert.equal(formatCountdown(0), 'Ending…');
  assert.equal(formatCountdown(-5), 'Ending…');
  assert.equal(formatCountdown(NaN), 'Ending…');
  assert.equal(formatCountdown(Infinity), 'Ending…');
});

test('formatCountdown is epoch based across a US DST change', () => {
  const start = Date.UTC(2026, 2, 8, 6, 0, 0); // before US spring-forward
  const end = start + 3 * 3600 * 1000;
  assert.equal(formatCountdown(end - start), '3 h left');
});

const lists = [{ id: 1, name: 'Work' }, { id: 2, name: 'Study' }];
const S = (id, listId, starts, ends, lock = 'none') => ({ id, listId, starts, ends, lock });

test('groupSessions groups, states, progress, sorting', () => {
  const now = 1500;
  const b = groupSessions([
    S(1, 1, 1000, 2000), S(2, 2, 1000, 2000),
    S(3, 1, 3000, 4000), S(4, 1, 0, 1500), S(5, 1, 0, 500),
  ], lists, now);
  assert.equal(b.length, 4);
  assert.deepEqual(b.map((x) => x.ends), [500, 1500, 2000, 4000]);
  const run = b.find((x) => x.ends === 2000);
  assert.deepEqual(run.ids, [1, 2]);
  assert.deepEqual(run.listNames, ['Work', 'Study']);
  assert.equal(run.key, '1000:2000:none');
  assert.equal(run.state, 'running');
  assert.equal(run.progress, 0.5);
  assert.equal(b.find((x) => x.ends === 4000).state, 'upcoming');
  assert.equal(b.find((x) => x.ends === 4000).progress, 0);
  assert.equal(b.find((x) => x.ends === 1500).state, 'finished');
  assert.equal(b.find((x) => x.ends === 1500).progress, 1);
  assert.equal(b.find((x) => x.ends === 500).state, 'finished');
});

test('groupSessions starting exactly now is running; drops bad rows; deleted list', () => {
  const b = groupSessions([
    S(1, 9, 1000, 2000), S(2, 1, 2000, 1000), S(3, 1, NaN, 5), S(4, 1, 1, Infinity),
    S(5, 1, 3, 3), null, S(6, 1, '1', 5),
  ], lists, 1000);
  assert.equal(b.length, 1);
  assert.deepEqual(b[0].listNames, ['(deleted list)']);
  assert.equal(b[0].state, 'running');
  assert.equal(b[0].progress, 0);
  assert.deepEqual(groupSessions(null, null, 0), []);
});

test('groupSessions separates different locks', () => {
  const b = groupSessions([S(1, 1, 0, 10, 'none'), S(2, 1, 0, 10, 'x')], lists, 5);
  assert.equal(b.length, 2);
  assert.notEqual(b[0].key, b[1].key);
});

test('parseDuration', () => {
  for (const c of ['0', '1441', '2.5', 'abc', '', '-3', '1e2']) {
    assert.equal(parseDuration({ custom: c }).ok, false, c);
  }
  assert.deepEqual(parseDuration({ custom: '90' }), { ok: true, minutes: 90 });
  assert.deepEqual(parseDuration({ custom: ' 1440 ' }), { ok: true, minutes: 1440 });
  assert.deepEqual(parseDuration({ preset: 25 }), { ok: true, minutes: 25 });
  assert.equal(parseDuration({}).ok, false);
  assert.equal(typeof parseDuration({ custom: 'x' }).message, 'string');
});

test('classifyHelperFailure', () => {
  assert.equal(classifyHelperFailure({ code: 'persist-failed', message: 'disk' }).kind, 'persist-failed');
  assert.equal(classifyHelperFailure({ code: 'persist-failed', message: 'disk' }).message, 'disk');
  assert.equal(classifyHelperFailure({ code: 'unreachable', message: 'The Focus Room helper service is not running' }).kind, 'not-running');
  assert.equal(classifyHelperFailure({ code: 'unreachable', message: 'Focus Room blocking is only available on Windows' }).kind, 'unavailable');
  assert.equal(classifyHelperFailure({ code: 'unreachable', message: 'only available in the desktop app' }).kind, 'unavailable');
  assert.equal(classifyHelperFailure({ code: 'unreachable', message: "Cannot read properties of undefined (reading 'core')" }).kind, 'unavailable');
  assert.equal(classifyHelperFailure({ code: 'unreachable', message: 'focus helper did not answer in time' }).kind, 'timeout');
  const u = classifyHelperFailure({ code: 'bad-window', message: 'nope' });
  assert.deepEqual(u, { kind: 'unknown', message: 'nope' });
  assert.equal(classifyHelperFailure(null).kind, 'unknown');
  assert.equal(classifyHelperFailure('weird').kind, 'unknown');
});

const okStatus = (w = []) => ({ decision: { blockSites: ['a'], blockApps: [], allow: null, frozen: false, locks: [] }, windows: [], partner_set: false, now_ms: 0, warnings: w });

test('bannerFor', () => {
  assert.equal(bannerFor({ kind: 'ok', status: okStatus() }).level, 'ok');
  assert.equal(bannerFor({ kind: 'ok', status: okStatus() }).title, 'Helper running.');
  const w = bannerFor({ kind: 'ok', status: okStatus(['dns: boom']) });
  assert.equal(w.level, 'warn');
  assert.equal(w.title, 'Helper running, with warnings.');
  assert.equal(w.detail, "The helper couldn't update DNS settings.");
  assert.equal(bannerFor({ kind: 'ok', status: { warnings: undefined } }).level, 'ok');
  const n = bannerFor({ kind: 'not-running' });
  assert.equal(n.level, 'error');
  assert.equal(n.title, "Blocking is not active. The helper isn't running.");
  assert.match(n.detail, /MyBrainFocus/);
  assert.equal(bannerFor({ kind: 'persist-failed', message: 'm' }).level, 'error');
  assert.equal(bannerFor({ kind: 'persist-failed', message: 'm' }).title, 'A change is active but will be lost on restart.');
  assert.equal(bannerFor({ kind: 'unavailable' }).level, 'muted');
  assert.equal(bannerFor({ kind: 'unavailable' }).detail, 'Blocking only works in the Windows app.');
  assert.equal(bannerFor({ kind: 'timeout' }).level, 'error');
  assert.equal(bannerFor({ kind: 'timeout' }).title, "The helper didn't answer.");
  const u = bannerFor({ kind: 'unknown', message: 'boom' });
  assert.equal(u.level, 'error');
  assert.equal(u.detail, 'boom');
});

test('bannerFor warnings use real strings and severity order', () => {
  const P = 'persist: disk full', H = 'hosts: denied', D = 'dns: x', O = 'doh: y';
  const L = "HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\DnsOverHttpsMode (existing value 'automatic' left in place)";
  const B = 'state: loaded from backup';
  const U = 'state: unreadable, started empty — previous state kept as C:\\x';
  const b = (...w) => bannerFor({ kind: 'ok', status: okStatus(w) });
  const hidden = b(B, P);
  assert.equal(hidden.level, 'error');
  assert.equal(hidden.title, 'A change is active but will be lost on restart.');
  assert.equal(hidden.detail, "Your changes couldn't be saved to disk and will be lost on restart.");
  assert.equal(b(U, L, O, D, H).detail, "The helper couldn't update the Windows hosts file, so some websites may not be blocked. (+4 more)");
  assert.equal(b(U, L, O, D).detail, "The helper couldn't update DNS settings. (+3 more)");
  assert.equal(b(U, L, O).detail, "The helper couldn't turn off secure-DNS bypass in the browser. (+2 more)");
  assert.equal(b(U, L).detail, 'A browser setting that could bypass blocking was left unchanged. (+1 more)');
  assert.equal(b(U, B).detail, "The helper's saved state was unreadable, so it started empty. (+1 more)");
  assert.equal(b(B).detail, 'The helper restored your last saved state from a backup.');
  assert.equal(b(U).detail, "The helper's saved state was unreadable, so it started empty.");
  assert.equal(b('something odd').detail, 'something odd');
  assert.equal(b(L).level, 'warn');
  assert.equal(bannerFor({ kind: 'ok', status: okStatus([]) }).level, 'ok');
});

test('describePushProblem', () => {
  const s = describePushProblem({ code: 'too-many', message: 'Too many windows in list "Work"' }, 0, ['Work']);
  assert.match(s, /Work/);
  assert.doesNotMatch(s, /couldn't be sent/);
  assert.match(describePushProblem({ message: 'x' }, 3, []), /3 items couldn't be sent/);
  assert.match(describePushProblem({ message: 'x' }, 1, []), /1 item couldn't be sent/);
  assert.equal(typeof describePushProblem(null, 0, []), 'string');
});

test('detailRows Windows held excludes early-ended windows', () => {
  const r = detailRows({ decision: { blockSites: [], blockApps: [], allow: null, frozen: false, locks: [] }, windows: [{ id: 'a', ends: 100 }, { id: 'b', ends: 50 }, { id: 'c', ends: 500 }], partner_set: true, now_ms: 100, warnings: [] });
  assert.equal(Object.fromEntries(r.map((x) => [x.label, x.value]))['Windows held'], '1');
});

test('detailRows', () => {
  const r = detailRows({ decision: { blockSites: ['a', 'b'], blockApps: ['x', 'y', 'z'], allow: null, frozen: false, locks: [] }, windows: [1, 2], partner_set: true, now_ms: 0, warnings: ['w1', 'w2'] });
  const m = Object.fromEntries(r.map((x) => [x.label, x.value]));
  assert.equal(m['Helper'], 'Running');
  assert.equal(m['Partner key'], 'set');
  assert.equal(m['Blocking now'], '2 sites, 3 apps');
  assert.equal(m['Windows held'], '2');
  assert.match(m['Warnings'], /w1/);
  assert.match(m['Warnings'], /w2/);
  assert.ok(m['Helper clock']);
  const n = detailRows(null);
  assert.equal(n.find((x) => x.label === 'Helper').value, 'Not reachable');
});

test('detailRows lines carry each warning verbatim', () => {
  const st = { decision: {}, windows: [], partner_set: false, now_ms: 0, warnings: ['hosts: Access is denied. (os error 5)', 'state: loaded from backup; ok'] };
  const w = detailRows(st).find((x) => x.label === 'Warnings');
  assert.deepEqual(w.lines, ['hosts: Access is denied. (os error 5)', 'state: loaded from backup; ok']);
  assert.match(w.value, /Access is denied/);
  assert.equal(detailRows({ ...st, warnings: [] }).find((x) => x.label === 'Warnings').lines, undefined);
  assert.equal(detailRows({ ...st, warnings: [] }).find((x) => x.label === 'Warnings').value, 'None');
  assert.equal(detailRows(null).find((x) => x.label === 'Warnings').lines, undefined);
});

test('groupSessions: locked blocks carry lock and delay; delay splits the group', () => {
  const lists = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
  const b = groupSessions([
    { id: 1, listId: 1, starts: 0, ends: 100, lock: 'locked', unlockDelayMs: 3600000 },
    { id: 2, listId: 2, starts: 0, ends: 100, lock: 'locked', unlockDelayMs: 3600000 },
    { id: 3, listId: 2, starts: 0, ends: 100, lock: 'locked', unlockDelayMs: 7200000 },
    { id: 4, listId: 1, starts: 0, ends: 100 },
  ], lists, 50);
  assert.equal(b.length, 3);
  const same = b.find((x) => x.ids.length === 2);
  assert.equal(same.lock, 'locked');
  assert.equal(same.unlockDelayMs, 3600000);
  assert.deepEqual(same.listIds, [1, 2]);
  assert.ok(b.some((x) => x.lock === 'locked' && x.unlockDelayMs === 7200000));
  const normal = b.find((x) => x.key === '0:100:none');
  assert.ok(normal);
  assert.equal(normal.lock, 'none');
  assert.equal(normal.unlockDelayMs, null);
});

test('detailRows shows the partner name and each pending unlock', () => {
  const st = { decision: {}, windows: [], partner_set: true, now_ms: 0, warnings: [], pending_unlocks: [{ window_id: 'w1', unlock_at: 5000 }] };
  const rows = detailRows(st, { partnerName: 'Sam', formatTime: (ms) => `t${ms}`, labelFor: (id) => (id === 'w1' ? 'Games' : '') });
  const m = Object.fromEntries(rows.map((x) => [x.label, x]));
  assert.equal(m['Partner key'].value, 'Sam (key set)');
  assert.deepEqual(m['Pending unlocks'].lines, ['Games unlocks at t5000']);
  const plain = detailRows({ ...st, pending_unlocks: [] });
  assert.equal(plain.find((x) => x.label === 'Pending unlocks'), undefined);
  assert.equal(plain.find((x) => x.label === 'Partner key').value, 'set');
  assert.equal(detailRows({ ...st, partner_set: false }, { partnerName: 'Sam' }).find((x) => x.label === 'Partner key').value, 'not set');
});
