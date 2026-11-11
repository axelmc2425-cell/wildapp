import { h } from './dom.js';
import { formatClock } from './util.js';
import { makeTzOffsetAt } from '../tz.js';
import { dayKey, rangeFor, previousRange, shiftRange, summarize, deltaVs, formatDuration } from '../stats.js';
import { stackedDailyBars, chartLegend, topAppNames, weekdayBars, yearHeatmap, rankedBars, dataTable } from './charts.js';

const PERIODS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
const PREVIOUS_WORD = { day: 'yesterday', week: 'last week', month: 'last month', year: 'last year' };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const REFRESH_MS = 60000;

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
  let asTable = false;
  let status = 'loading'; // 'loading' | 'ok' | 'down' | 'error'
  let message = '';
  let errCode = null;
  let unavailable = false;
  let version = 0; // bumps with every stored result, so the render signature never serialises day data
  let seq = 0; // newest request wins
  let statusKey = null; // the range key `status` describes
  let lastSig = null;
  const cache = new Map(); // `${period}:${from}:${to}` -> { days, prevDays|null, at }
  const keyOf = () => `${period}:${range.from}:${range.to}`;

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

  async function load() {
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

  // ---- view pieces ----
  function periodSwitch() {
    return h('div', { class: 'fr-period', role: 'group', 'aria-label': 'Period' },
      PERIODS.map(([id, label]) => h('button', {
        type: 'button', class: `fr-pbtn${id === period ? ' fr-on' : ''}`, 'aria-pressed': id === period ? 'true' : 'false', 'data-fk': `p-${id}`,
        onclick: () => { period = id; range = rangeFor(id, todayKey()); load(); },
      }, label)));
  }

  function rangeNav() {
    const today = todayKey();
    const prevBtn = h('button', {
      type: 'button', class: 'fr-pbtn fr-arrow', 'aria-label': 'Previous period', 'data-fk': 'prev',
      onclick: () => { range = shiftRange(period, range, -1); load(); },
    }, '‹');
    const nextBtn = h('button', {
      type: 'button', class: 'fr-pbtn fr-arrow', 'aria-label': 'Next period', 'data-fk': 'next',
      onclick: () => { if (nextBtn.disabled) return; range = shiftRange(period, range, 1); load(); },
    }, '›');
    nextBtn.disabled = shiftRange(period, range, 1).from > today; // never into the future
    return h('div', { class: 'fr-rangenav' }, prevBtn, h('span', { class: 'fr-rangelabel', 'aria-live': 'polite' }, rangeLabel(period, range, today)), nextBtn);
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
    out.append(section('Top apps', rankedBars(sum.topApps.slice(0, 10))));
    const sites = section('Top sites', h('p', { class: 'fr-muted fr-small' }, 'Estimated from browser tab titles'));
    if (sum.topSites.length) {
      sites.append(rankedBars(sum.topSites.slice(0, 10)), h('p', { class: 'fr-muted fr-small' }, 'Percentages are of identified sites.'));
    } else {
      sites.append(h('p', { class: 'fr-chart-empty' }, 'No websites identified in this period.'));
    }
    if (sum.otherBrowsing > 0) sites.append(h('p', { class: 'fr-otherline' }, `Other browsing: ${formatDuration(sum.otherBrowsing)}`));
    out.append(sites);
    return out;
  }

  const OFF_HINT = 'Usage tracking runs from a small program that starts when you sign in. If you just installed or updated the helper, sign out and back in.';
  function stateView() {
    const entry = cache.get(keyOf());
    const hasData = !!entry && summarize(entry.days, range, todayKey()).total > 0;
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
    out.append(dataView(entry));
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
    return JSON.stringify([period, range, asTable, status, message, errCode, unavailable, trackingOff(), helperKind(), todayKey(), entry ? [entry.v, status === 'down' ? entry.at : 0] : null]);
  }

  function render() {
    if (!alive) return;
    const sig = signature();
    if (sig === lastSig) return;
    lastSig = sig;
    const active = typeof document !== 'undefined' && document.activeElement && document.activeElement.getAttribute
      ? document.activeElement.getAttribute('data-fk') : null;
    const page = h('div', { class: 'page fr-home fr-stats' },
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
