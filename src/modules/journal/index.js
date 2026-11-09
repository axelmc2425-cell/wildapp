import { registerModule } from '../../shell/modules.js';
import { h } from '../../ui/dom.js';
import { createAutosaver } from '../secondbrain/editor.js';
import { weeklyReview, observations, promptsFor, weekSummaryText, weekdayName } from './patterns.js';
import { saveEntry, getEntry, getEntryById, listEntries, deleteEntry, journalSearch } from './repo.js';

const MOODS = ['😞', '🙁', '😐', '🙂', '😄'];
const pad = (n) => String(n).padStart(2, '0');
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const shiftDay = (day, n) => { const [y, m, d] = day.split('-').map(Number); const x = new Date(y, m - 1, d + n); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
const one = (n) => (n === null || n === undefined ? '–' : n.toFixed(1));

async function render(root, ctx) {
  const db = ctx.db;
  let day = todayKey();
  const routeId = Number(ctx.route()[0]);
  if (routeId) { const e = await getEntryById(db, routeId); if (e) day = e.day; }
  const state = { tab: 'write', weekDay: day, entry: null, msg: '' };
  const main = h('div', {});
  const tabs = h('div', { class: 'sb-tabs' });
  let alive = true;

  const statusEl = h('span', { class: 'muted' });
  const autosaver = createAutosaver({
    save: async (p) => { await saveEntry(db, p); },
    onStatus: (s) => { if (alive && statusEl.isConnected) statusEl.textContent = s === 'saved' ? 'Saved' : s === 'saving' ? 'Saving…' : s === 'error' ? "Couldn't save, retrying…" : ''; },
  });

  function paintTabs() {
    tabs.innerHTML = '';
    for (const [id, label] of [['write', 'Write'], ['week', 'Week'], ['patterns', 'Patterns'], ['history', 'History']]) {
      tabs.append(h('button', { class: 'tab' + (state.tab === id ? ' on' : ''), onclick: () => go(id) }, label));
    }
  }

  async function go(tab) {
    await autosaver.flush();
    state.tab = tab;
    await paint();
  }

  async function writeView() {
    const entry = (await getEntry(db, day)) || { day, mood: null, energy: null, sleep: null, text: '', tags: [] };
    const cur = { mood: entry.mood, energy: entry.energy, sleep: entry.sleep };
    const push = () => autosaver.change({ id: day, day, mood: cur.mood, energy: cur.energy, sleep: cur.sleep, text: textarea.value, tags: tagsIn.value.split(',').map(t => t.trim()).filter(Boolean) });
    const dateIn = h('input', { type: 'date', value: day, max: todayKey(), 'aria-label': 'Day' });
    dateIn.addEventListener('change', async () => { if (!dateIn.value) return; await autosaver.flush(); day = dateIn.value; state.weekDay = day; await paint(); });
    const moodRow = h('div', { class: 'row' }, ...MOODS.map((m, i) => h('button', { class: cur.mood === i + 1 ? 'primary' : '', 'aria-label': `Mood ${i + 1}`, style: 'font-size:22px;padding:4px 10px',
      onclick: (e) => { cur.mood = cur.mood === i + 1 ? null : i + 1; [...moodRow.children].forEach((b, j) => { b.className = cur.mood === j + 1 ? 'primary' : ''; }); push(); } }, m)));
    const energyRow = h('div', { class: 'row' }, ...[1, 2, 3, 4, 5].map(n => h('button', { class: cur.energy === n ? 'primary' : '', 'aria-label': `Energy ${n}`,
      onclick: () => { cur.energy = cur.energy === n ? null : n; [...energyRow.children].forEach((b, j) => { b.className = cur.energy === j + 1 ? 'primary' : ''; }); push(); } }, String(n))));
    const sleepIn = h('input', { type: 'number', min: '0', max: '24', step: '0.25', value: entry.sleep ?? '', style: 'width:90px', 'aria-label': 'Hours slept' });
    sleepIn.addEventListener('input', () => { const v = sleepIn.value === '' ? null : Number(sleepIn.value); cur.sleep = v === null || (v >= 0 && v <= 24) ? v : cur.sleep; push(); });
    const tagsIn = h('input', { type: 'text', value: entry.tags.join(', '), placeholder: 'tags, comma separated', style: 'width:100%', 'aria-label': 'Tags' });
    tagsIn.addEventListener('input', push);
    const textarea = h('textarea', { rows: '12', placeholder: 'How was your day? What is on your mind?', 'aria-label': 'Journal entry' }, entry.text);
    textarea.addEventListener('input', push);
    const prompts = promptsFor(weeklyReview(await listEntries(db), day));
    return h('div', { class: 'card' },
      h('div', { class: 'row' }, h('label', { class: 'muted' }, 'Day ', dateIn), h('span', { style: 'flex:1' }), statusEl,
        entry.id ? h('button', { class: 'danger', onclick: async () => { if (window.confirm(`Delete the entry for ${day}?`)) { autosaver.dispose(); await deleteEntry(db, day); window.location.reload(); } } }, 'Delete entry') : null),
      h('div', { class: 'grid2', style: 'margin:10px 0' },
        h('div', {}, h('div', { class: 'muted' }, 'Mood'), moodRow), h('div', {}, h('div', { class: 'muted' }, 'Energy'), energyRow)),
      h('div', { class: 'row', style: 'margin-bottom:8px' }, h('label', { class: 'muted' }, 'Sleep (hours) ', sleepIn), h('div', { style: 'flex:1;min-width:180px' }, tagsIn)),
      textarea,
      h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'muted' }, 'Prompts:'),
        ...prompts.map(q => h('button', { class: 'pill', onclick: () => { textarea.value = (textarea.value ? textarea.value + '\n\n' : '') + q + '\n'; textarea.focus(); push(); } }, q))));
  }

  async function weekView() {
    const entries = await listEntries(db);
    const r = weeklyReview(entries, state.weekDay);
    const obs = observations(entries, { now: todayKey() });
    const prompts = promptsFor(r);
    const bars = h('div', { class: 'bars' }, ...r.byDay.map(d => h('div', { class: 'bar', title: `${d.day}: ${d.mood ?? 'no mood'}` },
      d.mood ? h('i', { style: `height:${d.mood * 20}%` }) : h('i', { style: 'height:2px;opacity:.3' }), d.mood ? MOODS[d.mood - 1] : '·', weekdayName(d.day).slice(0, 3))));
    return h('div', {},
      h('div', { class: 'row' }, h('button', { onclick: () => { state.weekDay = shiftDay(r.start, -7); paint(); } }, '←'), h('b', { style: 'flex:1;text-align:center' }, `${r.start} – ${r.end}`),
        h('button', { onclick: () => { state.weekDay = shiftDay(r.start, 7); paint(); } }, '→'),
        h('button', { onclick: async () => { try { await navigator.clipboard.writeText(weekSummaryText(r, obs, prompts)); state.msg = 'Week copied to the clipboard.'; } catch { state.msg = weekSummaryText(r, obs, prompts); } await paint(); } }, '📋 Copy my week')),
      state.msg ? h('pre', { class: 'banner', style: 'white-space:pre-wrap' }, state.msg) : null,
      h('div', { class: 'tiles', style: 'margin-top:12px' },
        h('div', { class: 'tile' }, h('b', {}, `${r.daysLogged}/7`), h('span', {}, 'days journaled')),
        h('div', { class: 'tile' }, h('b', {}, one(r.avgMood)), h('span', {}, r.moodChange === null ? 'average mood' : `average mood (${r.moodChange >= 0 ? '+' : ''}${one(r.moodChange)} vs last week)`)),
        h('div', { class: 'tile' }, h('b', {}, one(r.avgEnergy)), h('span', {}, 'average energy')),
        h('div', { class: 'tile' }, h('b', {}, one(r.avgSleep)), h('span', {}, 'average sleep (h)'))),
      h('div', { class: 'grid2' },
        h('div', { class: 'card' }, h('h3', {}, 'Mood by day'), bars,
          r.bestDay ? h('p', {}, `Best: ${weekdayName(r.bestDay.day)} ${MOODS[r.bestDay.mood - 1]}` + (r.hardestDay && r.hardestDay.day !== r.bestDay.day ? ` · Hardest: ${weekdayName(r.hardestDay.day)} ${MOODS[r.hardestDay.mood - 1]}` : '')) : h('p', { class: 'muted' }, 'No moods logged this week.'),
          r.topTags.length ? h('div', { class: 'row' }, ...r.topTags.map(t => h('span', { class: 'pill' }, `#${t.tag} ×${t.count}`))) : null),
        h('div', { class: 'card' }, h('h3', {}, 'Reflect on this week'), h('ul', {}, ...prompts.map(q => h('li', {}, q))),
          h('button', { class: 'primary', onclick: () => { day = todayKey(); go('write'); } }, 'Write today’s entry'))));
  }

  async function patternsView() {
    const entries = await listEntries(db);
    const obs = observations(entries, { now: todayKey() });
    const byDay = new Map();
    for (const e of entries) if (typeof e.mood === 'number') (byDay.get(weekdayName(e.day)) || byDay.set(weekdayName(e.day), []).get(weekdayName(e.day))).push(e.mood);
    const order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h3', {}, 'What I notice'), ...(obs.length ? obs.map(o => h('p', {}, '💡 ' + o.text)) : [h('p', { class: 'muted' }, 'Patterns appear after about two weeks of entries with mood and sleep. Keep writing!')]),
        h('p', { class: 'muted', style: 'font-size:12px' }, 'These are simple counts on this computer, not medical advice.')),
      h('div', { class: 'card' }, h('h3', {}, 'Average mood by weekday'),
        h('div', { class: 'bars' }, ...order.map(n => { const v = byDay.get(n); const a = v ? v.reduce((x, y) => x + y, 0) / v.length : 0;
          return h('div', { class: 'bar', title: v ? `${n}: ${a.toFixed(1)} (${v.length} entries)` : n }, h('i', { style: `height:${a * 20}%` }), n.slice(0, 3)); })),
        h('p', { class: 'muted' }, `${entries.length} entries in total`)));
  }

  async function historyView() {
    const entries = await listEntries(db, { limit: 200 });
    return h('div', { class: 'card' }, h('ul', { class: 'list' }, ...(entries.length ? entries.map(e => h('li', { style: 'cursor:pointer', onclick: () => { day = e.day; state.weekDay = e.day; go('write'); } },
      h('span', { style: 'width:28px' }, e.mood ? MOODS[e.mood - 1] : '·'), h('b', { style: 'width:96px' }, e.day),
      h('span', { class: 'grow muted', style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, e.text.replace(/\s+/g, ' ').slice(0, 120) || '(no text)'))) : [h('li', { class: 'muted' }, 'No entries yet')])));
  }

  async function paint() {
    if (!alive) return;
    paintTabs();
    main.innerHTML = '';
    main.append(state.tab === 'week' ? await weekView() : state.tab === 'patterns' ? await patternsView() : state.tab === 'history' ? await historyView() : await writeView());
  }

  root.innerHTML = '';
  root.append(h('div', { class: 'mod' }, h('h2', {}, '📓 Journal Companion'),
    h('p', { class: 'sub' }, 'Write a little each day. Weekly reflections and patterns are worked out on this computer.'), tabs, main));
  await paint();
  return () => { alive = false; autosaver.flush().then(ok => { if (ok) autosaver.dispose(); }); };
}

registerModule({ id: 'journal', name: 'Journal Companion', icon: '📓', ready: true, searchProvider: journalSearch, render });
