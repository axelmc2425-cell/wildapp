import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, findAll } from './helpers/fake-dom.js';
import { mountStatsPage } from '../src/modules/focus/ui/stats-page.js';

const NOW = Date.UTC(2026, 10, 11, 12, 0); // Wed 2026-11-11
const tick = () => new Promise((r) => setImmediate(r));
const text = (root) => root.textContent;
const btn = (root, t) => findAll(root, (n) => n.tag === 'button' && n.textContent === t)[0];
const row = (day, total, apps = { 'a.exe': total }, sites = {}, other = 0) => ({ day, total, apps, sites, other_browsing: other });

function setup({ usage, helper = { kind: 'ok', status: { usage_tracking: true } }, deps = {} } = {}) {
  const body = installDom(undefined);
  const calls = [];
  const controller = {
    state: { helper },
    async getUsage(from, to) { calls.push([from, to]); return usage ? usage(from, to, calls.length) : { ok: true, days: [] }; },
  };
  const subs = new Set();
  const stop = mountStatsPage(body, controller, { onBack() {}, now: () => NOW, tzOffsetAt: () => 0, subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); }, ...deps });
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
