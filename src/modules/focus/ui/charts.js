// Plain-SVG chart builders for the Focus Room Stats page. No library; colors are CSS variables
// (--chart-0..5, --chart-empty, --chart-heat-1..4) so light and dark themes both work.
// All text from data (app and site names) is set as text, never as HTML. Geometry lives in small
// pure helpers (scale, niceMax, heatLevel, heatGrid, stackSegments) that need no DOM.
import { h } from './dom.js';
import { formatDuration } from '../stats.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const secsOf = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const r1 = (n) => Math.round(n * 10) / 10; // keeps attribute values short and finite

// ---- pure helpers -------------------------------------------------------------------------

/** `var(--chart-<i>)` for i in 0..5; anything else clamps into that range. */
export function chartColor(i) {
  const n = Number.isFinite(i) ? Math.min(5, Math.max(0, Math.floor(i))) : 0;
  return `var(--chart-${n})`;
}

/** value/max of `size`, clamped to 0..size; 0 for anything non-finite or a non-positive max. */
export function scale(value, max, size) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || !Number.isFinite(size) || max <= 0 || value <= 0) return 0;
  return Math.min(1, value / max) * size;
}

const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** A round axis maximum (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 or 10 times a power of ten, in minutes or hours) at or above `max`; never 0. */
export function niceMax(max) {
  if (!Number.isFinite(max) || max <= 0) return 3600;
  const unit = max <= 3600 ? 60 : 3600;
  const v = max / unit;
  const mag = 10 ** Math.floor(Math.log10(v));
  const m = v / mag;
  // Fine steps keep the tallest bar at 75% or more of the axis (3600 stays 3600, 8000 gives 9000).
  const step = NICE_STEPS.find(s => m <= s + 1e-9) ?? 10;
  return step * mag * unit;
}

/** Heatmap intensity 0..4 (0 = nothing) of `secs` against the busiest day `max`. */
export function heatLevel(secs, max) {
  if (!(secs > 0) || !(max > 0) || !Number.isFinite(secs) || !Number.isFinite(max)) return 0;
  const r = secs / max;
  return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1;
}

function utcDate(y, m, d) {
  const dt = new Date(Date.UTC(2000, m, d));
  dt.setUTCFullYear(y);
  return dt;
}
function keyOfDate(dt) {
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(dt.getUTCFullYear(), 4)}-${p(dt.getUTCMonth() + 1, 2)}-${p(dt.getUTCDate(), 2)}`;
}

/** Every day of `year` as { day, col, row, month, dom }; row 0 = Monday, col = week column from 0. */
export function heatGrid(year) {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return [];
  const first = utcDate(year, 0, 1);
  const offset = (first.getUTCDay() + 6) % 7;
  const out = [];
  for (let i = 0; ; i += 1) {
    const dt = new Date(first.getTime() + i * 86400000);
    if (dt.getUTCFullYear() !== year) break;
    out.push({ day: keyOfDate(dt), col: Math.floor((offset + i) / 7), row: (offset + i) % 7, month: dt.getUTCMonth(), dom: dt.getUTCDate() });
  }
  return out;
}

/** Stack segments for one day: the listed apps (bottom up) then `other` for the remainder.
 *  `idx` is the app's rank in `names` (stable colour across days), 5 for `other`. */
export function stackSegments(row, names) {
  const apps = row?.apps ?? {};
  const segs = [];
  let attributed = 0;
  let sum = 0;
  for (const k of Object.keys(apps)) sum += secsOf(apps[k]);
  for (const name of names) {
    const s = secsOf(apps[name]);
    if (s > 0) { segs.push({ key: name, secs: s, idx: Math.min(4, names.indexOf(name)) }); attributed += s; }
  }
  const total = Math.max(secsOf(row?.total), sum);
  if (total - attributed > 0) segs.push({ key: 'other', secs: total - attributed, idx: 5 });
  return segs;
}

/** Names of the `topN` (max 5) most-used apps over the days; the helper's overflow key `other` is never a named series. */
export function topAppNames(perDay, topN = 5) {
  const n = Math.min(5, Math.max(0, Math.floor(Number.isFinite(topN) ? topN : 5)));
  return rankApps(Array.isArray(perDay) ? perDay.filter(Boolean) : [], n);
}

function rankApps(perDay, topN) {
  const sums = new Map();
  for (const row of perDay) for (const [k, v] of Object.entries(row?.apps ?? {})) if (k !== 'other' && secsOf(v) > 0) sums.set(k, (sums.get(k) ?? 0) + v);
  return [...sums].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, topN).map(([k]) => k);
}

// ---- tiny SVG builder ---------------------------------------------------------------------

function svgEl(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  el.append(...kids.filter(k => k != null));
  return el;
}
const text = (x, y, anchor, str, cls = 'fr-chart-label') => svgEl('text', { x: r1(x), y: r1(y), 'text-anchor': anchor, class: cls }, str);
const title = (str) => svgEl('title', {}, str);

function root(w, hgt, label, cls) {
  return svgEl('svg', { viewBox: `0 0 ${w} ${hgt}`, role: 'img', 'aria-label': label, class: `fr-chart ${cls}`, preserveAspectRatio: 'xMidYMid meet' });
}
const NO_DATA = 'No data for this period.';

// ---- stacked daily bars -------------------------------------------------------------------

export function stackedDailyBars(perDay, { topN = 5 } = {}) {
  const days = Array.isArray(perDay) ? perDay.filter(Boolean) : [];
  const names = topAppNames(days, topN);
  const totals = days.map(d => Math.max(secsOf(d.total), stackSegments(d, []).reduce((s, x) => s + x.secs, 0)));
  const grand = totals.reduce((a, b) => a + b, 0);
  const W = 640; const H = 220; const L = 44; const R = 8; const T = 10; const B = 24;
  const pw = W - L - R; const ph = H - T - B;

  if (days.length === 0 || grand <= 0) return root(W, H, NO_DATA, 'fr-chart-stacked');
  let best = 0;
  totals.forEach((t, i) => { if (t > totals[best]) best = i; });
  const svg = root(W, H, `Daily screen time over ${days.length} day${days.length === 1 ? '' : 's'}: ${formatDuration(grand)} in total. Busiest day ${days[best].day} with ${formatDuration(totals[best])}.${names.length ? ` Top apps: ${names.join(', ')}.` : ''}`, 'fr-chart-stacked');

  const max = niceMax(Math.max(...totals));
  for (const f of [0, 0.5, 1]) {
    const y = T + ph - f * ph;
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: r1(y), y2: r1(y), class: 'fr-chart-grid' }));
    if (f > 0) svg.append(text(L - 6, y + 4, 'end', formatDuration(max * f)));
  }
  svg.append(text(L - 6, T + ph + 4, 'end', '0m'));

  const slot = pw / days.length;
  const bw = Math.min(slot * 0.7, 48);
  const every = Math.max(1, Math.ceil(days.length / 8));
  days.forEach((d, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    const segs = stackSegments(d, names);
    const lines = [`${d.day}: ${formatDuration(totals[i])}`, ...segs.map(s => `${s.key}: ${formatDuration(s.secs)}`)];
    const g = svgEl('g', { class: 'fr-bar' }, title(lines.join('\n')));
    let y = T + ph;
    for (const s of segs) {
      const sh = scale(s.secs, max, ph);
      if (sh <= 0) continue;
      y -= sh;
      g.append(svgEl('rect', { x: r1(x), y: r1(y), width: r1(bw), height: r1(sh), class: `fr-seg fr-c${s.idx}` }));
    }
    svg.append(g);
    if (i % every === 0) svg.append(text(x + bw / 2, H - 8, 'middle', String(d.day).slice(days.length > 31 ? 5 : 8) || String(d.day)));
  });
  return svg;
}

// ---- legend ---------------------------------------------------------------------------------

/** Swatch plus app name for each series (and "Other"), so colour is never the only identifier. */
export function chartLegend(names, { withOther = true } = {}) {
  const list = (Array.isArray(names) ? names : []).slice(0, 5).map((n, i) => ({ n: String(n), i }));
  if (withOther && list.length) list.push({ n: 'Other', i: 5 });
  return h('ul', { class: 'fr-legend', 'aria-label': 'Legend' },
    ...list.map(({ n, i }) => h('li', {}, h('span', { class: `fr-swatch fr-c${i}`, 'aria-hidden': 'true' }), h('span', { class: 'fr-legend-name' }, n))));
}

// ---- weekday bars -------------------------------------------------------------------------

export function weekdayBars(perWeekday) {
  const vals = WEEKDAYS.map((_, i) => secsOf(Array.isArray(perWeekday) ? perWeekday[i] : 0));
  const W = 320; const H = 160; const L = 4; const R = 4; const T = 14; const B = 22;
  const pw = W - L - R; const ph = H - T - B;
  const peak = Math.max(...vals);
  const label = peak > 0
    ? `Average time per weekday: ${WEEKDAYS.map((d, i) => `${d} ${formatDuration(vals[i])}`).join(', ')}.`
    : NO_DATA;
  const svg = root(W, H, label, 'fr-chart-weekday');
  const max = niceMax(peak);
  const slot = pw / 7; const bw = slot * 0.64;
  vals.forEach((v, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    const bh = scale(v, max, ph);
    const g = svgEl('g', { class: 'fr-bar' }, title(`${WEEKDAYS[i]}: ${formatDuration(v)} average`),
      svgEl('rect', { x: r1(x), y: r1(T + ph - bh), width: r1(bw), height: r1(bh), class: 'fr-seg fr-c0' }));
    svg.append(g, text(x + bw / 2, H - 6, 'middle', WEEKDAYS[i]));
    if (v > 0) svg.append(text(x + bw / 2, T + ph - bh - 4, 'middle', formatDuration(v), 'fr-chart-label fr-chart-value'));
  });
  return svg;
}

// ---- year heatmap -------------------------------------------------------------------------

export function yearHeatmap(perDay, year) {
  const grid = heatGrid(year);
  const CELL = 11; const GAP = 2; const STEP = CELL + GAP; const L = 28; const T = 16;
  const cols = grid.length ? grid[grid.length - 1].col + 1 : 53;
  const W = L + cols * STEP; const H = T + 7 * STEP;
  const byDay = new Map();
  for (const r of Array.isArray(perDay) ? perDay : []) if (r && typeof r.day === 'string') byDay.set(r.day, secsOf(r.total));
  let max = 0; let total = 0; let active = 0;
  for (const c of grid) { const s = byDay.get(c.day) ?? 0; total += s; if (s > 0) active += 1; if (s > max) max = s; }
  const label = total > 0
    ? `Activity calendar for ${year}: ${formatDuration(total)} over ${active} active day${active === 1 ? '' : 's'}.`
    : NO_DATA;
  const svg = root(W, H, label, 'fr-chart-heat');
  [[0, 'Mon'], [2, 'Wed'], [4, 'Fri']].forEach(([row, name]) => svg.append(text(L - 4, T + row * STEP + CELL - 1, 'end', name)));
  let lastMonth = -1;
  for (const c of grid) {
    const s = byDay.get(c.day) ?? 0;
    const lvl = heatLevel(s, max);
    if (c.month !== lastMonth && c.dom <= 7) { svg.append(text(L + c.col * STEP, T - 5, 'start', MONTHS[c.month])); lastMonth = c.month; }
    svg.append(svgEl('rect', {
      x: L + c.col * STEP, y: T + c.row * STEP, width: CELL, height: CELL, rx: 2,
      class: `fr-heat-cell fr-heat-${lvl}`,
    }, title(`${c.day}: ${formatDuration(s)}`)));
  }
  return svg;
}

// ---- ranked bars (HTML) ---------------------------------------------------------------------

export function rankedBars(items, { unit = 'time' } = {}) {
  const rows = (Array.isArray(items) ? items : []).filter(Boolean);
  const sum = rows.reduce((s, r) => s + secsOf(r.secs), 0);
  const max = Math.max(0, ...rows.map(r => secsOf(r.secs)));
  const fmt = (n) => (unit === 'time' ? formatDuration(n) : String(Math.round(secsOf(n))));
  const wrap = h('div', { class: 'fr-ranked', role: 'list' });
  if (rows.length === 0 || sum <= 0) {
    wrap.append(h('p', { class: 'fr-chart-empty' }, NO_DATA));
    return wrap;
  }
  for (const r of rows) {
    const secs = secsOf(r.secs);
    const share = Number.isFinite(r.share) && r.share >= 0 ? r.share : secs / sum;
    const pct = Math.round(share * 100);
    const pctText = share > 0 && pct === 0 ? '<1%' : `${pct}%`;
    const name = String(r.name ?? '');
    const fill = h('div', { class: 'fr-rank-fill' });
    fill.style.width = `${r1(max > 0 ? (secs / max) * 100 : 0)}%`;
    wrap.append(h('div', { class: 'fr-rank-row', role: 'listitem' },
      h('span', { class: 'fr-rank-name', title: name }, name),
      h('div', { class: 'fr-rank-track' }, fill),
      h('span', { class: 'fr-rank-time' }, fmt(secs)),
      h('span', { class: 'fr-rank-pct' }, pctText)));
  }
  return wrap;
}

// ---- data table -----------------------------------------------------------------------------

export function dataTable(rows, columns, caption = '') {
  const cols = Array.isArray(columns) ? columns : [];
  return h('table', { class: 'fr-table' },
    caption ? h('caption', { class: 'fr-table-caption' }, String(caption)) : null,
    h('thead', {}, h('tr', {}, ...cols.map(c => h('th', { scope: 'col' }, String(c.label ?? c.key ?? ''))))),
    h('tbody', {}, ...(Array.isArray(rows) ? rows : []).map(row => h('tr', {}, ...cols.map((c) => {
      const v = row?.[c.key];
      const out = v == null ? '' : typeof c.format === 'function' ? c.format(v, row) : v;
      return h('td', {}, String(out ?? ''));
    })))));
}
