import { registerModule } from '../../shell/modules.js';
import { h } from '../../ui/dom.js';
import { defaultScenario, simulate, compare, buyHouse, changeJob, partTime, addEvent } from './montecarlo.js';
import { fanChart, formatMoney } from './chart.js';
import { saveScenario, listScenarios, deleteScenario, moneySearch } from './repo.js';

const FIELDS = [
  ['liquid', 'Savings & investments now ($)', 1000], ['annualIncome', 'Yearly income after tax ($)', 1000],
  ['annualSpending', 'Yearly spending ($)', 1000], ['expectedReturn', 'Expected investment return (%/yr)', 0.5],
  ['volatility', 'Volatility (% swing per year)', 1], ['inflation', 'Inflation (%/yr)', 0.1],
  ['incomeGrowth', 'Income growth (%/yr)', 0.1], ['goal', 'Goal: net worth ($)', 10000], ['horizonYears', 'Years to look ahead', 1],
];
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
};
const pct = (x) => `${Math.round(x * 100)}%`;
const SIM = { trials: 1500, seed: 11 };

async function render(root, ctx) {
  const db = ctx.db;
  let scenarios = await listScenarios(db);
  if (!scenarios.length) scenarios = [await saveScenario(db, defaultScenario())];
  const state = { id: Number(ctx.route()[0]) || scenarios[0].id, compareId: 0 };
  if (!scenarios.some(s => s.id === state.id)) state.id = scenarios[0].id;
  let timer = null;
  const listEl = h('ul', { class: 'list' });
  const editEl = h('div', {});
  const resultEl = h('div', {});

  const current = () => scenarios.find(s => s.id === state.id);

  async function persist(s) {
    const saved = await saveScenario(db, s);
    scenarios = scenarios.map(x => (x.id === saved.id ? saved : x));
    return saved;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => { await persist(current()); paintResult(); }, 250);
  }

  function paintList() {
    listEl.innerHTML = '';
    for (const s of scenarios) {
      listEl.append(h('li', { style: 'cursor:pointer;' + (s.id === state.id ? 'font-weight:600' : ''), onclick: () => { state.id = s.id; paintAll(); } },
        h('span', { class: 'grow' }, s.name), s.id === scenarios[0].id ? h('span', { class: 'pill' }, 'baseline') : null));
    }
  }

  function numField(s, [key, label, step]) {
    const i = h('input', { type: 'number', step: String(step), value: String(s[key]), style: 'width:100%' });
    i.addEventListener('input', () => {
      const v = Number(i.value);
      if (Number.isFinite(v)) { s[key] = key === 'horizonYears' ? Math.max(1, Math.min(60, Math.round(v))) : v; schedule(); }
    });
    return h('label', { class: 'field' }, label, i);
  }

  function presetForm(title, fields, apply) {
    const inputs = fields.map(([label, value]) => h('input', { type: 'number', value: String(value), style: 'width:100%', 'aria-label': label }));
    const box = h('div', { class: 'card', style: 'margin-top:8px' }, h('b', {}, title),
      ...fields.map(([label], i) => h('label', { class: 'field' }, label, inputs[i])),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => { await persist(apply(current(), inputs.map(i => Number(i.value)))); scenarios = await listScenarios(db); paintAll(); } }, 'Add'),
        h('button', { onclick: () => box.remove() }, 'Cancel')));
    return box;
  }

  function paintEdit() {
    const s = current();
    editEl.innerHTML = '';
    const name = h('input', { type: 'text', value: s.name, style: 'width:100%', 'aria-label': 'Scenario name' });
    name.addEventListener('input', () => { s.name = name.value; schedule(); paintList(); });
    const forms = h('div', {});
    const mods = [
      ...s.assets.map((a, i) => ({ text: `Asset: ${a.name} ${formatMoney(a.value)} (+${a.growth}%/yr)`, remove: () => s.assets.splice(i, 1) })),
      ...s.debts.map((d, i) => ({ text: `Loan: ${d.name} ${formatMoney(d.balance)} at ${d.rate}% for ${d.years} yrs`, remove: () => s.debts.splice(i, 1) })),
      ...s.changes.map((c, i) => ({ text: `${c.label} from year ${c.fromYear}: income ${c.incomeDelta >= 0 ? '+' : ''}${formatMoney(c.incomeDelta)}/yr`, remove: () => s.changes.splice(i, 1) })),
      ...s.events.map((e, i) => ({ text: `Year ${e.year}: ${e.label} ${e.amount >= 0 ? '+' : ''}${formatMoney(e.amount)}`, remove: () => s.events.splice(i, 1) })),
    ];
    const isBase = s.id === scenarios[0].id;
    editEl.append(
      h('div', { class: 'card' }, h('h3', {}, 'Scenario'), h('label', { class: 'field' }, 'Name', name),
        h('div', { class: 'grid2' }, ...FIELDS.map(f => numField(s, f)))),
      h('div', { class: 'card' }, h('h3', {}, 'What if…'),
        h('p', { class: 'sub' }, isBase ? 'Tip: copy the baseline first, then add what-ifs to the copy so you can compare.' : 'Add changes to this scenario and compare it with your baseline.'),
        h('div', { class: 'row' },
          h('button', { onclick: async () => { const copy = await saveScenario(db, { ...JSON.parse(JSON.stringify(s)), id: undefined, name: `${s.name} (what-if)` }); scenarios = await listScenarios(db); state.id = copy.id; state.compareId = scenarios[0].id; paintAll(); } }, '⧉ Copy this scenario'),
          h('button', { onclick: () => forms.replaceChildren(presetForm('Buy a house', [['Price ($)', 400000], ['Down payment ($)', 80000], ['Mortgage rate (%)', 6], ['Mortgage years', 30], ['Rent you stop paying ($/yr)', 18000]],
            (sc, v) => buyHouse(sc, { price: v[0], downPayment: v[1], rate: v[2], years: v[3], rentAvoided: v[4] }))) }, '🏠 Buy a house'),
          h('button', { onclick: () => forms.replaceChildren(presetForm('Change jobs', [['Starting in year', 2], ['Income change ($/yr)', 15000]],
            (sc, v) => changeJob(sc, { fromYear: v[0], incomeDelta: v[1] }))) }, '💼 Change jobs'),
          h('button', { onclick: () => forms.replaceChildren(presetForm('Go part-time', [['Starting in year', 1], ['Income cut (%)', 40], ['Spending cut (%)', 10]],
            (sc, v) => partTime(sc, { fromYear: v[0], incomeCutPct: v[1], spendingCutPct: v[2] }))) }, '⏳ Go part-time'),
          h('button', { onclick: () => forms.replaceChildren(presetForm('One-off amount', [['In year', 3], ['Amount ($, negative = cost)', -20000]],
            (sc, v) => addEvent(sc, { year: v[0], amount: v[1] }))) }, '＋ One-off')),
        forms,
        h('ul', { class: 'list' }, ...(mods.length ? mods.map(m => h('li', {}, h('span', { class: 'grow' }, m.text),
          h('button', { class: 'danger', 'aria-label': 'Remove', onclick: () => { m.remove(); persist(s).then(() => paintAll()); } }, '✕'))) : [h('li', { class: 'muted' }, 'No what-ifs added')]))),
      isBase ? null : h('button', { class: 'danger', onclick: async () => { if (window.confirm(`Delete "${s.name}"?`)) { await deleteScenario(db, s.id); scenarios = await listScenarios(db); state.id = scenarios[0].id; paintAll(); } } }, 'Delete scenario'));
  }

  function paintResult() {
    const s = current();
    const r = simulate(s, SIM);
    const other = state.compareId && state.compareId !== s.id ? scenarios.find(x => x.id === state.compareId) : null;
    const ro = other ? simulate(other, SIM) : null;
    const W = 520, H = 220, L = 58, B = 26;
    const both = ro ? { ...r, p10: r.p10.map((v, i) => Math.min(v, ro.p10[i])), p90: r.p90.map((v, i) => Math.max(v, ro.p90[i])) } : r;
    const chart = fanChart(both, { width: W - L - 8, height: H - B - 8 });
    // draw with the shared scale, so recompute r's band against the combined y range
    const lo = Math.min(0, ...both.p10), hi = Math.max(...both.p90, lo + 1);
    const yy = (v) => (H - B - 8) - ((v - lo) / (hi - lo)) * (H - B - 8);
    const xx = (i) => (i / (r.years.length - 1)) * (W - L - 8);
    const path = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${xx(i).toFixed(1)} ${yy(v).toFixed(1)}`).join(' ');
    const bandPath = `${path(r.p90)} ${r.p10.map((v, i) => [i, v]).reverse().map(([i, v]) => `L${xx(i).toFixed(1)} ${yy(v).toFixed(1)}`).join(' ')} Z`;
    const g = svg('g', { transform: `translate(${L},4)` },
      ...chart.yTicks.map(t => svg('g', {}, svg('line', { x1: 0, x2: W - L - 8, y1: yy(t.value), y2: yy(t.value), stroke: 'var(--border)' }),
        svg('text', { x: -6, y: yy(t.value) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, t.label))),
      ...chart.xTicks.map(t => svg('text', { x: t.x, y: H - B + 12, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)' }, `${t.year}y`)),
      svg('path', { d: bandPath, fill: 'var(--accent)', opacity: '0.18' }),
      svg('path', { d: path(r.median), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2.5 }),
      ro ? svg('path', { d: path(ro.median), fill: 'none', stroke: 'var(--danger)', 'stroke-width': 2, 'stroke-dasharray': '6 4' }) : null);
    const final = r.median.at(-1);
    const cmp = ro ? compare(ro, r) : null;
    resultEl.innerHTML = '';
    resultEl.append(
      h('div', { class: 'tiles' },
        h('div', { class: 'tile' }, h('b', {}, pct(r.success)), h('span', {}, `chance of reaching ${formatMoney(s.goal)}`)),
        h('div', { class: 'tile' }, h('b', {}, formatMoney(final)), h('span', {}, `typical net worth in ${s.horizonYears} years`)),
        h('div', { class: 'tile' }, h('b', {}, `${formatMoney(r.p10.at(-1))} – ${formatMoney(r.p90.at(-1))}`), h('span', {}, 'likely range (10th–90th percentile)')),
        h('div', { class: 'tile' }, h('b', { class: r.ruin > 0.1 ? 'err' : '' }, pct(r.ruin)), h('span', {}, 'chance savings run out'))),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h3', { style: 'flex:1;margin:0' }, 'Net worth over time'),
          h('label', { class: 'muted' }, 'Compare with ', (() => {
            const sel = h('select', { 'aria-label': 'Compare with', onchange: () => { state.compareId = Number(sel.value); paintResult(); } },
              h('option', { value: '0' }, '—'), ...scenarios.filter(x => x.id !== s.id).map(x => h('option', { value: String(x.id) }, x.name)));
            sel.value = String(state.compareId || 0);
            return sel;
          })())),
        svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Net worth fan chart' }, g),
        h('div', { class: 'muted', style: 'font-size:12px' }, 'Solid line: typical outcome. Shaded: likely range.' + (ro ? ` Dashed: ${other.name}.` : '')),
        cmp ? h('p', {}, `Versus ${other.name}: ${cmp.medianFinalDelta >= 0 ? '+' : ''}${formatMoney(cmp.medianFinalDelta)} typical outcome, ${cmp.successDelta >= 0 ? '+' : ''}${Math.round(cmp.successDelta * 100)} points chance of the goal.`) : null),
      h('p', { class: 'muted', style: 'font-size:12px' }, `A simulation of ${r.trials} possible futures from the numbers you entered. It is a thinking tool, not financial advice.`));
  }

  function paintAll() {
    paintList();
    paintEdit();
    paintResult();
  }

  root.innerHTML = '';
  root.append(h('div', { class: 'mod' }, h('h2', {}, '💰 Money Sandbox'),
    h('p', { class: 'sub' }, 'Try big decisions on paper first. Your numbers stay on this computer.'),
    h('div', { style: 'display:grid;grid-template-columns:220px minmax(0,1fr) minmax(0,1.1fr);gap:16px;align-items:start' },
      h('div', { class: 'card' }, h('h3', {}, 'Scenarios'), listEl), editEl, resultEl)));
  paintAll();
  return () => clearTimeout(timer);
}

registerModule({ id: 'money', name: 'Money Sandbox', icon: '💰', ready: true, searchProvider: moneySearch, render });
