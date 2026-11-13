import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, findAll, walk } from './helpers/fake-dom.js';
import { timelineStrip, timelineLegend, hourBars, weekdayHourHeatmap, dailyTrendBars } from '../src/modules/focus/ui/charts-detail.js';

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

const BASE = 1_700_006_400; // multiple of 3600 and 86400
const hms = (sec) => { const d = new Date(sec * 1000); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; };
const opts = (o = {}) => ({ timeLabel: hms, offsetSec: 0, ...o });
const T = (h, m, s) => BASE + h * 3600 + m * 60 + s;

test('timelineStrip draws one rect per block with an exact tooltip', () => {
  const blocks = [
    { start: T(9, 0, 0), end: T(10, 0, 0), exe: 'Code', site: null },
    { start: T(14, 32, 5), end: T(14, 41, 50), exe: 'Chrome', site: 'youtube' },
    { start: T(16, 0, 0), end: T(17, 30, 0), exe: 'Slack', site: null },
  ];
  const svg = timelineStrip(blocks, opts({ fromSec: BASE, toSec: BASE + 86400, colorOf: (e) => (e === 'Chrome' ? 1 : 0) }));
  assert.equal(svg.tag, 'svg');
  assert.equal(svg.getAttribute('role'), 'img');
  const rects = withClass(svg, 'fr-block');
  assert.equal(rects.length, 3);
  assert.equal(byTag(rects[1], 'title')[0].textContent, 'Chrome / youtube · 14:32:05 to 14:41:50 · 9m 45s');
  assert.equal(byTag(rects[0], 'title')[0].textContent, 'Code · 09:00:00 to 10:00:00 · 1h 00m 00s');
  assert.ok(cls(rects[1]).split(' ').includes('fr-c1'));
  assert.ok(svg.getAttribute('aria-label').length > 10);
  assertClean(svg);
});

test('timelineStrip is clean for empty, single, and degenerate windows', () => {
  const empty = timelineStrip([], opts({ fromSec: BASE, toSec: BASE + 3600 }));
  assert.equal(withClass(empty, 'fr-block').length, 0);
  assert.ok(empty.getAttribute('aria-label'));
  assertClean(empty);
  const one = timelineStrip([{ start: BASE, end: BASE + 5, exe: 'a', site: null }], opts({ fromSec: BASE, toSec: BASE + 3600 }));
  assert.equal(withClass(one, 'fr-block').length, 1);
  assertClean(one);
  for (const [f, t] of [[BASE, BASE], [BASE + 10, BASE], [NaN, 5], [0, Infinity], [undefined, undefined]]) {
    const z = timelineStrip([{ start: 1, end: 2, exe: 'a' }], opts({ fromSec: f, toSec: t }));
    assert.equal(withClass(z, 'fr-block').length, 0);
    assert.ok(z.getAttribute('aria-label'));
    assertClean(z);
  }
  assertClean(timelineStrip(null, {}));
  assertClean(timelineStrip(undefined, undefined));
});

test('timelineStrip clips blocks to the window and keeps rects inside the width', () => {
  const svg = timelineStrip([{ start: BASE - 100, end: BASE + 100, exe: 'a', site: null }], opts({ fromSec: BASE, toSec: BASE + 1000, width: 500 }));
  const r = withClass(svg, 'fr-block')[0];
  assert.equal(Number(r.getAttribute('x')) >= 0, true);
  assert.ok(Number(r.getAttribute('x')) + Number(r.getAttribute('width')) <= 500 + 0.01);
});

const tickCount = (svg) => withClass(svg, 'fr-tick').length;
test('timelineStrip ticks adapt to the window length and are named', () => {
  const day = timelineStrip([], opts({ fromSec: BASE, toSec: BASE + 86400 }));
  const hour = timelineStrip([], opts({ fromSec: BASE, toSec: BASE + 3600 }));
  const min = timelineStrip([], opts({ fromSec: BASE, toSec: BASE + 600 }));
  const sec = timelineStrip([], opts({ fromSec: BASE, toSec: BASE + 60 }));
  assert.equal(tickCount(day), 25); // hourly, both ends
  assert.equal(tickCount(hour), 7); // every 10 minutes
  assert.equal(tickCount(min), 11); // every minute
  assert.equal(tickCount(sec), 7); // every 10 seconds
  for (const g of withClass(day, 'fr-tick')) assert.match(byTag(g, 'title')[0].textContent, /\d\d:\d\d/);
  assert.equal(byTag(withClass(day, 'fr-tick')[3], 'title')[0].textContent, '03:00');
  assertClean(day); assertClean(sec);
});

test('timelineLegend names programs with swatches', () => {
  const lg = timelineLegend(['Code', '<b>x</b>'], (n) => (n === 'Code' ? 0 : 3));
  const items = byTag(lg, 'li');
  assert.equal(items.length, 2);
  assert.ok(cls(items[1].children[0]).includes('fr-c3'));
  assert.equal(byTag(lg, 'b').length, 0);
  assert.equal(byTag(timelineLegend(null), 'li').length, 0);
});

test('hourBars draws 24 bars and mentions the days counted', () => {
  const hours = Array.from({ length: 24 }, (_, i) => (i === 14 ? 1800 : i === 9 ? 600 : 0));
  const svg = hourBars(hours, 12);
  assert.equal(withClass(svg, 'fr-bar').length, 24);
  assert.match(svg.getAttribute('aria-label'), /Based on 12 days/);
  assert.match(byTag(withClass(svg, 'fr-bar')[14], 'title')[0].textContent, /14:00/);
  assertClean(svg);
  assert.match(hourBars(hours, 1).getAttribute('aria-label'), /Based on 1 day\b/);
  const none = hourBars([], 0);
  assert.equal(withClass(none, 'fr-bar').length, 0);
  assert.match(none.getAttribute('aria-label'), /not recorded/i);
  assert.equal(byTag(none, 'title').length, 0);
  assertClean(none);
  const zeros = hourBars(new Array(24).fill(0), 3);
  assert.equal(withClass(zeros, 'fr-bar').length, 24);
  assert.match(zeros.getAttribute('aria-label'), /no data/i);
  assertClean(hourBars([NaN, Infinity, -1], NaN));
});

test('weekdayHourHeatmap has 168 cells with heat classes', () => {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  grid[0][9] = 3600; grid[2][14] = 900;
  const svg = weekdayHourHeatmap(grid);
  const cells = withClass(svg, 'fr-heat-cell');
  assert.equal(cells.length, 168);
  assert.ok(cls(cells[9]).split(' ').includes('fr-heat-4'));
  assert.ok(cls(cells[0]).split(' ').includes('fr-heat-0'));
  assert.match(byTag(cells[9], 'title')[0].textContent, /^Mon 09:00/);
  assert.ok(svg.getAttribute('aria-label'));
  assertClean(svg);
  assert.equal(withClass(weekdayHourHeatmap(null), 'fr-heat-cell').length, 168);
  assert.match(weekdayHourHeatmap([]).getAttribute('aria-label'), /no data/i);
  assertClean(weekdayHourHeatmap([[NaN]]));
});

test('dailyTrendBars draws a bar per day', () => {
  const svg = dailyTrendBars([{ day: '2026-11-02', secs: 3600 }, { day: '2026-11-03', secs: 600 }]);
  assert.equal(withClass(svg, 'fr-bar').length, 2);
  assert.match(byTag(withClass(svg, 'fr-bar')[0], 'title')[0].textContent, /2026-11-02: 1h 0m/);
  assert.match(svg.getAttribute('aria-label'), /2 days/);
  assertClean(svg);
  assert.match(dailyTrendBars([]).getAttribute('aria-label'), /no data/i);
  assertClean(dailyTrendBars(undefined));
  assertClean(dailyTrendBars([{ day: 'x', secs: NaN }]));
});

test('timelineStrip geometry is exact for a known block', () => {
  const svg = timelineStrip([{ start: BASE + 100, end: BASE + 300, exe: 'a', site: null }], opts({ fromSec: BASE, toSec: BASE + 1000, width: 500 }));
  const r = withClass(svg, 'fr-block')[0];
  assert.equal(r.getAttribute('x'), '50');
  assert.equal(r.getAttribute('width'), '100');
});

test('the same program gets the same colour in different windows', () => {
  const colorOf = (e) => (e === 'b' ? 4 : 0);
  const blocks = [{ start: BASE + 10, end: BASE + 20, exe: 'b', site: null }];
  const a = timelineStrip(blocks, opts({ fromSec: BASE, toSec: BASE + 100, colorOf }));
  const b = timelineStrip(blocks, opts({ fromSec: BASE, toSec: BASE + 50000, colorOf }));
  assert.ok(cls(withClass(a, 'fr-block')[0]).includes('fr-c4'));
  assert.ok(cls(withClass(b, 'fr-block')[0]).includes('fr-c4'));
});

test('merged blocks report active time and stretch count, not the span', () => {
  // 1000 s over 500 px: 2 s per px; a 1 s gap is sub-pixel and merges
  const blocks = [
    { start: BASE, end: BASE + 100, exe: 'a', site: null },
    { start: BASE + 101, end: BASE + 201, exe: 'a', site: null },
    { start: BASE + 500, end: BASE + 560, exe: 'a', site: null },
  ];
  const svg = timelineStrip(blocks, opts({ fromSec: BASE, toSec: BASE + 1000, width: 500 }));
  const rects = withClass(svg, 'fr-block');
  assert.equal(rects.length, 2);
  assert.equal(byTag(rects[0], 'title')[0].textContent, 'A · 00:00:00 to 00:03:21 · 3m 20s · 2 stretches');
  assert.equal(byTag(rects[1], 'title')[0].textContent, 'A · 00:08:20 to 00:09:20 · 1m 00s');
});

test('timelineStrip caps the number of rects and says what it left out', () => {
  const blocks = [];
  for (let i = 0; i < 3000; i += 1) blocks.push({ start: BASE + i * 20, end: BASE + i * 20 + 10 + (i % 7), exe: i % 2 ? 'A' : 'B', site: null });
  const svg = timelineStrip(blocks, opts({ fromSec: BASE, toSec: BASE + 60000, width: 720 }));
  const n = withClass(svg, 'fr-block').length;
  assert.equal(n, 2000);
  assert.equal(svg.getAttribute('data-hidden'), '1000');
  assert.match(svg.getAttribute('aria-label'), /1000 short blocks not drawn/);
  const xs = withClass(svg, 'fr-block').map(r => Number(r.getAttribute('x')));
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b));
  assertClean(svg);
  assert.equal(timelineStrip(blocks.slice(0, 5), opts({ fromSec: BASE, toSec: BASE + 60000 })).getAttribute('data-hidden'), null);
});
