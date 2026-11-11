import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, findAll, walk } from './helpers/fake-dom.js';
import {
  chartColor, niceMax, scale, heatLevel, heatGrid, stackSegments, stackedDailyBars,
  rankedBars, weekdayBars, topAppNames, chartLegend, yearHeatmap, dataTable,
} from '../src/modules/focus/ui/charts.js';

installDom();

const cls = (el) => el.getAttribute('class') || el.className || '';
const withClass = (root, c) => findAll(root, n => cls(n).split(' ').includes(c));
const byTag = (root, tag) => findAll(root, n => n.tag === tag);

function assertClean(root) {
  walk(root, (n) => {
    for (const [k, v] of Object.entries(n.attrs)) assert.doesNotMatch(v, /NaN|undefined|Infinity/, `${n.tag}@${k}=${v}`);
  });
  assert.doesNotMatch(root.textContent, /NaN|undefined|Infinity/);
}

const day = (d, total, apps = {}) => ({ day: d, total, apps, sites: {} });
const week = [
  day('2026-11-02', 3600, { Code: 2400, Slack: 600, Chrome: 600 }),
  day('2026-11-03', 0),
  day('2026-11-04', 7200, { Code: 3000, A: 900, B: 800, C: 700, D: 600, E: 500, F: 400, G: 300 }),
  day('2026-11-05', 1800, { Chrome: 1800 }),
  day('2026-11-06', 900),
  day('2026-11-07', 0),
  day('2026-11-08', 60, { Code: 60 }),
];

test('chartColor returns css variables 0..5 and clamps', () => {
  assert.equal(chartColor(0), 'var(--chart-0)');
  assert.equal(chartColor(5), 'var(--chart-5)');
  assert.equal(chartColor(9), 'var(--chart-5)');
  assert.equal(chartColor(-1), 'var(--chart-0)');
  assert.equal(chartColor(NaN), 'var(--chart-0)');
});

test('pure helpers stay finite', () => {
  assert.equal(scale(5, 10, 100), 50);
  assert.equal(scale(5, 0, 100), 0);
  assert.equal(scale(NaN, 10, 100), 0);
  assert.equal(scale(50, 10, 100), 100);
  for (const v of [0, -1, NaN, Infinity, null, undefined, 1, 59, 3601, 90000]) {
    const m = niceMax(v);
    assert.ok(Number.isFinite(m) && m > 0, String(v));
    if (Number.isFinite(v) && v > 0) assert.ok(m >= v);
  }
  assert.equal(heatLevel(0, 100), 0);
  assert.equal(heatLevel(10, 0), 0);
  assert.equal(heatLevel(1, 100), 1);
  assert.equal(heatLevel(40, 100), 2);
  assert.equal(heatLevel(60, 100), 3);
  assert.equal(heatLevel(100, 100), 4);
});

test('heatGrid is Monday first and covers the year only', () => {
  const g = heatGrid(2026); // 2026-01-01 is a Thursday
  assert.equal(g.length, 365);
  assert.deepEqual([g[0].day, g[0].col, g[0].row], ['2026-01-01', 0, 3]);
  assert.deepEqual([g[4].day, g[4].col, g[4].row], ['2026-01-05', 1, 0]);
  assert.equal(heatGrid(2024).length, 366);
  assert.ok(Math.max(...heatGrid(2026).map(c => c.col)) <= 53);
});

test('stackSegments puts the rest into other', () => {
  const segs = stackSegments(week[2], ['Code', 'A', 'B', 'C', 'D']);
  assert.deepEqual(segs.map(s => s.key), ['Code', 'A', 'B', 'C', 'D', 'other']);
  assert.equal(segs.at(-1).secs, 7200 - 3000 - 900 - 800 - 700 - 600);
  assert.deepEqual(stackSegments(week[1], ['Code']), []);
  // day total larger than attributed app time: remainder is other
  assert.deepEqual(stackSegments(week[4], ['Code']).map(s => [s.key, s.secs]), [['other', 900]]);
});

test('stackedDailyBars draws one group per day', () => {
  const svg = stackedDailyBars(week, { topN: 5 });
  assert.equal(svg.tag, 'svg');
  assert.equal(svg.getAttribute('role'), 'img');
  assert.match(svg.getAttribute('aria-label'), /7 days/);
  const groups = withClass(svg, 'fr-bar');
  assert.equal(groups.length, 7);
  for (const g of groups) assert.equal(byTag(g, 'title').length, 1);
  assert.match(byTag(groups[0], 'title')[0].textContent, /2026-11-02: 1h 0m/);
  assert.ok(byTag(svg, 'rect').length > 7);
  assertClean(svg);
});

test('stackedDailyBars handles empty, zero and single-day data', () => {
  const empty = stackedDailyBars([], {});
  assert.equal(withClass(empty, 'fr-bar').length, 0);
  assert.match(empty.getAttribute('aria-label'), /no data/i);
  assertClean(empty);
  const zeros = stackedDailyBars([day('2026-11-02', 0), day('2026-11-03', 0)]);
  assert.match(zeros.getAttribute('aria-label'), /no data/i);
  assertClean(zeros);
  const one = stackedDailyBars([day('2026-11-02', 120, { Code: 120 })]);
  assert.equal(withClass(one, 'fr-bar').length, 1);
  assertClean(one);
  assertClean(stackedDailyBars(undefined));
  assertClean(stackedDailyBars([day('2026-11-02', NaN, { Code: NaN })]));
});

test('app names are text, not markup', () => {
  const evil = '<script>alert(1)</script>';
  const svg = stackedDailyBars([day('2026-11-02', 100, { [evil]: 100 })]);
  assert.equal(byTag(svg, 'script').length, 0);
  assert.ok(byTag(svg, 'title')[0].textContent.includes(evil));
  const list = rankedBars([{ name: evil, secs: 100, share: 1 }]);
  assert.equal(findAll(list, n => n.tag === 'script').length, 0);
  assert.ok(list.textContent.includes(evil));
  const t = dataTable([{ n: evil }], [{ key: 'n', label: 'Name' }]);
  assert.equal(findAll(t, n => n.tag === 'script').length, 0);
  assert.ok(t.textContent.includes(evil));
});

test('rankedBars shows time and percent that sum to about 100', () => {
  const items = [
    { name: 'Code', secs: 11520, share: 0.6 },
    { name: 'Chrome', secs: 5000, share: 0.3 },
    { name: 'Slack', secs: 1500, share: 0.1 },
  ];
  const el = rankedBars(items, { unit: 'time' });
  assert.match(el.textContent, /3h 12m/);
  const pcts = withClass(el, 'fr-rank-pct').map(n => parseInt(n.textContent, 10));
  assert.deepEqual(pcts, [60, 30, 10]);
  assert.equal(pcts.reduce((a, b) => a + b, 0), 100);
  assert.equal(withClass(el, 'fr-rank-row').length, 3);
  assert.equal(withClass(el, 'fr-rank-fill')[0].style.width, '100%');
  assertClean(el);
});

test('rankedBars copes with empty and odd items', () => {
  const el = rankedBars([]);
  assert.match(el.textContent, /no data/i);
  assertClean(el);
  assertClean(rankedBars([{ name: 'x', secs: 0, share: NaN }, { name: 'y', secs: NaN }]));
  assertClean(rankedBars(null));
});

test('weekdayBars draws 7 labelled bars', () => {
  const svg = weekdayBars([3600, 0, 7200, 0, 0, 0, 60]);
  assert.equal(byTag(svg, 'rect').length, 7);
  assert.equal(svg.getAttribute('role'), 'img');
  const labels = byTag(svg, 'text').map(t => t.textContent);
  for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) assert.ok(labels.includes(d), d);
  assertClean(svg);
  const none = weekdayBars([0, 0, 0, 0, 0, 0, 0]);
  assert.equal(byTag(none, 'rect').length, 7);
  assert.match(none.getAttribute('aria-label'), /no data/i);
  assertClean(none);
  assertClean(weekdayBars([]));
  assertClean(weekdayBars([NaN, Infinity, -5]));
});

test('yearHeatmap draws exactly the days of the year', () => {
  const rows = [day('2026-03-01', 3600), day('2026-03-02', 60), day('2025-12-31', 999), day('2027-01-01', 999)];
  const svg = yearHeatmap(rows, 2026);
  assert.equal(withClass(svg, 'fr-heat-cell').length, 365);
  assert.equal(svg.getAttribute('role'), 'img');
  const cell = withClass(svg, 'fr-heat-cell').find(c => byTag(c, 'title')[0].textContent.startsWith('2026-03-01'));
  assert.match(byTag(cell, 'title')[0].textContent, /1h 0m/);
  assert.ok(cls(cell).split(' ').includes('fr-heat-4'));
  assert.equal(cell.getAttribute('fill'), null);
  assert.equal(withClass(yearHeatmap([], 2024), 'fr-heat-cell').length, 366);
  assertClean(svg);
});

test('yearHeatmap empty, zero and bad year', () => {
  const e = yearHeatmap([], 2026);
  assert.match(e.getAttribute('aria-label'), /no data/i);
  assertClean(e);
  assertClean(yearHeatmap([day('2026-01-01', 0)], 2026));
  assertClean(yearHeatmap([day('2026-01-01', 10)], 2026));
  const bad = yearHeatmap([], NaN);
  assert.equal(withClass(bad, 'fr-heat-cell').length, 0);
  assertClean(bad);
});

test('dataTable is a plain table', () => {
  const t = dataTable([{ a: 'x', b: 90 }, { a: 'y' }], [{ key: 'a', label: 'Name' }, { key: 'b', label: 'Time', format: v => `${v}s` }]);
  assert.equal(t.tag, 'table');
  assert.equal(byTag(t, 'th').length, 2);
  assert.equal(byTag(t, 'tr').length, 3);
  assert.deepEqual(byTag(t, 'td').map(c => c.textContent), ['x', '90s', 'y', '']);
  assertClean(dataTable([], []));
});

test('stack colours follow app rank, not position among non-zero apps', () => {
  const names = ['a', 'b', 'c'];
  const d1 = stackSegments({ total: 300, apps: { a: 100, b: 100, c: 100 } }, names);
  const d2 = stackSegments({ total: 200, apps: { a: 0, b: 100, c: 100 } }, names);
  assert.deepEqual(d1.map(s => s.idx), [0, 1, 2]);
  assert.deepEqual(d2.map(s => [s.key, s.idx]), [['b', 1], ['c', 2]]);
  const svg = stackedDailyBars([day('2026-11-01', 300, { a: 100, b: 100, c: 100 }), day('2026-11-02', 200, { b: 100, c: 100 })]);
  const g2 = withClass(svg, 'fr-bar')[1];
  assert.deepEqual(byTag(g2, 'rect').map(r => cls(r)), ['fr-seg fr-c0', 'fr-seg fr-c1']); // b and c are ranks 0 and 1 overall
});

test('stack segment heights sum to the day total and stay in the plot', () => {
  const svg = stackedDailyBars(week);
  const groups = withClass(svg, 'fr-bar');
  const plotH = 220 - 10 - 24;
  const totals = week.map(d => Math.max(d.total, Object.values(d.apps).reduce((a, b) => a + b, 0)));
  groups.forEach((g, i) => {
    const rects = byTag(g, 'rect');
    const sum = rects.reduce((s, r) => s + Number(r.getAttribute('height')), 0);
    const top = Math.min(...rects.map(r => Number(r.getAttribute('y'))), Infinity);
    if (totals[i] === 0) return assert.equal(rects.length, 0);
    assert.ok(Math.abs(sum - (totals[i] / niceMax(Math.max(...totals))) * plotH) < 0.1 * rects.length + 0.1, `day ${i}`);
    assert.ok(top >= 10 - 0.1 && sum <= plotH + 0.1);
  });
});

test('niceMax is tight: never over-rounds past ~75%', () => {
  assert.equal(niceMax(3600), 3600);
  assert.equal(niceMax(8000), 9000);
  for (let v = 30; v < 400000; v = Math.ceil(v * 1.013)) {
    const m = niceMax(v);
    assert.ok(m >= v && v / m >= 0.7, `${v} -> ${m}`);
  }
});

test('legend names apps with swatches and Other; aria-label names top apps', () => {
  const names = topAppNames(week, 5);
  assert.equal(names.length, 5);
  const lg = chartLegend(names);
  const items = byTag(lg, 'li');
  assert.equal(items.length, 6);
  assert.equal(items.at(-1).textContent, 'Other');
  assert.ok(cls(items[0].children[0]).includes('fr-c0') && cls(items.at(-1).children[0]).includes('fr-c5'));
  assert.equal(items[0].textContent, 'Code');
  assert.match(stackedDailyBars(week).getAttribute('aria-label'), /Top apps: Code/);
  assert.equal(byTag(chartLegend([]), 'li').length, 0);
  assert.equal(byTag(chartLegend(['<b>x</b>']), 'b').length, 0);
});

test('the helper overflow key other is not a named series', () => {
  const rows = [day('2026-11-02', 500, { other: 400, Code: 100 })];
  assert.deepEqual(topAppNames(rows, 5), ['Code']);
  const segs = stackSegments(rows[0], ['Code']);
  assert.deepEqual(segs.map(s => [s.key, s.secs]), [['Code', 100], ['other', 400]]);
});

test('rankedBars: full name in title, tiny share shows <1%', () => {
  const el = rankedBars([{ name: 'A very long name', secs: 10000, share: 0.999 }, { name: 'tiny', secs: 1, share: 0.001 }]);
  assert.equal(withClass(el, 'fr-rank-name')[0].getAttribute('title'), 'A very long name');
  assert.deepEqual(withClass(el, 'fr-rank-pct').map(n => n.textContent), ['100%', '<1%']);
});

test('heatGrid for Sunday-start and leap Sunday-start years', () => {
  const g23 = heatGrid(2023); // 2023-01-01 is a Sunday
  assert.equal(g23.length, 365);
  assert.deepEqual([g23[0].col, g23[0].row], [0, 6]);
  assert.equal(Math.max(...g23.map(c => c.col)) + 1, 53);
  const g12 = heatGrid(2012); // leap, starts on a Sunday
  assert.equal(g12.length, 366);
  assert.equal(Math.max(...g12.map(c => c.col)) + 1, 54);
  assert.equal(new Set(g12.map(c => `${c.col},${c.row}`)).size, 366);
  const svg = yearHeatmap([], 2012);
  assert.equal(withClass(svg, 'fr-heat-cell').length, 366);
  assertClean(svg);
});

test('dataTable caption', () => {
  const t = dataTable([{ a: 1 }], [{ key: 'a', label: 'A' }], 'Daily time');
  assert.equal(byTag(t, 'caption')[0].textContent, 'Daily time');
  assert.equal(byTag(dataTable([], []), 'caption').length, 0);
});
