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

test('tracking off', async () => {
  const { body, calls, stop } = setup({ helper: { kind: 'ok', status: { usage_tracking: false } } });
  await tick();
  assert.match(text(body), /Usage tracking is off/);
  assert.match(text(body), /Windows helper/);
  assert.equal(calls.length, 0);
  stop();
});

test('old helper without usage_tracking still shows data', async () => {
  const { body, stop } = setup({ helper: { kind: 'ok', status: {} }, usage: () => ({ ok: true, days: [row('2026-11-09', 600)] }) });
  await tick();
  assert.match(text(body), /10m/);
  assert.doesNotMatch(text(body), /tracking is off/);
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
  assert.ok(findAll(scroll, (n) => n.className && String(n.className).includes('fr-chart-heat')).length >= 1 || scroll.children.length === 1);
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
