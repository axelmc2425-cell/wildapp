// Detail SVG charts for the Focus Room Stats page: timeline strip, hour-of-day bars, weekday by hour
// heatmap and a per-item daily trend. Built like charts.js (plain SVG, CSS-variable colours via the
// fr-c0..5 and fr-heat-0..4 classes, `<title>` tooltips, text set as text never as HTML).
import { h } from './dom.js';
import { formatDuration } from '../stats.js';
import { formatDurationSecs, mergeTiny } from '../stats-detail.js';
import { scale, niceMax, heatLevel } from './charts.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const NO_DATA = 'No data for this period.';

const secsOf = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const r1 = (n) => Math.round(n * 10) / 10;
const p2 = (n) => String(n).padStart(2, '0');

function svgEl(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  el.append(...kids.filter(k => k != null));
  return el;
}
const text = (x, y, anchor, str, cls = 'fr-chart-label') => svgEl('text', { x: r1(x), y: r1(y), 'text-anchor': anchor, class: cls }, str);
const title = (str) => svgEl('title', {}, str);
const root = (w, hgt, label, cls) => svgEl('svg', { viewBox: `0 0 ${w} ${hgt}`, role: 'img', 'aria-label': label, class: `fr-chart ${cls}`, preserveAspectRatio: 'xMidYMid meet' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Local HH:MM:SS of a unix second in the viewer's time zone. */
export function localTimeLabel(sec) {
  const d = new Date(sec * 1000);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
const localOffsetSec = (sec) => -new Date(sec * 1000).getTimezoneOffset() * 60;
const defaultName = (exe) => {
  const base = String(exe ?? '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
  return base ? base[0].toUpperCase() + base.slice(1) : 'Unknown';
};

// ---- timeline -------------------------------------------------------------------------------

function tickStep(len) {
  let step = len >= 6 * 3600 ? 3600 : len >= 3600 ? 600 : len >= 600 ? 60 : 10;
  while (len / step > 48) step *= 2;
  return step;
}

/**
 * One rect per block over [fromSec, toSec]. `colorOf(exe)` gives a palette index 0..5 (default 0);
 * options `timeLabel(sec)` (HH:MM:SS), `offsetSec` (local UTC offset, for tick alignment) and
 * `nameOf(exe)` can be injected. A zero, negative or non-finite window gives an empty strip.
 */
export function timelineStrip(blocks, { fromSec, toSec, width = 720, colorOf = () => 0, timeLabel = localTimeLabel, offsetSec, nameOf = defaultName } = {}) {
  const W = Number.isFinite(width) && width >= 100 ? Math.floor(width) : 720;
  const H = 52; const TOP = 4; const BH = 26; const L = 0;
  const len = toSec - fromSec;
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || !(len > 0)) return root(W, H, 'Timeline: no valid time window.', 'fr-chart-timeline');

  const list = (Array.isArray(blocks) ? blocks : []).filter(b => b && Number.isFinite(b.start) && Number.isFinite(b.end));
  const clipped = list.map(b => ({ ...b, start: Math.max(b.start, fromSec), end: Math.min(b.end, toSec) })).filter(b => b.end > b.start);
  const perPx = len / W;
  const merged = mergeTiny(clipped, perPx, 1);
  const total = clipped.reduce((s, b) => s + (b.end - b.start), 0);
  const label = clipped.length
    ? `Timeline from ${timeLabel(fromSec)} to ${timeLabel(toSec)}: ${plural(clipped.length, 'block')}, ${formatDurationSecs(total)} in total.`
    : `Timeline from ${timeLabel(fromSec)} to ${timeLabel(toSec)}: ${NO_DATA}`;
  const svg = root(W, H, label, 'fr-chart-timeline');
  const x = (t) => L + ((t - fromSec) / len) * W;

  svg.append(svgEl('line', { x1: 0, x2: W, y1: TOP + BH + 0.5, y2: TOP + BH + 0.5, class: 'fr-chart-grid' }));
  const step = tickStep(len);
  const off = Number.isFinite(offsetSec) ? offsetSec : localOffsetSec(fromSec);
  const showEvery = Math.max(1, Math.ceil(40 / ((step / len) * W)));
  const fmtTick = (t) => { const s = timeLabel(t); return step >= 60 ? s.slice(0, 5) : s; };
  let n = 0;
  for (let t = Math.ceil((fromSec + off) / step) * step - off; t <= toSec; t += step, n += 1) {
    const tx = x(t);
    const name = fmtTick(t);
    const g = svgEl('g', { class: 'fr-tick' }, title(name),
      svgEl('line', { x1: r1(tx), x2: r1(tx), y1: TOP + BH, y2: TOP + BH + 5, class: 'fr-chart-grid' }));
    if (n % showEvery === 0) g.append(text(Math.min(W - 14, Math.max(14, tx)), H - 6, 'middle', name));
    svg.append(g);
  }
  for (const b of merged) {
    const bx = x(b.start);
    const bw = Math.max(1, x(b.end) - bx);
    const who = b.site ? `${nameOf(b.exe)} / ${b.site}` : nameOf(b.exe);
    const tip = `${who} · ${timeLabel(b.start)} to ${timeLabel(b.end)} · ${formatDurationSecs(b.end - b.start)}`;
    svg.append(svgEl('rect', {
      x: r1(bx), y: TOP, width: r1(Math.min(bw, W - bx)), height: BH,
      class: `fr-seg fr-block fr-c${Math.min(5, Math.max(0, Math.floor(secsOf(colorOf(b.exe)))))}`,
    }, title(tip)));
  }
  return svg;
}

/** Swatch plus name for each program on the timeline. `colorOf(name)` gives the palette index. */
export function timelineLegend(names, colorOf = () => 0) {
  const list = (Array.isArray(names) ? names : []).map(String);
  return h('ul', { class: 'fr-legend', 'aria-label': 'Legend' },
    ...list.map((n) => h('li', {}, h('span', { class: `fr-swatch fr-c${Math.min(5, Math.max(0, Math.floor(secsOf(colorOf(n)))))}`, 'aria-hidden': 'true' }), h('span', { class: 'fr-legend-name' }, n))));
}

// ---- hour of day ----------------------------------------------------------------------------

export function hourBars(hours, daysCounted) {
  const vals = Array.from({ length: 24 }, (_, i) => secsOf(Array.isArray(hours) ? hours[i] : 0));
  const days = Number.isFinite(daysCounted) && daysCounted > 0 ? Math.floor(daysCounted) : 0;
  const W = 480; const H = 160; const L = 4; const R = 4; const T = 10; const B = 22;
  const pw = W - L - R; const ph = H - T - B;
  const peak = Math.max(...vals);
  let best = 0;
  vals.forEach((v, i) => { if (v > vals[best]) best = i; });
  const label = peak > 0
    ? `Average screen time per hour of day. Busiest hour ${p2(best)}:00 with ${formatDuration(peak)} on average. Based on ${plural(days, 'day')}.`
    : `${NO_DATA} Based on ${plural(days, 'day')}.`;
  const svg = root(W, H, label, 'fr-chart-hours');
  const max = niceMax(peak);
  const slot = pw / 24; const bw = slot * 0.74;
  vals.forEach((v, i) => {
    const bx = L + i * slot + (slot - bw) / 2;
    const bh = scale(v, max, ph);
    svg.append(svgEl('g', { class: 'fr-bar' }, title(`${p2(i)}:00 to ${p2(i)}:59: ${formatDuration(v)} on average`),
      svgEl('rect', { x: r1(bx), y: r1(T + ph - bh), width: r1(bw), height: r1(bh), class: 'fr-seg fr-c0' })));
    if (i % 3 === 0) svg.append(text(bx + bw / 2, H - 6, 'middle', p2(i)));
  });
  return svg;
}

// ---- weekday by hour ------------------------------------------------------------------------

export function weekdayHourHeatmap(grid) {
  const CW = 20; const CH = 18; const GAP = 2; const L = 32; const T = 16;
  const W = L + 24 * (CW + GAP); const H = T + 7 * (CH + GAP);
  const val = (r, c) => secsOf(Array.isArray(grid) && Array.isArray(grid[r]) ? grid[r][c] : 0);
  let max = 0;
  for (let r = 0; r < 7; r += 1) for (let c = 0; c < 24; c += 1) max = Math.max(max, val(r, c));
  const svg = root(W, H, max > 0 ? `Average screen time by weekday and hour of day. Busiest slot ${formatDuration(max)}.` : NO_DATA, 'fr-chart-heat fr-chart-weekhour');
  for (let c = 0; c < 24; c += 3) svg.append(text(L + c * (CW + GAP), T - 5, 'start', p2(c)));
  for (let r = 0; r < 7; r += 1) {
    svg.append(text(L - 4, T + r * (CH + GAP) + CH - 5, 'end', WEEKDAYS[r]));
    for (let c = 0; c < 24; c += 1) {
      const s = val(r, c);
      svg.append(svgEl('rect', {
        x: L + c * (CW + GAP), y: T + r * (CH + GAP), width: CW, height: CH, rx: 2,
        class: `fr-heat-cell fr-heat-${heatLevel(s, max)}`,
      }, title(`${WEEKDAYS[r]} ${p2(c)}:00: ${formatDuration(s)} on average`)));
    }
  }
  return svg;
}

// ---- per-item daily trend -------------------------------------------------------------------

/** `daily` is [{ day: 'YYYY-MM-DD', secs }] as returned by appDrilldown. */
export function dailyTrendBars(daily) {
  const rows = (Array.isArray(daily) ? daily : []).filter(Boolean).map(r => ({ day: String(r.day ?? ''), secs: secsOf(r.secs) }));
  const total = rows.reduce((s, r) => s + r.secs, 0);
  const W = 640; const H = 160; const L = 44; const R = 8; const T = 10; const B = 24;
  const pw = W - L - R; const ph = H - T - B;
  if (rows.length === 0 || total <= 0) return root(W, H, NO_DATA, 'fr-chart-trend');
  const svg = root(W, H, `Daily time over ${plural(rows.length, 'day')}: ${formatDuration(total)} in total.`, 'fr-chart-trend');
  const max = niceMax(Math.max(...rows.map(r => r.secs)));
  for (const f of [0, 0.5, 1]) {
    const y = T + ph - f * ph;
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: r1(y), y2: r1(y), class: 'fr-chart-grid' }));
    svg.append(text(L - 6, y + 4, 'end', f > 0 ? formatDuration(max * f) : '0m'));
  }
  const slot = pw / rows.length;
  const bw = Math.min(slot * 0.7, 48);
  const every = Math.max(1, Math.ceil(rows.length / 8));
  rows.forEach((r, i) => {
    const bx = L + i * slot + (slot - bw) / 2;
    const bh = scale(r.secs, max, ph);
    svg.append(svgEl('g', { class: bw < 3 ? 'fr-bar fr-thin' : 'fr-bar' }, title(`${r.day}: ${formatDuration(r.secs)}`),
      svgEl('rect', { x: r1(bx), y: r1(T + ph - bh), width: r1(bw), height: r1(bh), class: 'fr-seg fr-c0' })));
    if (i % every === 0) svg.append(text(bx + bw / 2, H - 8, 'middle', r.day.slice(rows.length > 31 ? 5 : 8) || r.day));
  });
  return svg;
}
