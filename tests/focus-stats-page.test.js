import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, findAll } from './helpers/fake-dom.js';
import { mountStatsPage } from '../src/modules/focus/ui/stats-page.js';

const NOW = Date.UTC(2026, 10, 11, 12, 0); // Wed 2026-11-11
const tick = () => new Promise((r) => setImmediate(r));
const text = (root) => root.textContent;
const btn = (root, t) => findAll(root, (n) => n.tag === 'button' && n.textContent === t)[0];
const row = (day, total, apps = { 'a.exe': total }, sites = {}, other = 0) => ({ day, total, apps, sites, other_browsing: other });

// Every mounted page is stopped after its test, so a failed assertion cannot leave a refresh interval running.
const mounted = [];
afterEach(() => { for (const stop of mounted.splice(0)) { try { stop(); } catch { /* already stopped */ } } });

function setup({ usage, helper = { kind: 'ok', status: { usage_tracking: true } }, deps = {} } = {}) {
  const body = installDom(undefined);
  const calls = [];
  const controller = {
    state: { helper },
    async getUsage(from, to) { calls.push([from, to]); return usage ? usage(from, to, calls.length) : { ok: true, days: [] }; },
  };
  const subs = new Set();
  const stop = mountStatsPage(body, controller, { onBack() {}, now: () => NOW, tzOffsetAt: () => 0, subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); }, ...deps });
  mounted.push(stop);
  return { body, calls, controller, stop, subs };
}

test('loading, then Week on 2026-11-11 requests this week and the previous week', async () => {
  const { body, calls, stop } = setup({ usage: () => new Promise(() => {}) });
  assert.match(text(body), /Loading/);
  assert.doesNotMatch(text(body), /No usage recorded/);
  assert.deepEqual(calls.slice().sort(), [['2026-11-02', '2026-11-08'], ['2026-11-09', '2026-11-15']]);
  stop();
});

test('cards show Total via formatDuration, daily average, top app and the delta', async () => {
  const { body, stop } = setup({
    usage: (from) => ({ ok: true, days: from === '2026-11-09'
      ? [row('2026-11-09', 7200, { 'code.exe': 5400, 'a.exe': 1800 }), row('2026-11-10', 3600, { 'code.exe': 3600 })]
      : [row('2026-11-03', 5400)] }),
  });
  await tick();
  const t = text(body);
  assert.match(t, /Total/); assert.match(t, /3h 0m/);
  assert.match(t, /Daily average/); assert.match(t, /1h 0m/); // 10800 / 3 elapsed days
  assert.match(t, /Most-used app/); assert.match(t, /code\.exe/);
  assert.match(t, /\+100%/); assert.match(t, /last week/);
  stop();
});

test('switching period and the arrows request the right ranges', async () => {
  const { body, calls, stop } = setup();
  await tick();
  calls.length = 0;
  await btn(body, 'Month').click();
  assert.deepEqual(calls.slice().sort(), [['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-30']]);
  calls.length = 0;
  await findAll(body, (n) => n.getAttribute('aria-label') === 'Previous period')[0].click();
  assert.deepEqual(calls.slice().sort(), [['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-31']]);
  await btn(body, 'Day').click();
  calls.length = 0;
  await findAll(body, (n) => n.getAttribute('aria-label') === 'Next period')[0].click(); // already today: disabled, no call
  assert.equal(calls.length, 0);
  assert.equal(findAll(body, (n) => n.getAttribute('aria-label') === 'Next period')[0].disabled, true);
  await btn(body, 'Year').click();
  assert.ok(calls.some(([f, t]) => f === '2026-01-01' && t === '2026-12-31'));
  stop();
});

test('empty period', async () => {
  const { body, stop } = setup({ usage: () => ({ ok: true, days: [row('2026-11-09', 0, {})] }) });
  await tick();
  assert.match(text(body), /No usage recorded yet for this period/);
  assert.doesNotMatch(text(body), /Daily average/);
  stop();
});

test('tracking off with no data for the range shows the explanation and the sign-in hint', async () => {
  const { body, calls, stop } = setup({ helper: { kind: 'ok', status: { usage_tracking: false } }, usage: () => ({ ok: true, days: [] }) });
  await tick();
  assert.match(text(body), /Usage tracking is off/);
  assert.match(text(body), /Windows helper/);
  assert.match(text(body), /sign out and back in/);
  assert.doesNotMatch(text(body), /Total/);
  assert.equal(calls.length, 2);
  stop();
});

test('tracking off with history shows the data under a banner; the banner goes when tracking returns', async () => {
  const { body, controller, subs, stop } = setup({ helper: { kind: 'ok', status: { usage_tracking: false } }, usage: () => ({ ok: true, days: [row('2026-11-09', 3600)] }) });
  await tick();
  assert.match(text(body), /Not tracking right now\. Usage tracking runs from a small program that starts when you sign in\. If you just installed or updated the helper, sign out and back in\. History below is from earlier\./);
  assert.match(text(body), /Total/); assert.match(text(body), /1h 0m/);
  assert.doesNotMatch(text(body), /Usage tracking is off/);
  controller.state.helper = { kind: 'ok', status: { usage_tracking: true } };
  for (const fn of subs) fn();
  await tick();
  assert.doesNotMatch(text(body), /Not tracking right now/);
  assert.match(text(body), /Total/);
  stop();
});

test('old helper without usage_tracking still shows data', async () => {
  const { body, stop } = setup({ helper: { kind: 'ok', status: {} }, usage: () => ({ ok: true, days: [row('2026-11-09', 600)] }) });
  await tick();
  assert.match(text(body), /10m/);
  assert.doesNotMatch(text(body), /tracking is off|Not tracking right now/);
  stop();
});

test('helper down with none explains how to start it; with data shows the last data', async () => {
  let down = true;
  const { body, controller, stop } = setup({
    helper: { kind: 'not-running' },
    usage: () => (down ? { ok: false, down: true, message: 'not running' } : { ok: true, days: [row('2026-11-09', 600)] }),
  });
  await tick();
  assert.match(text(body), /helper isn't running/);
  assert.match(text(body), /MyBrainFocus/);
  assert.doesNotMatch(text(body), /Total/);
  down = false; controller.state.helper = { kind: 'ok', status: {} };
  await btn(body, 'Week').click();
  await tick();
  assert.match(text(body), /Total/);
  down = true;
  await btn(body, 'Week').click(); // refetch while down
  await tick();
  assert.match(text(body), /Showing the last data from .+\. The helper isn't running\./);
  assert.match(text(body), /Total/);
  stop();
});

test('fetch failure shows the message and Retry calls again', async () => {
  let fail = true;
  const { body, calls, stop } = setup({ usage: () => (fail ? { ok: false, down: false, message: 'range too large' } : { ok: true, days: [row('2026-11-09', 600)] }) });
  await tick();
  assert.match(text(body), /Couldn't load usage/);
  assert.match(text(body), /range too large/);
  assert.doesNotMatch(text(body), /No usage recorded/);
  calls.length = 0; fail = false;
  await btn(body, 'Retry').click();
  await tick();
  assert.equal(calls.length, 2);
  assert.match(text(body), /Total/);
  stop();
});

test('sites are labelled as estimates, shares are of identified sites, other browsing is separate', async () => {
  const { body, stop } = setup({ usage: (from) => ({ ok: true, days: from === '2026-11-09' ? [row('2026-11-09', 3600, { 'chrome.exe': 3600 }, { YouTube: 1800, Reddit: 600 }, 900)] : [] }) });
  await tick();
  const t = text(body);
  assert.match(t, /Estimated from browser tab titles/);
  assert.match(t, /of identified sites/);
  assert.match(t, /Other browsing/); assert.match(t, /15m/);
  assert.match(t, /YouTube/);
  stop();
});

test('Show as table swaps in tables of daily totals', async () => {
  const { body, stop } = setup({ usage: (from) => ({ ok: true, days: from === '2026-11-09' ? [row('2026-11-09', 3600)] : [] }) });
  await tick();
  assert.equal(findAll(body, (n) => n.tag === 'table').length, 0);
  await btn(body, 'Show as table').click();
  const tables = findAll(body, (n) => n.tag === 'table');
  assert.ok(tables.length >= 1);
  assert.match(tables[0].textContent, /2026-11-09/); assert.match(tables[0].textContent, /1h 0m/);
  assert.ok(btn(body, 'Show as chart'));
  stop();
});

test('year view wraps the heatmap in a scroll container', async () => {
  const { body, stop } = setup({ usage: () => ({ ok: true, days: [row('2026-11-09', 600)] }) });
  await tick();
  await btn(body, 'Year').click();
  await tick();
  const scroll = findAll(body, (n) => n.className.includes('fr-chart-scroll'))[0];
  assert.ok(scroll);
  assert.equal(scroll.children.length, 1);
  assert.match(String(scroll.children[0].getAttribute('class')), /fr-chart-heat/);
  stop();
});

test('an older, slower response never overwrites a newer one', async () => {
  const pending = [];
  const { body, stop } = setup({ usage: (from) => new Promise((res) => pending.push({ from, res })) });
  const week = pending.splice(0); // initial week requests
  await btn(body, 'Day').click();
  const day = pending.splice(0);
  const answer = (list, from, days) => list.find((p) => p.from === from).res({ ok: true, days });
  answer(day, '2026-11-11', [row('2026-11-11', 600, { 'new.exe': 600 })]);
  answer(day, '2026-11-10', []);
  await tick();
  answer(week, '2026-11-09', [row('2026-11-09', 7200, { 'old.exe': 7200 })]);
  answer(week, '2026-11-02', []);
  await tick();
  assert.match(text(body), /new\.exe/);
  assert.doesNotMatch(text(body), /old\.exe/);
  stop();
});

test('cleanup clears timers, stops updates and empties the root', async () => {
  const started = []; const cleared = [];
  const si = globalThis.setInterval; const ci = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => { started.push(fn); return started.length; };
  globalThis.clearInterval = (id) => { cleared.push(id); };
  try {
    let release;
    const { body, subs, stop } = setup({ usage: () => new Promise((res) => { release = res; }) });
    assert.ok(started.length >= 1);
    stop();
    assert.deepEqual(cleared.sort(), started.map((_, i) => i + 1));
    assert.equal(subs.size, 0);
    release({ ok: true, days: [row('2026-11-09', 600)] });
    await tick();
    assert.equal(body.children.length, 0);
  } finally { globalThis.setInterval = si; globalThis.clearInterval = ci; }
});

test('back button calls onBack', async () => {
  let back = 0;
  const { body, stop } = setup({ deps: { onBack: () => { back++; } } });
  await btn(body, '← Back').click();
  assert.equal(back, 1);
  stop();
});

test('delta card text for down, same and none', async () => {
  const mk = (cur, prev) => setup({ usage: (from) => ({ ok: true, days: from === '2026-11-09' ? [row('2026-11-09', cur)] : prev ? [row('2026-11-03', prev)] : [] }) });
  let t = mk(1800, 3600); await tick();
  assert.match(text(t.body), /−50%/); assert.match(text(t.body), /Less than last week/); t.stop();
  t = mk(3600, 3600); await tick();
  assert.match(text(t.body), /No change/); t.stop();
  t = mk(3600, 0); await tick();
  assert.match(text(t.body), /Nothing recorded last week/); t.stop();
});

test('bad-request shows a friendly update message without Retry', async () => {
  const { body, stop } = setup({ usage: () => ({ ok: false, down: false, code: 'bad-request', message: 'unknown variant `GetUsage`' }) });
  await tick();
  assert.match(text(body), /doesn't report usage yet\. Update the helper\./);
  assert.doesNotMatch(text(body), /unknown variant/);
  assert.equal(btn(body, 'Retry'), undefined);
  stop();
});

test('browser build says usage is desktop-app only', async () => {
  const { body, stop } = setup({ helper: { kind: 'unavailable' }, usage: () => ({ ok: false, down: true, unavailable: true, message: 'x' }) });
  await tick();
  assert.match(text(body), /Usage is only available in the desktop app\./);
  assert.doesNotMatch(text(body), /MyBrainFocus/);
  stop();
});

test('Retry shows loading, ignores clicks in flight, and a failed retry returns to the error state', async () => {
  let n = 0; const waiting = [];
  const { body, calls, stop } = setup({ usage: () => { n++; return n <= 2 ? { ok: false, down: false, message: 'boom' } : new Promise((res) => waiting.push(res)); } });
  await tick();
  assert.match(text(body), /boom/);
  calls.length = 0;
  const retry = btn(body, 'Retry');
  await retry.click();
  assert.match(text(body), /Loading/);
  await retry.click(); // stale button, request in flight
  assert.equal(calls.length, 2);
  assert.equal(btn(body, 'Retry'), undefined);
  for (const r of waiting) r({ ok: false, down: false, message: 'boom again' });
  await tick();
  assert.match(text(body), /boom again/);
  assert.ok(btn(body, 'Retry'));
  stop();
});

test('previous-range failure on refresh keeps the cached previous days', async () => {
  let failPrev = false;
  const { body, stop } = setup({ usage: (from) => (from === '2026-11-09' ? { ok: true, days: [row('2026-11-09', 3600)] } : failPrev ? { ok: false, message: 'x' } : { ok: true, days: [row('2026-11-03', 1800)] }) });
  await tick();
  assert.match(text(body), /\+100%/);
  failPrev = true;
  await btn(body, 'Week').click();
  await tick();
  assert.match(text(body), /\+100%/);
  assert.doesNotMatch(text(body), /could not be loaded/);
  stop();
});

test('the stats view refreshes helper status every 5 s and clears that timer on cleanup', async () => {
  const fns = new Map(); const cleared = [];
  const si = globalThis.setInterval; const ci = globalThis.clearInterval;
  let id = 0;
  globalThis.setInterval = (fn, ms) => { id++; fns.set(id, [fn, ms]); return id; };
  globalThis.clearInterval = (i) => { cleared.push(i); };
  try {
    let refreshed = 0;
    const { controller, stop } = setup();
    controller.refreshStatus = async () => { refreshed++; };
    const five = [...fns.values()].find(([, ms]) => ms === 5000);
    assert.ok(five);
    five[0]();
    assert.equal(refreshed, 1);
    stop();
    assert.equal(cleared.length, fns.size);
  } finally { globalThis.setInterval = si; globalThis.clearInterval = ci; }
});

test('module render switches home <-> stats and Back restores home', async () => {
  const body = installDom(undefined);
  await import('../src/modules/focus/index.js');
  const { getModule } = await import('../src/shell/modules.js');
  const stop = getModule('focus').render(body, { db: {} });
  try {
    assert.match(text(body), /Focus Room/);
    await btn(body, 'Stats').click();
    assert.ok(btn(body, '← Back'));
    assert.equal(btn(body, 'Stats'), undefined);
    await btn(body, '← Back').click();
    assert.ok(btn(body, 'Stats'));
    assert.equal(btn(body, '← Back'), undefined);
  } finally { stop(); }
});

// ---- Today view ----
const D = Date.UTC(2026, 10, 11) / 1000; // local midnight with tz 0
const st = (a, b, exe = 'code.exe', site = null) => ({ start: D + a, end: D + b, exe, site });
function setupToday({ sessions, usage, helper, deps = {} } = {}) {
  const sessionCalls = [];
  const r = setup({
    helper, deps,
    usage: usage || ((from, to) => ({ ok: true, days: from === to ? [row(from, 3600)] : [row('2026-11-10', 100), row('2026-11-11', 3600)] })),
  });
  r.controller.getSessions = async (day) => { sessionCalls.push(day); return sessions ? sessions(day, sessionCalls.length) : { ok: true, day, truncated: false, stretches: [st(3600, 7200), st(7300, 8000, 'chrome.exe')] }; };
  r.sessionCalls = sessionCalls;
  return r;
}
const todayBtn = (body) => findAll(body, (n) => n.getAttribute('data-fk') === 'p-today')[0];
const fk = (body, k) => findAll(body, (n) => n.getAttribute('data-fk') === k)[0];
async function openToday(opts) { const r = setupToday(opts); await tick(); await todayBtn(r.body).click(); await tick(); return r; }

test('Today renders the strip, cards, streaks and requests today', async () => {
  const { body, sessionCalls, stop } = await openToday();
  assert.equal(sessionCalls.at(-1), '2026-11-11');
  assert.ok(findAll(body, (n) => n.tag === 'svg').length >= 1);
  const t = text(body);
  assert.match(t, /Longest stretch/); assert.match(t, /1h 00m 00s/); assert.match(t, /Code/);
  assert.match(t, /Switches per active hour/); assert.match(t, /First activity/); assert.match(t, /01:00:00/); assert.match(t, /Last activity/); assert.match(t, /02:13:20/);
  assert.match(t, /Current streak/); assert.match(t, /2 days/); assert.match(t, /Best streak/);
  assert.match(t, /00:00:00 to 24:00:00/);
  assert.doesNotMatch(t, /NaN|Infinity|undefined/);
  stop();
});

test('zoom buttons change the window label and pan shows for sub-day zooms', async () => {
  const { body, stop } = await openToday();
  assert.equal(fk(body, 'pan'), undefined);
  await fk(body, 'zoom-6h').click();
  assert.ok(fk(body, 'pan'));
  const lab6 = fk(body, 'window').textContent;
  assert.match(lab6, /^\d\d:\d\d:\d\d to \d\d:\d\d:\d\d$/);
  await fk(body, 'zoom-10m').click();
  const lab10 = fk(body, 'window').textContent;
  assert.notEqual(lab10, lab6);
  const pan = fk(body, 'pan');
  pan.value = '3600';
  for (const fn of pan.listeners.input) fn({ target: pan });
  assert.equal(fk(body, 'window').textContent, '01:00:00 to 01:10:00');
  await fk(body, 'zoom-1h').click();
  assert.match(fk(body, 'window').textContent, /to/);
  stop();
});

test('previous day requests the previous day; next is disabled on today', async () => {
  const { body, sessionCalls, stop } = await openToday();
  assert.equal(fk(body, 'next').disabled, true);
  await fk(body, 'prev').click(); await tick();
  assert.equal(sessionCalls.at(-1), '2026-11-10');
  assert.equal(fk(body, 'next').disabled, false);
  stop();
});

test('DST day window is 23 hours long', async () => {
  const X = D + 3600 * 5; // offset +0 before X (on 2026-11-11), +60 after... spring forward at 05:00 UTC
  const tz = (ms) => (ms / 1000 >= X ? 60 : 0);
  const { body, stop } = await openToday({ deps: { tzOffsetAt: tz }, sessions: () => ({ ok: true, truncated: false, stretches: [st(10 * 3600, 11 * 3600)] }) });
  const t = fk(body, 'window').textContent;
  assert.equal(t, '00:00:00 to 24:00:00');
  await fk(body, 'zoom-day').click();
  // the day is 23 h: sliding a 6 h window to the end reaches 24:00 exactly
  await fk(body, 'zoom-6h').click();
  const pan = fk(body, 'pan');
  assert.equal(pan.getAttribute('max'), String(17 * 3600));
  stop();
});

test('newest request wins when responses arrive out of order', async () => {
  const pending = [];
  const { body, stop } = setupToday({ sessions: (day) => new Promise((res) => pending.push({ day, res })) });
  await tick();
  await todayBtn(body).click();
  await fk(body, 'prev').click();
  const old = pending.find((p) => p.day === '2026-11-11');
  const neu = pending.find((p) => p.day === '2026-11-10');
  neu.res({ ok: true, day: '2026-11-10', truncated: false, stretches: [{ start: D - 86400 + 100, end: D - 86400 + 4000, exe: 'new.exe', site: null }] });
  await tick();
  old.res({ ok: true, day: '2026-11-11', truncated: false, stretches: [st(100, 4000, 'old.exe')] });
  await tick();
  assert.match(text(body), /New/); assert.doesNotMatch(text(body), /Old/);
  stop();
});

test('totals without stretches say detail is not available', async () => {
  const { body, stop } = await openToday({ sessions: () => ({ ok: true, truncated: false, stretches: [] }) });
  assert.match(text(body), /Detailed timeline not available for this day; daily totals only/);
  stop();
});

test('no usage at all shows the empty note', async () => {
  const { body, stop } = await openToday({ sessions: () => ({ ok: true, truncated: false, stretches: [] }), usage: () => ({ ok: true, days: [] }) });
  assert.match(text(body), /No usage recorded yet/);
  stop();
});

test('truncated shows the notice with the returned count', async () => {
  const { body, stop } = await openToday({ sessions: () => ({ ok: true, truncated: true, stretches: [st(10, 20), st(30, 40), st(50, 60)] }) });
  assert.match(text(body), /Timeline incomplete after 3 stretches; totals are complete/);
  stop();
});

test('helper down shows a notice and keeps the last data', async () => {
  let down = false;
  const { body, stop } = await openToday({ sessions: () => (down ? { ok: false, down: true, message: 'x' } : { ok: true, truncated: false, stretches: [st(10, 600)] }) });
  assert.match(text(body), /Longest stretch/);
  down = true;
  await todayBtn(body).click(); await tick();
  assert.match(text(body), /Showing the last data from .+\. The helper isn't running\./);
  assert.match(text(body), /Longest stretch/);
  stop();
});

test('helper down with nothing cached explains it; tracking off explains it', async () => {
  let r = await openToday({ sessions: () => ({ ok: false, down: true, message: 'x' }), helper: { kind: 'not-running' } });
  assert.match(text(r.body), /helper isn't running/); r.stop();
  r = await openToday({ sessions: () => ({ ok: true, truncated: false, stretches: [] }), usage: () => ({ ok: true, days: [] }), helper: { kind: 'ok', status: { usage_tracking: false } } });
  assert.match(text(r.body), /Usage tracking is off/); r.stop();
});

test('Show as table renders stretches, capped at 500 rows with a note', async () => {
  const many = Array.from({ length: 600 }, (_, i) => st(i * 100, i * 100 + 50));
  const { body, stop } = await openToday({ sessions: () => ({ ok: true, truncated: false, stretches: many }) });
  await btn(body, 'Show as table').click();
  const tables = findAll(body, (n) => n.tag === 'table');
  assert.equal(tables.length, 1);
  assert.equal(findAll(tables[0], (n) => n.tag === 'tr').length, 501);
  assert.match(text(body), /Showing first 500 of 600 stretches/);
  assert.doesNotMatch(text(body), /NaN|Infinity/);
  stop();
});

// ---- hour-of-day charts and averages ----
const hrs = (m) => { const a = new Array(24).fill(0); for (const [k, v] of Object.entries(m)) a[k] = v; return a; };
const hrow = (day, total, hours) => ({ ...row(day, total), ...(hours ? { hours } : {}) });
const hasChart = (body, cls) => findAll(body, (n) => (n.getAttribute('class') || '').includes(cls)).length > 0;

test('hour bars and heatmap show with the day count caption', async () => {
  const { body, stop } = setup({ usage: (from) => ({ ok: true, days: from === '2026-11-09'
    ? [hrow('2026-11-09', 3600, hrs({ 9: 3600 })), hrow('2026-11-10', 1800, hrs({ 10: 1800 }))] : [] }) });
  await tick();
  assert.match(text(body), /Hours of the day/);
  assert.match(text(body), /Based on 2 days with hour data/);
  assert.match(text(body), /2 of 3 days/);
  assert.ok(hasChart(body, 'fr-chart-hours'));
  assert.ok(hasChart(body, 'fr-chart-weekhour'));
  assert.doesNotMatch(text(body), /NaN/);
  stop();
});

test('singular caption for one day', async () => {
  const { body, stop } = setup({ usage: (from) => ({ ok: true, days: from === '2026-11-09' ? [hrow('2026-11-09', 3600, hrs({ 9: 3600 }))] : [] }) });
  await tick();
  assert.match(text(body), /Based on 1 day with hour data/);
  stop();
});

test('days without hours show the placeholder and no hour chart', async () => {
  const { body, stop } = setup({ usage: (from) => ({ ok: true, days: from === '2026-11-09' ? [hrow('2026-11-09', 3600), hrow('2026-11-10', 600)] : [] }) });
  await tick();
  assert.match(text(body), /Hour detail is recorded from the update onwards/);
  assert.equal(hasChart(body, 'fr-chart-hours'), false);
  assert.equal(hasChart(body, 'fr-chart-weekhour'), false);
  stop();
});

test('Day period shows only the hour bars', async () => {
  const { body, stop } = setup({ usage: () => ({ ok: true, days: [hrow('2026-11-11', 3600, hrs({ 9: 3600 }))] }) });
  await tick();
  await btn(body, 'Day').click();
  assert.match(text(body), /Based on 1 day with hour data/);
  assert.ok(hasChart(body, 'fr-chart-hours'));
  assert.equal(hasChart(body, 'fr-chart-weekhour'), false);
  stop();
});

test('averages: exact per-day value, dash for week and month on short ranges, no NaN', async () => {
  const { body, stop } = setup({ usage: (from) => ({ ok: true, days: from === '2026-11-09' ? [row('2026-11-09', 7200, { 'code.exe': 7200 }), row('2026-11-10', 3600, { 'code.exe': 3600 })] : [] }) });
  await tick();
  const t = text(body);
  assert.match(t, /Averages/);
  const rowsOf = (k) => findAll(body, (n) => n.getAttribute('data-fk') === k)[0];
  assert.equal(rowsOf('avg-day').textContent, 'Per day1h 0m'); // 10800 / 3 elapsed days
  assert.equal(rowsOf('avg-week').textContent, 'Per week—needs 7 days');
  assert.equal(rowsOf('avg-month').textContent, 'Per month—needs 28 days');
  assert.match(t, /Code\.exe|code\.exe/);
  assert.equal(rowsOf('avg-app-code.exe').children[1].textContent, '1h 30m');
  // 2026-11-09 is a Monday: its 7200 s is the Monday average; Tuesday gets the other 3600 s
  assert.equal(rowsOf('avg-wd-Mon').textContent, 'Mon2h 0m');
  assert.equal(rowsOf('avg-wd-Tue').textContent, 'Tue1h 0m');
  assert.equal(rowsOf('avg-wd-Wed').textContent, 'Wed0m');
  assert.doesNotMatch(t, /NaN/);
  stop();
});

test('averages and hours render as tables when Show as table is on', async () => {
  const { body, stop } = setup({ usage: (from) => ({ ok: true, days: from === '2026-11-09' ? [hrow('2026-11-09', 3600, hrs({ 9: 3600 }))] : [] }) });
  await tick();
  await btn(body, 'Show as table').click();
  const tables = findAll(body, (n) => n.tag === 'table');
  const hourT = tables.find((tb) => /Hours of the day/.test(tb.textContent));
  assert.ok(hourT);
  assert.equal(findAll(hourT, (n) => n.tag === 'tr').length, 25);
  const hourRows = findAll(hourT, (n) => n.tag === 'tr');
  assert.equal(hourRows[10].textContent, '09:00' + '1h 0m'); // row 0 is the header, so 09:00 is row 10
  assert.equal(hourRows[11].textContent, '10:00' + '0m');
  assert.ok(tables.some((tb) => /Averages/.test(tb.textContent)));
  assert.equal(hasChart(body, 'fr-chart-hours'), false);
  assert.doesNotMatch(text(body), /NaN/);
  stop();
});

test('empty range and Today view have no hour or averages sections', async () => {
  const { body, stop } = setup({ usage: () => ({ ok: true, days: [] }) });
  await tick();
  assert.match(text(body), /No usage recorded/);
  assert.doesNotMatch(text(body), /Hours of the day|Averages|NaN/);
  stop();
});

// ---- drill-down ----
const DD = Date.UTC(2026, 10, 10) / 1000; // 2026-11-10 midnight
const dst = (day, a, b, exe = 'code.exe', site = null) => { const base = Date.parse(`${day}T00:00:00Z`) / 1000; return { start: base + a, end: base + b, exe, site }; };
const weekUsage = (from) => ({ ok: true, days: from === '2026-11-09'
  ? [row('2026-11-09', 7200, { 'code.exe': 5400, 'a.exe': 1800 }), row('2026-11-10', 3600, { 'code.exe': 3600 })]
  : [] });
function setupDrill({ usage = weekUsage, sessions, helper, deps } = {}) {
  const sessionCalls = [];
  const r = setup({ usage, helper, deps });
  r.controller.getSessions = async (day) => {
    sessionCalls.push(day);
    return sessions ? sessions(day, sessionCalls.length)
      : { ok: true, day, truncated: false, stretches: [dst(day, 3600, 7200), dst(day, 8000, 9000, 'a.exe')] };
  };
  r.sessionCalls = sessionCalls;
  return r;
}
async function openApp(opts, name = 'code.exe', kind = 'app') { const r = setupDrill(opts); await tick(); await fk(r.body, `${kind}-${name}`).click(); await tick(); return r; }
const stripLabel = (body) => findAll(body, (n) => n.tag === 'svg' && (n.getAttribute('class') || '').includes('fr-chart-timeline'))[0].getAttribute('aria-label');

test('clicking a ranked app opens the drill-down with exact total, active days, average and share', async () => {
  const { body, sessionCalls } = await openApp();
  assert.ok(fk(body, 'drill-back'));
  assert.equal(fk(body, 'p-week'), undefined); // the period bar belongs to the main view
  const cards = findAll(body, (n) => n.className === 'fr-statcard').map((n) => n.textContent);
  assert.ok(cards.includes('Total2h 30m'), cards.join('|'));
  assert.ok(cards.includes('Active days2'), cards.join('|'));
  assert.ok(cards.includes('Average per active day1h 15m'), cards.join('|')); // 9000 / 2
  assert.ok(cards.includes('Share of total83%'), cards.join('|')); // 9000 / 10800
  assert.ok(cards.some((c) => c === 'Peak hour on 2026-11-10' + '01:00'), cards.join('|'));
  assert.ok(findAll(body, (n) => (n.getAttribute('class') || '').includes('fr-chart-trend')).length >= 1);
  assert.equal(sessionCalls.at(-1), '2026-11-10'); // latest day with usage
  assert.doesNotMatch(text(body), /NaN|Infinity|undefined/);
});

test('the same rows open from the average-per-active-day list', async () => {
  const r = setupDrill(); await tick();
  const inAvg = findAll(r.body, (n) => n.getAttribute('data-fk') === 'avg-app-code.exe')[0];
  const b = findAll(inAvg, (n) => n.tag === 'button')[0];
  assert.equal(b.getAttribute('data-fk'), 'avgapp-code.exe');
  await b.click(); await tick();
  assert.ok(fk(r.body, 'drill-back'));
  await fk(r.body, 'drill-back').click();
  assert.equal(globalThis.document.activeElement.getAttribute('data-fk'), 'avgapp-code.exe'); // focus returns to the opener
});

test('Back returns to the main view with period and table state intact', async () => {
  const r = setupDrill(); await tick();
  await btn(r.body, 'Show as table').click();
  await fk(r.body, 'app-code.exe').click(); await tick();
  assert.equal(fk(r.body, 'p-week'), undefined);
  await fk(r.body, 'drill-back').click();
  assert.equal(fk(r.body, 'drill-back'), undefined);
  assert.equal(fk(r.body, 'p-week').getAttribute('aria-pressed'), 'true');
  assert.ok(btn(r.body, 'Show as chart'));
  assert.match(text(r.body), /Week|Nov 9/);
});

test('the timeline shows only the opened app', async () => {
  const { body } = await openApp();
  const label = stripLabel(body);
  assert.match(label, /1 block, 1h 00m 00s in total/); // code.exe only; a.exe's 1000 s is left out
  assert.match(text(body), /Code/);
  assert.doesNotMatch(text(body), /No time recorded/);
});

test('a day with no stretches for the item says so', async () => {
  const { body } = await openApp({ sessions: (day) => ({ ok: true, day, truncated: false, stretches: [dst(day, 100, 400, 'other.exe')] }) });
  assert.match(text(body), /No time recorded for code\.exe on this day\./);
  assert.ok(findAll(body, (n) => n.tag === 'svg' && (n.getAttribute('class') || '').includes('fr-chart-timeline')).length === 0);
  assert.ok(findAll(body, (n) => n.className === 'fr-statcard' && n.textContent === 'Peak hour on 2026-11-10—').length === 1);
});

test('day navigation requests the previous day and next is disabled on today', async () => {
  const { body, sessionCalls } = await openApp();
  assert.equal(fk(body, 'drill-next').disabled, false); // on the 10th, today is the 11th
  await fk(body, 'drill-prev').click(); await tick();
  assert.equal(sessionCalls.at(-1), '2026-11-09');
  await fk(body, 'drill-next').click(); await fk(body, 'drill-next').click(); await tick();
  assert.equal(sessionCalls.at(-1), '2026-11-11');
  assert.equal(fk(body, 'drill-next').disabled, true);
});

test('a day older than 90 days shows the not-kept message and never calls getSessions', async () => {
  const r = setupDrill({ usage: () => ({ ok: true, days: [row('2026-01-05', 1200, { 'code.exe': 1200 })] }) });
  await tick();
  await btn(r.body, 'Year').click(); await tick();
  await fk(r.body, 'app-code.exe').click(); await tick();
  assert.match(text(r.body), /Detailed timeline is kept for 90 days\./);
  assert.equal(r.sessionCalls.length, 0);
  const cards = findAll(r.body, (n) => n.className === 'fr-statcard').map((n) => n.textContent);
  assert.ok(cards.includes('Total20m'));
  assert.ok(cards.includes('Peak hour on 2026-01-05—'));
  // stepping forward from there into the kept window starts loading again
  for (let i = 0; i < 400 && !r.sessionCalls.length; i++) await fk(r.body, 'drill-next').click();
  assert.ok(r.sessionCalls.length >= 1);
  assert.ok(r.sessionCalls[0] >= '2026-08-13', r.sessionCalls[0]);
});

const browserUsage = (from) => ({ ok: true, days: from === '2026-11-09'
  ? [row('2026-11-09', 3600, { 'chrome.exe': 3600 }, { YouTube: 1800, Reddit: 600 })] : [] });
const browserSessions = (day) => ({ ok: true, day, truncated: false, stretches: [dst(day, 0, 1800, 'chrome.exe', 'YouTube'), dst(day, 2000, 2600, 'chrome.exe', 'Reddit')] });

test('a site drill-down filters the timeline by site and omits the sites-used list', async () => {
  const { body } = await openApp({ usage: browserUsage, sessions: browserSessions }, 'YouTube', 'site');
  assert.match(stripLabel(body), /1 block, 30m 00s in total/);
  assert.doesNotMatch(text(body), /Sites used/);
  const cards = findAll(body, (n) => n.className === 'fr-statcard').map((n) => n.textContent);
  assert.ok(cards.includes('Total30m'));
  assert.ok(cards.includes('Share of total50%of all usage')); // 1800 of 3600
});

test('a browser drill-down lists the sites used inside it', async () => {
  const { body } = await openApp({ usage: browserUsage, sessions: browserSessions }, 'chrome.exe');
  assert.match(text(body), /Sites used/);
  const list = findAll(body, (n) => n.getAttribute('data-fk') === 'drill-sites')[0];
  assert.match(list.textContent, /YouTube/); assert.match(list.textContent, /30m/);
  assert.match(list.textContent, /Reddit/); assert.match(list.textContent, /10m/);
  assert.doesNotMatch(text(body), /approximate/);
});

test('several browsers mark the sites list approximate', async () => {
  const usage = (from) => ({ ok: true, days: from === '2026-11-09' ? [row('2026-11-09', 4000, { 'chrome.exe': 3000, 'msedge.exe': 1000 }, { YouTube: 1800 })] : [] });
  const { body } = await openApp({ usage, sessions: browserSessions }, 'chrome.exe');
  assert.match(text(body), /approximate: several browsers used/);
});

test('a plain app has no sites-used list', async () => {
  const { body } = await openApp();
  assert.doesNotMatch(text(body), /Sites used/);
});

test('a stale session response is ignored', async () => {
  const pending = [];
  const r = setupDrill({ sessions: (day) => new Promise((res) => pending.push({ day, res })) });
  await tick();
  await fk(r.body, 'app-code.exe').click();
  await fk(r.body, 'drill-prev').click();
  const a = pending.find((p) => p.day === '2026-11-10');
  const b = pending.find((p) => p.day === '2026-11-09');
  b.res({ ok: true, day: b.day, truncated: false, stretches: [dst(b.day, 100, 400)] });
  await tick();
  a.res({ ok: true, day: a.day, truncated: false, stretches: [dst(a.day, 3600, 7200)] });
  await tick();
  assert.match(stripLabel(r.body), /5m 00s in total/);
  assert.doesNotMatch(stripLabel(r.body), /1h 00m 00s/);
});

test('cleanup while a day is loading leaves the DOM alone', async () => {
  let release;
  const r = setupDrill({ sessions: (day) => new Promise((res) => { release = () => res({ ok: true, day, truncated: false, stretches: [dst(day, 1, 60)] }); }) });
  await tick();
  await fk(r.body, 'app-code.exe').click();
  r.stop();
  release(); await tick();
  assert.equal(r.body.children.length, 0);
});

test('helper down keeps the last loaded day with a notice and says so when nothing is loaded', async () => {
  let down = false;
  const r = await openApp({ sessions: (day) => (down ? { ok: false, down: true, message: 'x' } : { ok: true, day, truncated: false, stretches: [dst(day, 3600, 7200)] }) });
  assert.match(stripLabel(r.body), /1h 00m 00s/);
  down = true;
  await fk(r.body, 'drill-prev').click(); await tick();
  assert.match(text(r.body), /helper isn't running/);
  await fk(r.body, 'drill-next').click(); await tick();
  assert.match(text(r.body), /Showing the last data from .+\. The helper isn't running\./);
  assert.match(stripLabel(r.body), /1h 00m 00s/);
});

test('a failed session load shows the message', async () => {
  const { body } = await openApp({ sessions: () => ({ ok: false, down: false, message: 'bad day' }) });
  assert.match(text(body), /bad day/);
  assert.ok(fk(body, 'drill-back'));
});

test('the peak-hour card names the day shown and follows day navigation', async () => {
  const { body } = await openApp();
  const peak = () => findAll(body, (n) => n.className === 'fr-statcard' && n.textContent.startsWith('Peak hour')).map((n) => n.textContent);
  assert.deepEqual(peak(), ['Peak hour on 2026-11-10' + '01:00']);
  await fk(body, 'drill-prev').click(); await tick();
  assert.deepEqual(peak(), ['Peak hour on 2026-11-09' + '01:00']);
});

test('the 90-day boundary: today-89 is kept, today-90 is not', async () => {
  // today is 2026-11-11: today-89 = 2026-08-14, today-90 = 2026-08-13
  const usage = () => ({ ok: true, days: [row('2026-08-14', 600, { 'code.exe': 600 })] });
  const r = setupDrill({ usage }); await tick();
  await btn(r.body, 'Year').click(); await tick();
  await fk(r.body, 'app-code.exe').click(); await tick();
  assert.deepEqual(r.sessionCalls, ['2026-08-14']);
  assert.doesNotMatch(text(r.body), /kept for 90 days/);
  await fk(r.body, 'drill-prev').click(); await tick();
  assert.deepEqual(r.sessionCalls, ['2026-08-14']); // 2026-08-13 loads nothing
  assert.match(text(r.body), /Detailed timeline is kept for 90 days\./);
});

// ---- fix wave: honest notes ----

test('Today: failed totals with no stretches say totals are unavailable, not "no usage"', async () => {
  const { body, stop } = await openToday({ sessions: () => ({ ok: true, truncated: false, stretches: [] }), usage: () => ({ ok: false, down: false, message: 'boom' }) });
  assert.match(text(body), /Totals unavailable/);
  assert.doesNotMatch(text(body), /No usage recorded/);
  stop();
});

test('Today: Active time prefers the usage total when it exceeds the stretch sum', async () => {
  const { body, stop } = await openToday({ usage: (from, to) => ({ ok: true, days: from === to ? [row(from, 9000)] : [row('2026-11-11', 9000)] }) });
  const cards = findAll(body, (n) => n.className === 'fr-statcard').map((n) => n.textContent);
  assert.ok(cards.some((c) => c.startsWith('Active time') && /2h 30m/.test(c)), cards.join('|'));
  stop();
});

test('drill-down: a day without any stretches says the timeline is not available', async () => {
  const { body } = await openApp({ sessions: (day) => ({ ok: true, day, truncated: false, stretches: [] }) });
  assert.match(text(body), /Detailed timeline not available for this day; daily totals only\./);
  assert.doesNotMatch(text(body), /No time recorded for/);
});

test('drill-down: a day with stretches but none for this item says no time was recorded', async () => {
  const { body } = await openApp({ sessions: (day) => ({ ok: true, day, truncated: false, stretches: [dst(day, 100, 500, 'a.exe')] }) });
  assert.match(text(body), /No time recorded for code\.exe on this day\./);
  assert.doesNotMatch(text(body), /Detailed timeline not available/);
});
