import { h } from './dom.js';
import { formatClock } from './util.js';
import { makeTzOffsetAt } from '../tz.js';
import { dayKey, addDays, rangeFor, previousRange, shiftRange, summarize, deltaVs, formatDuration } from '../stats.js';
import { timelineWindow, focusMetrics, activeStreaks, formatDurationSecs, hourlyAverages, weekdayHourGrid, periodAverages, appDrilldown, itemPeakHour } from '../stats-detail.js';
import { timelineStrip, timelineLegend, hourBars, weekdayHourHeatmap, dailyTrendBars } from './charts-detail.js';
import { stackedDailyBars, chartLegend, topAppNames, weekdayBars, yearHeatmap, rankedBars, dataTable } from './charts.js';

const PERIODS = [['today', 'Today'], ['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
const PREVIOUS_WORD = { day: 'yesterday', week: 'last week', month: 'last month', year: 'last year' };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const REFRESH_MS = 60000;
const STREAK_DAYS = 400;
const TABLE_CAP = 500;
const KEEP_DETAIL_DAYS = 90; // the helper keeps exact stretches this long
const ZOOMS = [['day', 'Day', 0], ['6h', '6 h', 6 * 3600], ['1h', '1 h', 3600], ['10m', '10 min', 600]];
const p2 = (n) => String(n).padStart(2, '0');
const programName = (exe) => {
  const base = String(exe == null ? '' : exe).split(/[\\/]/).pop().replace(/\.exe$/i, '');
  return base ? base[0].toUpperCase() + base.slice(1) : 'Unknown';
};

// Range labels are built by hand from day keys, so no Intl or locale call is needed for correctness.
function parts(day) { const [y, m, d] = day.split('-').map(Number); return { y, m, d }; }
const short = (day) => { const { m, d } = parts(day); return `${MONTHS[m - 1].slice(0, 3)} ${d}`; };
function weekdayName(day) {
  const { y, m, d } = parts(day);
  const dt = new Date(Date.UTC(2000, m - 1, d));
  dt.setUTCFullYear(y);
  return WEEKDAYS[(dt.getUTCDay() + 6) % 7];
}
export function rangeLabel(period, range, today) {
  const { y, m } = parts(range.from);
  if (period === 'day') return `${range.from === today ? 'Today, ' : ''}${weekdayName(range.from)} ${short(range.from)}, ${y}`;
  if (period === 'week') return `${short(range.from)} – ${short(range.to)}, ${parts(range.to).y}`;
  if (period === 'month') return `${MONTHS[m - 1]} ${y}`;
  return String(y);
}

/**
 * Renders the Focus Room Stats page into `root`. Returns a cleanup that stops timers, unsubscribes
 * and ignores any response still in flight.
 * deps = { onBack, now?, tzOffsetAt?, subscribe? }
 */
export function mountStatsPage(root, controller, deps = {}) {
  const now = deps.now || (() => Date.now());
  const tzOffsetAt = deps.tzOffsetAt || makeTzOffsetAt();
  const todayKey = () => dayKey(now(), tzOffsetAt);

  let alive = true;
  let period = 'week';
  let range = rangeFor(period, todayKey());
  let zoom = 'day';
  let panOff = null; // seconds from the day start; null = automatic position
  let streak = null; // { key: today, days, v }
  let stripHost = null;
  let windowEl = null;
  let asTable = false;
  let status = 'loading'; // 'loading' | 'ok' | 'down' | 'error'
  let message = '';
  let errCode = null;
  let unavailable = false;
  let version = 0; // bumps with every stored result, so the render signature never serialises day data
  let seq = 0; // newest request wins
  let statusKey = null; // the range key `status` describes
  let lastSig = null;
  let view = 'main'; // 'main' | 'drill'
  let drill = null; // { name, kind: 'app' | 'site' }
  let drillDay = null; // the day whose timeline is shown
  let dseq = 0; // newest day request wins
  let dstatus = 'idle'; // 'idle' | 'loading' | 'ok' | 'down' | 'error'
  let dmessage = '';
  let focusNext = null; // data-fk to focus after the next render
  const dcache = new Map(); // day -> { v, stretches, truncated, at }
  const cache = new Map(); // `${period}:${from}:${to}` -> { days, prevDays|null, at }
  const isToday = () => period === 'today';
  const navPeriod = () => (isToday() ? 'day' : period);
  const keyOf = () => (isToday() ? `today:${range.from}` : `${period}:${range.from}:${range.to}`);

  // Local day boundaries in unix seconds, correct on 23 and 25 hour days.
  function dayStartSec(day) {
    const { y, m, d } = parts(day);
    const dt = new Date(Date.UTC(2000, m - 1, d)); dt.setUTCFullYear(y);
    const utc = dt.getTime() / 1000;
    let t = utc;
    for (let i = 0; i < 2; i++) t = utc - tzOffsetAt(t * 1000) * 60;
    return t;
  }
  function timeLabel(sec) {
    const d = new Date((sec + tzOffsetAt(sec * 1000) * 60) * 1000);
    return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
  }

  const trackingOff = () => {
    const helper = controller.state && controller.state.helper;
    return !!(helper && helper.kind === 'ok' && helper.status && helper.status.usage_tracking === false);
  };
  const helperKind = () => (controller.state && controller.state.helper && controller.state.helper.kind) || 'unknown';

  async function safeUsage(from, to) {
    try {
      const res = await controller.getUsage(from, to);
      return res && typeof res === 'object' ? res : { ok: false, down: false, message: 'No answer from the helper.' };
    } catch (e) {
      return { ok: false, down: false, message: e && e.message ? String(e.message) : 'Unknown error' };
    }
  }

  async function safeSessions(day) {
    try {
      const res = await controller.getSessions(day);
      return res && typeof res === 'object' ? res : { ok: false, down: false, message: 'No answer from the helper.' };
    } catch (e) {
      return { ok: false, down: false, message: e && e.message ? String(e.message) : 'Unknown error' };
    }
  }

  async function loadToday() {
    const mine = ++seq;
    const day = range.from;
    const key = keyOf();
    const today = todayKey();
    if (key !== statusKey) { status = cache.has(key) ? 'ok' : 'loading'; message = ''; statusKey = key; panOff = null; }
    render();
    const needStreak = !streak || streak.key !== today;
    const [s, u, st] = await Promise.all([
      safeSessions(day), safeUsage(day, day),
      needStreak ? safeUsage(addDays(today, -(STREAK_DAYS - 1)), today) : Promise.resolve(null)]);
    if (!alive) return;
    if (st && st.ok && Array.isArray(st.days)) streak = { key: today, days: st.days, v: ++version };
    if (s.ok && Array.isArray(s.stretches)) {
      let total = null;
      if (u.ok && Array.isArray(u.days)) total = u.days.filter((r) => r && r.day === day).reduce((a, r) => a + (Number.isFinite(r.total) && r.total > 0 ? r.total : 0), 0);
      const old = cache.get(key);
      cache.set(key, { v: ++version, today: true, stretches: s.stretches, truncated: !!s.truncated, total: total == null && old ? old.total : total, at: now() });
    }
    if (mine !== seq) return;
    errCode = null; unavailable = false;
    if (s.ok && Array.isArray(s.stretches)) { status = 'ok'; message = ''; }
    else if (s.down) { status = 'down'; message = s.message || ''; unavailable = !!s.unavailable; }
    else { status = 'error'; message = (s && s.message) || 'Unknown error'; errCode = s.code || null; }
    render();
  }

  async function load() {
    if (isToday()) return loadToday();
    const mine = ++seq;
    const per = period;
    const cur = range;
    const key = keyOf();
    const prev = previousRange(per, cur);
    if (key !== statusKey) { status = cache.has(key) ? 'ok' : 'loading'; message = ''; statusKey = key; }
    render();
    const [a, b] = await Promise.all([safeUsage(cur.from, cur.to), safeUsage(prev.from, prev.to)]);
    if (!alive) return;
    if (a.ok && Array.isArray(a.days)) {
      const old = cache.get(key);
      cache.set(key, { v: ++version, days: a.days, prevDays: b.ok && Array.isArray(b.days) ? b.days : (old ? old.prevDays : null), at: now() });
    }
    if (mine !== seq) return; // a newer request has taken over
    errCode = null; unavailable = false;
    if (a.ok && Array.isArray(a.days)) { status = 'ok'; message = ''; }
    else if (a.down) { status = 'down'; message = a.message || ''; unavailable = !!a.unavailable; }
    else { status = 'error'; message = (a && a.message) || 'Unknown error'; errCode = a.code || null; }
    render();
  }

  // ---- drill-down ----
  const detailKept = (day) => day >= addDays(todayKey(), -(KEEP_DETAIL_DAYS - 1));
  function hourOf(sec) { const local = Math.floor(sec) + tzOffsetAt(sec * 1000) * 60; return Math.floor((((local % 86400) + 86400) % 86400) / 3600); }

  function openDrill(name, kind) {
    const entry = cache.get(keyOf());
    if (!entry || !entry.days) return;
    drill = { name, kind };
    const info = appDrilldown(entry.days, name, kind);
    const last = todayKey() < range.to ? todayKey() : range.to;
    drillDay = info.daily.length ? info.daily[info.daily.length - 1].day : last;
    view = 'drill'; focusNext = 'drill-back';
    loadDrillDay();
  }
  function closeDrill() {
    focusNext = drill ? `${drill.kind}-${drill.name}` : null;
    dseq++; view = 'main'; drill = null; drillDay = null; dstatus = 'idle'; dmessage = '';
    dcache.clear();
    render();
  }
  async function loadDrillDay() {
    const mine = ++dseq;
    const day = drillDay;
    dmessage = '';
    if (!detailKept(day)) { dstatus = 'idle'; render(); return; }
    dstatus = dcache.has(day) ? 'ok' : 'loading';
    render();
    const res = await safeSessions(day);
    if (!alive || mine !== dseq) return; // closed, or a newer day was asked for
    if (res.ok && Array.isArray(res.stretches)) {
      dcache.set(day, { v: ++version, stretches: res.stretches, truncated: !!res.truncated, at: now() });
      dstatus = 'ok';
    } else if (res.down) { dstatus = 'down'; dmessage = res.message || ''; }
    else { dstatus = 'error'; dmessage = (res && res.message) || 'Unknown error'; }
    render();
  }
  function moveDrillDay(delta) {
    const next = addDays(drillDay, delta);
    if (next > todayKey()) return;
    drillDay = next;
    loadDrillDay();
  }

  function itemStretches(stretches) {
    const want = drill.name.toLowerCase();
    return stretches.filter((s) => s && (drill.kind === 'site'
      ? s.site != null && String(s.site).toLowerCase() === want
      : String(s.exe).toLowerCase() === want));
  }

  function drillTimeline(info) {
    const sec = section('Timeline');
    const today = todayKey();
    sec.append(h('div', { class: 'fr-drillnav' },
      h('button', { type: 'button', class: 'fr-pbtn fr-arrow', 'aria-label': 'Previous day', 'data-fk': 'drill-prev', onclick: () => moveDrillDay(-1) }, '‹'),
      h('span', { class: 'fr-windowlabel', 'data-fk': 'drill-day', 'aria-live': 'polite' }, `${weekdayName(drillDay)} ${short(drillDay)}, ${parts(drillDay).y}`),
      (() => { const b = h('button', { type: 'button', class: 'fr-pbtn fr-arrow', 'aria-label': 'Next day', 'data-fk': 'drill-next', onclick: () => { if (!b.disabled) moveDrillDay(1); } }, '›'); b.disabled = drillDay >= today; return b; })()));
    if (!detailKept(drillDay)) {
      sec.append(h('p', { class: 'fr-statnote', 'data-fk': 'drill-notkept' }, `Detailed timeline is kept for ${KEEP_DETAIL_DAYS} days.`));
      return sec;
    }
    const data = dcache.get(drillDay);
    if (!data) {
      if (dstatus === 'down') sec.append(h('p', { class: 'fr-statnote', role: 'status' }, "The helper isn't running, so the timeline can't be loaded."));
      else if (dstatus === 'error') sec.append(h('p', { class: 'fr-statnote fr-err-box', role: 'alert', 'data-fk': 'drill-error' }, `Couldn't load this day: ${dmessage || 'Unknown error'}`));
      else sec.append(h('p', { class: 'fr-statnote', role: 'status' }, 'Loading timeline…'));
      return sec;
    }
    if (dstatus === 'down') sec.append(h('p', { class: 'fr-statnote fr-warn', role: 'status' }, `Showing the last data from ${formatClock(data.at, now())}. The helper isn't running.`));
    else if (dstatus === 'error') sec.append(h('p', { class: 'fr-statnote fr-err-box', role: 'alert', 'data-fk': 'drill-error' }, `Couldn't refresh this day: ${dmessage || 'Unknown error'}`));
    if (data.truncated) sec.append(h('p', { class: 'fr-statnote fr-warn', role: 'status', 'data-fk': 'truncated' }, `Timeline incomplete after ${data.stretches.length} stretches; totals are complete.`));
    const mine = itemStretches(data.stretches);
    const from = dayStartSec(drillDay);
    const to = dayStartSec(addDays(drillDay, 1));
    const blocks = timelineWindow(mine, from, to);
    if (!blocks.length) {
      sec.append(h('p', { class: 'fr-statnote', 'data-fk': 'drill-none' }, `No time recorded for ${drill.name} on this day.`));
      return sec;
    }
    const label = drill.kind === 'site' ? drill.name : programName(drill.name);
    const strip = timelineStrip(blocks, { fromSec: from, toSec: to, colorOf: () => 0, timeLabel, offsetSec: tzOffsetAt(from * 1000) * 60, nameOf: () => label });
    sec.append(h('div', { class: 'fr-chart-scroll', 'data-fk': 'strip' }, strip, timelineLegend([label], () => 0)));
    return sec;
  }

  function drillView(entry) {
    const info = appDrilldown(entry.days, drill.name, drill.kind);
    const out = h('div', { class: 'fr-statbody' });
    const num = (v) => (Number.isFinite(v) ? v : 0);
    const has = num(info.total) > 0;
    const pct = Math.round(num(info.shareOfTotal) * 100);
    const data = dcache.get(drillDay);
    const peak = data && detailKept(drillDay) ? itemPeakHour(data.stretches, drill.name, drill.kind, hourOf) : null;
    out.append(h('p', { class: 'fr-muted fr-small', 'data-fk': 'drill-range' }, `${drill.kind === 'site' ? 'Website' : 'App'} · ${rangeLabel(navPeriod(), range, todayKey())}`));
    out.append(h('div', { class: 'fr-statcards' },
      card('Total', has ? formatDuration(info.total) : '—'),
      card('Active days', has ? String(info.activeDays) : '—'),
      card('Average per active day', has ? formatDuration(info.perActiveDay) : '—'),
      card('Share of total', has ? (info.shareOfTotal > 0 && pct === 0 ? '<1%' : `${pct}%`) : '—'),
      card('Peak hour', peak == null ? '—' : `${p2(peak)}:00`)));
    out.append(section('Daily trend', h('div', { class: 'fr-chart-scroll' }, dailyTrendBars(info.daily))));
    out.append(drillTimeline(info));
    if (info.sites.length) {
      const sec = section('Sites used');
      if (info.sitesApproximate) sec.append(h('p', { class: 'fr-muted fr-small', 'data-fk': 'drill-approx' }, 'approximate: several browsers used'));
      sec.append(h('ul', { class: 'fr-avglist', 'data-fk': 'drill-sites', 'aria-label': 'Sites used' }, ...info.sites.slice(0, 20).map((x) =>
        h('li', {}, h('span', {}, x.name), h('strong', {}, formatDuration(x.secs))))));
      out.append(sec);
    }
    return out;
  }

  // ---- view pieces ----
  function periodSwitch() {
    return h('div', { class: 'fr-period', role: 'group', 'aria-label': 'Period' },
      PERIODS.map(([id, label]) => h('button', {
        type: 'button', class: `fr-pbtn${id === period ? ' fr-on' : ''}`, 'aria-pressed': id === period ? 'true' : 'false', 'data-fk': `p-${id}`,
        onclick: () => { period = id; range = rangeFor(id === 'today' ? 'day' : id, todayKey()); load(); },
      }, label)));
  }

  function rangeNav() {
    const today = todayKey();
    const prevBtn = h('button', {
      type: 'button', class: 'fr-pbtn fr-arrow', 'aria-label': 'Previous period', 'data-fk': 'prev',
      onclick: () => { range = shiftRange(navPeriod(), range, -1); load(); },
    }, '‹');
    const nextBtn = h('button', {
      type: 'button', class: 'fr-pbtn fr-arrow', 'aria-label': 'Next period', 'data-fk': 'next',
      onclick: () => { if (nextBtn.disabled) return; range = shiftRange(navPeriod(), range, 1); load(); },
    }, '›');
    nextBtn.disabled = shiftRange(navPeriod(), range, 1).from > today; // never into the future
    return h('div', { class: 'fr-rangenav' }, prevBtn, h('span', { class: 'fr-rangelabel', 'aria-live': 'polite' }, rangeLabel(navPeriod(), range, today)), nextBtn);
  }

  function card(label, value, sub) {
    return h('div', { class: 'fr-statcard' },
      h('div', { class: 'fr-statlabel' }, label),
      h('div', { class: 'fr-statvalue' }, value),
      sub ? h('div', { class: 'fr-statsub fr-muted' }, sub) : null);
  }

  function deltaCard(sum, entry, today) {
    const word = PREVIOUS_WORD[period];
    if (!entry.prevDays) return card('vs previous', '—', 'The previous period could not be loaded');
    const prev = summarize(entry.prevDays, previousRange(period, range), today);
    const d = deltaVs(prev.total, sum.total);
    if (d.direction === 'none') return card('vs previous', '—', `Nothing recorded ${word}`);
    if (d.direction === 'same') return card('vs previous', 'No change', `Same as ${word}`);
    const up = d.direction === 'up';
    return card('vs previous', `${up ? '▲ +' : '▼ −'}${Math.abs(d.pct)}%`, `${up ? 'More' : 'Less'} than ${word} (${formatDuration(prev.total)})`);
  }

  function section(title, ...kids) {
    return h('section', { class: 'fr-statsec' }, h('h3', {}, title), ...kids);
  }

  function dataView(entry) {
    const today = todayKey();
    const sum = summarize(entry.days, range, today);
    if (!(sum.total > 0)) return h('p', { class: 'fr-statnote', 'data-fk': 'empty' }, 'No usage recorded yet for this period');
    const out = h('div', { class: 'fr-statbody' });
    out.append(h('div', { class: 'fr-statcards' },
      card('Total', formatDuration(sum.total)),
      card('Daily average', formatDuration(sum.dailyAverage), `${sum.activeDays} active ${sum.activeDays === 1 ? 'day' : 'days'}`),
      card('Most-used app', sum.topApp ? sum.topApp.name : '—', sum.topApp ? formatDuration(sum.topApp.secs) : ''),
      deltaCard(sum, entry, today)));
    out.append(h('div', { class: 'fr-chart-tools' },
      h('button', { type: 'button', class: 'fr-pbtn', 'aria-pressed': asTable ? 'true' : 'false', 'data-fk': 'table', onclick: () => { asTable = !asTable; render(); } },
        asTable ? 'Show as chart' : 'Show as table')));
    const weekdayRows = WEEKDAYS.map((name, i) => ({ name, secs: sum.perWeekday[i] }));
    if (asTable) {
      out.append(section('Daily totals', dataTable(sum.perDay, [{ key: 'day', label: 'Day' }, { key: 'total', label: 'Total', format: formatDuration }], 'Daily totals')));
      if (period !== 'day') out.append(section('Average by weekday', dataTable(weekdayRows, [{ key: 'name', label: 'Weekday' }, { key: 'secs', label: 'Average', format: formatDuration }], 'Average by weekday')));
    } else {
      out.append(section('Daily totals', stackedDailyBars(sum.perDay), chartLegend(topAppNames(sum.perDay))));
      if (period === 'year') out.append(section('Year at a glance', h('div', { class: 'fr-chart-scroll' }, yearHeatmap(sum.perDay, parts(range.from).y))));
      if (period !== 'day') out.append(section('Average by weekday', weekdayBars(sum.perWeekday)));
    }
    out.append(section('Top apps', rankedBars(sum.topApps.slice(0, 10), { onOpen: (n) => openDrill(n, 'app'), fkPrefix: 'app' })));
    const sites = section('Top sites', h('p', { class: 'fr-muted fr-small' }, 'Estimated from browser tab titles'));
    if (sum.topSites.length) {
      sites.append(rankedBars(sum.topSites.slice(0, 10), { onOpen: (n) => openDrill(n, 'site'), fkPrefix: 'site' }), h('p', { class: 'fr-muted fr-small' }, 'Percentages are of identified sites.'));
    } else {
      sites.append(h('p', { class: 'fr-chart-empty' }, 'No websites identified in this period.'));
    }
    if (sum.otherBrowsing > 0) sites.append(h('p', { class: 'fr-otherline' }, `Other browsing: ${formatDuration(sum.otherBrowsing)}`));
    out.append(sites);
    out.append(hoursSection(entry, today), averagesSection(entry, today));
    return out;
  }

  // ---- hour-of-day and averages ----
  const dayCount = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;
  function hoursSection(entry, today) {
    const avg = hourlyAverages(entry.days);
    const sec = section('Hours of the day');
    if (!(avg.daysCounted > 0)) {
      sec.append(h('p', { class: 'fr-statnote', 'data-fk': 'no-hours' }, 'Hour detail is recorded from the update onwards'));
      return sec;
    }
    const last = today < range.to ? today : range.to;
    const elapsed = last < range.from ? 0 : Math.round((Date.parse(last) - Date.parse(range.from)) / 86400000) + 1;
    let caption = `Based on ${dayCount(avg.daysCounted)} with hour data`;
    if (elapsed > avg.daysCounted) caption += ` (${avg.daysCounted} of ${elapsed} days)`;
    sec.append(h('p', { class: 'fr-muted fr-small', 'data-fk': 'hours-caption' }, caption));
    if (asTable) {
      const rows = avg.hours.map((secs, i) => ({ hour: `${p2(i)}:00`, secs }));
      sec.append(dataTable(rows, [{ key: 'hour', label: 'Hour' }, { key: 'secs', label: 'Average', format: formatDuration }], 'Hours of the day'));
      return sec;
    }
    sec.append(hourBars(avg.hours, avg.daysCounted));
    if (period !== 'day') sec.append(h('div', { class: 'fr-chart-scroll' }, weekdayHourHeatmap(weekdayHourGrid(entry.days).grid)));
    return sec;
  }

  function averagesSection(entry, today) {
    const a = periodAverages(entry.days, range, today);
    const dur = (v) => (v == null || !Number.isFinite(v) ? '—' : formatDuration(v));
    const items = [
      ['avg-day', 'Per day', dur(a.perDay), ''],
      ['avg-week', 'Per week', dur(a.perWeek), a.perWeek == null ? 'needs 7 days' : ''],
      ['avg-month', 'Per month', dur(a.perMonth), a.perMonth == null ? 'needs 28 days' : '']];
    const sec = section('Averages');
    if (asTable) {
      sec.append(dataTable(items.map(([, label, value, hint]) => ({ label, value: hint ? `${value} (${hint})` : value })), [{ key: 'label', label: 'Average' }, { key: 'value', label: 'Value' }], 'Averages'));
      sec.append(dataTable(WEEKDAYS.map((name, i) => ({ name, secs: a.perWeekday[i] })), [{ key: 'name', label: 'Weekday' }, { key: 'secs', label: 'Average', format: formatDuration }], 'Average per weekday'));
      sec.append(dataTable(a.perApp.slice(0, 10), [{ key: 'name', label: 'App' }, { key: 'perActiveDay', label: 'Per active day', format: formatDuration }, { key: 'activeDays', label: 'Active days' }], 'Apps by average per active day'));
      return sec;
    }
    sec.append(h('ul', { class: 'fr-avglist', 'aria-label': 'Averages' }, ...items.map(([fk, label, value, hint]) =>
      h('li', { 'data-fk': fk }, h('span', {}, label), h('strong', {}, value), hint ? h('span', { class: 'fr-muted fr-small' }, hint) : null))));
    sec.append(h('ul', { class: 'fr-avglist', 'aria-label': 'Average per weekday' }, ...WEEKDAYS.map((name, i) =>
      h('li', { 'data-fk': `avg-wd-${name}` }, h('span', {}, name), h('strong', {}, formatDuration(a.perWeekday[i]))))));
    if (a.perApp.length) {
      sec.append(h('h4', {}, 'Apps by average per active day'),
        h('ol', { class: 'fr-avglist', 'aria-label': 'Apps by average per active day' }, ...a.perApp.slice(0, 10).map((app) =>
          h('li', { 'data-fk': `avg-app-${app.name}` }, h('span', {}, h('button', { type: 'button', class: 'fr-linkbtn', 'data-fk': `app-${app.name}`, onclick: () => openDrill(app.name, 'app') }, app.name)), h('strong', {}, formatDuration(app.perActiveDay)),
            h('span', { class: 'fr-muted fr-small' }, `${dayCount(app.activeDays)} active`)))));
    }
    return sec;
  }

  // ---- Today view ----
  function windowFor(entry) {
    const day = range.from;
    const start = dayStartSec(day);
    const end = dayStartSec(addDays(day, 1));
    const dayLen = end - start;
    const z = ZOOMS.find((q) => q[0] === zoom) || ZOOMS[0];
    const winLen = z[2] > 0 && z[2] < dayLen ? z[2] : dayLen;
    if (winLen >= dayLen) return { start, end, winLen: dayLen, dayLen, from: start, to: end, off: 0 };
    const maxOff = dayLen - winLen;
    let off = panOff;
    if (!(Number.isFinite(off))) {
      const nowSec = Math.floor(now() / 1000);
      if (nowSec >= start && nowSec < end) off = nowSec - start - winLen;
      else { const m = focusMetrics(entry.stretches); off = m.firstStart != null ? Math.floor((m.firstStart - start) / 3600) * 3600 : 0; }
    }
    off = Math.min(maxOff, Math.max(0, Math.floor(off)));
    return { start, end, winLen, dayLen, from: start + off, to: start + off + winLen, off };
  }

  function colorMap(stretches) {
    const secs = new Map();
    for (const s of stretches) if (s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start) secs.set(s.exe, (secs.get(s.exe) || 0) + s.end - s.start);
    const order = [...secs].sort((a, b) => b[1] - a[1] || (String(a[0]) < String(b[0]) ? -1 : 1)).map((e) => e[0]);
    return { order, idx: new Map(order.map((e, i) => [e, Math.min(5, i)])) };
  }

  function stripPieces(entry) {
    const w = windowFor(entry);
    const cm = colorMap(entry.stretches);
    const blocks = timelineWindow(entry.stretches, w.from, w.to);
    const shown = new Set(blocks.map((b) => b.exe));
    const names = []; const nameIdx = new Map();
    for (const exe of cm.order) {
      if (!shown.has(exe)) continue;
      const n = programName(exe);
      if (!nameIdx.has(n)) { nameIdx.set(n, cm.idx.get(exe)); names.push(n); }
    }
    const strip = timelineStrip(blocks, { fromSec: w.from, toSec: w.to, colorOf: (exe) => cm.idx.get(exe) || 0, timeLabel, offsetSec: tzOffsetAt(w.from * 1000) * 60 });
    const label = `${timeLabel(w.from)} to ${w.to === w.end ? '24:00:00' : timeLabel(w.to)}`;
    return { w, strip, label, legend: timelineLegend(names, (n) => nameIdx.get(n) || 0) };
  }

  function updateStrip(entry) {
    if (!stripHost) return;
    const p = stripPieces(entry);
    stripHost.textContent = '';
    stripHost.append(p.strip, p.legend);
    if (windowEl) windowEl.textContent = p.label;
  }

  function stretchTable(entry) {
    const list = entry.stretches.filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start).sort((a, b) => a.start - b.start);
    const rows = list.slice(0, TABLE_CAP).map((s) => ({ start: timeLabel(s.start), end: timeLabel(s.end), dur: formatDurationSecs(s.end - s.start), program: programName(s.exe), site: s.site || '' }));
    const out = h('div', {});
    out.append(dataTable(rows, [{ key: 'start', label: 'Start' }, { key: 'end', label: 'End' }, { key: 'dur', label: 'Duration' }, { key: 'program', label: 'Program' }, { key: 'site', label: 'Site' }], 'Stretches'));
    if (list.length > TABLE_CAP) out.append(h('p', { class: 'fr-muted fr-small', 'data-fk': 'table-cap' }, `Showing first ${TABLE_CAP} of ${list.length} stretches`));
    return out;
  }

  function todayView(entry) {
    const total = Number.isFinite(entry.total) ? entry.total : 0;
    const m = focusMetrics(entry.stretches);
    const out = h('div', { class: 'fr-statbody' });
    if (!entry.stretches.length && !(total > 0)) return h('p', { class: 'fr-statnote', 'data-fk': 'empty' }, 'No usage recorded yet for this period');
    if (!entry.stretches.length) {
      out.append(h('p', { class: 'fr-statnote', 'data-fk': 'no-detail' }, 'Detailed timeline not available for this day; daily totals only.'),
        h('div', { class: 'fr-statcards' }, card('Active time', formatDurationSecs(total))));
      return out;
    }
    if (entry.truncated) out.append(h('p', { class: 'fr-statnote fr-warn', role: 'status', 'data-fk': 'truncated' }, `Timeline incomplete after ${entry.stretches.length} stretches; totals are complete.`));
    const sk = streak ? activeStreaks(streak.days, todayKey()) : null;
    const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;
    const active = entry.truncated && total > 0 ? total : m.activeSecs;
    out.append(h('div', { class: 'fr-statcards' },
      card('Active time', formatDurationSecs(active)),
      card('Longest stretch', m.longestStretchSecs > 0 ? formatDurationSecs(m.longestStretchSecs) : '—', m.longestStretchExe != null ? programName(m.longestStretchExe) : ''),
      card('Switches per active hour', Number.isFinite(m.switchesPerActiveHour) ? m.switchesPerActiveHour.toFixed(1) : '—'),
      card('First activity', m.firstStart != null ? timeLabel(m.firstStart) : '—'),
      card('Last activity', m.lastEnd != null ? timeLabel(m.lastEnd) : '—'),
      card('Current streak', sk ? days(sk.current) : '—'),
      card('Best streak', sk ? days(sk.best) : '—')));
    out.append(h('div', { class: 'fr-chart-tools' },
      h('button', { type: 'button', class: 'fr-pbtn', 'aria-pressed': asTable ? 'true' : 'false', 'data-fk': 'table', onclick: () => { asTable = !asTable; render(); } },
        asTable ? 'Show as chart' : 'Show as table')));
    if (asTable) { out.append(section('Timeline', stretchTable(entry))); return out; }
    const p = stripPieces(entry);
    windowEl = h('span', { class: 'fr-windowlabel', 'data-fk': 'window', 'aria-live': 'polite' }, p.label);
    stripHost = h('div', { class: 'fr-chart-scroll', 'data-fk': 'strip' }, p.strip, p.legend);
    const zoomBar = h('div', { class: 'fr-period', role: 'group', 'aria-label': 'Zoom' },
      ZOOMS.map(([id, label]) => h('button', {
        type: 'button', class: `fr-pbtn${id === zoom ? ' fr-on' : ''}`, 'aria-pressed': id === zoom ? 'true' : 'false', 'data-fk': `zoom-${id}`,
        onclick: () => { zoom = id; panOff = null; render(); },
      }, label)));
    const sec = section('Timeline', zoomBar, windowEl);
    if (p.w.winLen < p.w.dayLen) {
      const pan = h('input', { type: 'range', min: 0, max: p.w.dayLen - p.w.winLen, step: 60, value: p.w.off, class: 'fr-pan', 'data-fk': 'pan', 'aria-label': 'Scroll the timeline',
        oninput: () => { const v = Number(pan.value); if (Number.isFinite(v)) { panOff = v; updateStrip(entry); lastSig = signature(); } } });
      pan.value = String(p.w.off);
      sec.append(pan);
    }
    sec.append(stripHost);
    out.append(sec);
    return out;
  }

  const entryHasData = (entry) => (entry.today
    ? entry.stretches.length > 0 || entry.total > 0
    : summarize(entry.days, range, todayKey()).total > 0);

  const OFF_HINT = 'Usage tracking runs from a small program that starts when you sign in. If you just installed or updated the helper, sign out and back in.';
  function stateView() {
    const entry = cache.get(keyOf());
    const hasData = !!entry && entryHasData(entry);
    if (trackingOff() && entry && !hasData) {
      return h('div', { class: 'fr-statnote', 'data-fk': 'off' },
        h('strong', {}, 'Usage tracking is off'),
        h('p', {}, 'Usage is only tracked by the Windows helper, and it is not tracking on this device right now.'),
        h('p', {}, OFF_HINT));
    }
    const view = baseView(entry);
    if (!(trackingOff() && hasData)) return view;
    const out = h('div', {});
    out.append(h('p', { class: 'fr-statnote fr-warn', role: 'status', 'data-fk': 'off-banner' },
      `Not tracking right now. ${OFF_HINT} History below is from earlier.`), view);
    return out;
  }

  function baseView(entry) {
    if (!entry) {
      if (status === 'down') {
        if (unavailable || helperKind() === 'unavailable') {
          return h('div', { class: 'fr-statnote', 'data-fk': 'down' }, h('strong', {}, 'Usage is only available in the desktop app.'));
        }
        return h('div', { class: 'fr-statnote', 'data-fk': 'down' },
          h('strong', {}, "The helper isn't running"),
          h('p', {}, 'Usage comes from the Focus Room helper, so there is nothing to show yet. Install the helper (run the MyBrain installer) or, if it is installed, start the MyBrainFocus service. This page fills in once it is running.'));
      }
      if (status === 'error') return errorView();
      return h('p', { class: 'fr-statnote', role: 'status' }, 'Loading usage…');
    }
    const out = h('div', {});
    if (status === 'down') {
      out.append(h('p', { class: 'fr-statnote fr-warn', role: 'status' }, `Showing the last data from ${formatClock(entry.at, now())}. The helper isn't running.`));
    } else if (status === 'error') {
      out.append(errorView());
    }
    out.append(entry.today ? todayView(entry) : dataView(entry));
    return out;
  }

  function errorView() {
    if (errCode === 'bad-request') {
      return h('div', { class: 'fr-statnote fr-err-box', role: 'alert', 'data-fk': 'error' },
        h('strong', {}, "This helper version doesn't report usage yet. Update the helper."));
    }
    return h('div', { class: 'fr-statnote fr-err-box', role: 'alert', 'data-fk': 'error' },
      h('strong', {}, "Couldn't load usage"),
      h('p', {}, message || 'Unknown error'),
      h('button', { type: 'button', class: 'fr-retry', 'data-fk': 'retry', onclick: () => { if (status === 'loading') return; status = 'loading'; message = ''; load(); } }, 'Retry'));
  }

  function signature() {
    const entry = cache.get(keyOf());
    return JSON.stringify([period, range, asTable, zoom, panOff, streak ? streak.v : 0, status, message, errCode, unavailable, trackingOff(), helperKind(), todayKey(), entry ? [entry.v, status === 'down' ? entry.at : 0] : null,
      view, drill, drillDay, dstatus, dmessage, dcache.has(drillDay) ? [dcache.get(drillDay).v, dstatus === 'down' ? dcache.get(drillDay).at : 0] : null]);
  }

  function render() {
    if (!alive) return;
    const sig = signature();
    if (sig === lastSig) return;
    lastSig = sig;
    const active = focusNext || (typeof document !== 'undefined' && document.activeElement && document.activeElement.getAttribute
      ? document.activeElement.getAttribute('data-fk') : null);
    focusNext = null;
    const drilling = view === 'drill' && drill && cache.get(keyOf()) && cache.get(keyOf()).days;
    const page = drilling
      ? h('div', { class: 'page fr-home fr-stats' },
        h('div', { class: 'fr-head' },
          h('button', { type: 'button', class: 'fr-back', 'data-fk': 'drill-back', onclick: closeDrill }, '← Back'),
          h('h2', {}, drill.name)),
        drillView(cache.get(keyOf())))
      : h('div', { class: 'page fr-home fr-stats' },
        h('div', { class: 'fr-head' },
          h('button', { type: 'button', class: 'fr-back', 'data-fk': 'back', onclick: () => deps.onBack && deps.onBack() }, '← Back'),
          h('h2', {}, 'Stats')),
        h('div', { class: 'fr-statbar' }, periodSwitch(), rangeNav()),
        stateView());
    root.textContent = '';
    root.append(page);
    if (active) {
      const again = (function find(n) {
        if (n.getAttribute && n.getAttribute('data-fk') === active) return n;
        for (const c of n.children || []) { const f = find(c); if (f) return f; }
        return null;
      }(page));
      if (again && !again.disabled) again.focus();
    }
  }

  // ---- wiring ----
  let lastTracking = trackingOff();
  let lastKind = helperKind();
  const unsubscribe = deps.subscribe ? deps.subscribe(() => {
    if (!alive) return;
    const tracking = trackingOff();
    const kind = helperKind();
    const recovered = (lastTracking && !tracking) || (lastKind !== 'ok' && kind === 'ok' && (status === 'down' || status === 'error' || !cache.has(keyOf())));
    lastTracking = tracking; lastKind = kind;
    if (recovered) load(); else render();
  }) : () => {};
  const timers = [
    setInterval(() => { try { Promise.resolve(controller.refreshStatus && controller.refreshStatus()).catch(() => {}); } catch { /* ignore */ } }, 5000),
    setInterval(() => { if (alive) load(); }, REFRESH_MS)];

  load();

  return () => {
    alive = false;
    seq++;
    try { unsubscribe(); } catch { /* ignore */ }
    for (const id of timers) clearInterval(id);
    root.textContent = '';
  };
}
