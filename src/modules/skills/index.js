import { registerModule } from '../../shell/modules.js';
import { h } from '../../ui/dom.js';
import { GRADES, dayKey, review } from './sm2.js';
import { levelFor } from './levels.js';
import { buildTree, canMove } from './tree.js';
import {
  listSkills, createSkill, renameSkill, moveSkill, deleteSkill, logPractice, listPractice, deletePractice,
  practiceTotals, addCard, listCards, deleteCard, dueCards, reviewCard, skillsSearch,
} from './repo.js';

const GRADE_BUTTONS = [['Again', GRADES.again, '1'], ['Hard', GRADES.hard, '2'], ['Good', GRADES.good, '3'], ['Easy', GRADES.easy, '4']];
const hoursText = (min) => (min >= 600 ? `${Math.round(min / 60)} h` : `${(min / 60).toFixed(1).replace(/\.0$/, '')} h`);

async function render(root, ctx) {
  const db = ctx.db;
  const state = { skills: [], totals: new Map(), id: Number(ctx.route()[0]) || null, review: null, msg: '' };
  const today = () => dayKey();
  const treeEl = h('div', { class: 'card' });
  const detailEl = h('div', {});
  const dueEl = h('div', { class: 'tiles' });
  const overlay = h('div', { class: 'overlay', hidden: true });
  let keyHandler = null;

  async function load() {
    state.skills = await listSkills(db);
    state.totals = await practiceTotals(db);
    if (!state.skills.some(s => s.id === state.id)) state.id = null;
  }

  async function paint() {
    await load();
    await paintDue();
    paintTree();
    await paintDetail();
  }

  async function paintDue() {
    const due = await dueCards(db, today());
    dueEl.innerHTML = '';
    dueEl.append(...[
      h('div', { class: 'tile' }, h('b', {}, String(due.length)), h('span', {}, 'flashcards due today')),
      h('div', { class: 'tile' }, h('b', {}, String(state.skills.length)), h('span', {}, 'skills')),
      h('div', { class: 'tile' }, h('b', {}, hoursText([...state.totals.values()].reduce((a, b) => a + b, 0))), h('span', {}, 'practised in total')),
      due.length ? h('button', { class: 'primary', style: 'align-self:center', onclick: () => startReview(null) }, `▶ Review ${due.length} due`) : null].filter(Boolean));
  }

  function paintTree() {
    const roots = buildTree(state.skills, state.totals);
    const name = h('input', { type: 'text', placeholder: 'New skill, e.g. Guitar', 'aria-label': 'New skill name', style: 'flex:1' });
    const add = async () => { if (!name.value.trim()) return; const s = await createSkill(db, { name: name.value }); state.id = s.id; await paint(); };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    const rows = [];
    const walk = (n) => {
      const lv = levelFor(n.totalMinutes);
      rows.push(h('li', { style: `cursor:pointer;padding-left:${n.depth * 18}px;${n.id === state.id ? 'font-weight:600' : ''}`, onclick: () => { state.id = n.id; state.msg = ''; paint(); } },
        h('span', { class: 'grow' }, (n.children.length ? '▾ ' : '• ') + n.name), h('span', { class: 'pill' }, `L${lv.level}`), h('span', { class: 'muted' }, hoursText(n.totalMinutes))));
      n.children.forEach(walk);
    };
    roots.forEach(walk);
    treeEl.innerHTML = '';
    treeEl.append(h('h3', {}, 'Skill tree'), h('div', { class: 'row' }, name, h('button', { class: 'primary', onclick: add }, 'Add')),
      h('ul', { class: 'list' }, ...(rows.length ? rows : [h('li', { class: 'muted' }, 'Add your first skill above')])));
  }

  async function paintDetail() {
    detailEl.innerHTML = '';
    const s = state.skills.find(x => x.id === state.id);
    if (!s) { detailEl.append(h('div', { class: 'card muted' }, 'Pick a skill on the left, or add one.')); return; }
    const roots = buildTree(state.skills, state.totals);
    const find = (list) => { for (const n of list) { if (n.id === s.id) return n; const f = find(n.children); if (f) return f; } return null; };
    const node = find(roots);
    const lv = levelFor(node.totalMinutes);
    const practice = await listPractice(db, s.id, 12);
    const cards = await listCards(db, s.id);
    const dueHere = cards.filter(c => c.due <= today());

    const nameIn = h('input', { type: 'text', value: s.name, style: 'font-size:18px;font-weight:600;flex:1', 'aria-label': 'Skill name' });
    nameIn.addEventListener('change', async () => { try { await renameSkill(db, s.id, nameIn.value); await paint(); } catch { nameIn.value = s.name; } });
    const parentSel = h('select', { 'aria-label': 'Parent skill' }, h('option', { value: '' }, '(top level)'),
      ...state.skills.filter(x => x.id !== s.id && canMove(state.skills, s.id, x.id)).map(x => h('option', { value: String(x.id) }, x.name)));
    parentSel.value = s.parent_id == null ? '' : String(s.parent_id);
    parentSel.addEventListener('change', async () => { await moveSkill(db, s.id, parentSel.value ? Number(parentSel.value) : null); await paint(); });
    const sub = h('input', { type: 'text', placeholder: 'Add a sub-skill', 'aria-label': 'New sub-skill', style: 'flex:1' });
    const addSub = async () => { if (!sub.value.trim()) return; await createSkill(db, { name: sub.value, parentId: s.id }); await paint(); };

    const minutes = h('input', { type: 'number', min: '1', value: '30', style: 'width:80px', 'aria-label': 'Minutes practised' });
    const day = h('input', { type: 'date', value: today(), 'aria-label': 'Day' });
    const note = h('input', { type: 'text', placeholder: 'What did you work on? (optional)', style: 'flex:1', 'aria-label': 'Practice note' });
    const log = async () => { try { await logPractice(db, { skillId: s.id, minutes: Number(minutes.value), day: day.value || today(), note: note.value }); state.msg = ''; await paint(); } catch (e) { state.msg = 'Enter the minutes you practised.'; await paintDetail(); } };

    const front = h('input', { type: 'text', placeholder: 'Front (question)', 'aria-label': 'Card front', style: 'flex:1' });
    const back = h('input', { type: 'text', placeholder: 'Back (answer)', 'aria-label': 'Card back', style: 'flex:1' });
    const addC = async () => { try { await addCard(db, { skillId: s.id, front: front.value, back: back.value }, today()); await paint(); } catch (e) { state.msg = 'A card needs a front and a back.'; await paintDetail(); } };

    detailEl.append(
      h('div', { class: 'card' },
        h('div', { class: 'row' }, nameIn, h('span', { class: 'pill' }, `Level ${lv.level} · ${lv.name}`)),
        h('div', { class: 'bars', style: 'height:10px;margin:10px 0 4px' }, h('i', { style: `display:block;height:100%;width:${Math.round(lv.progress * 100)}%;background:var(--accent);border-radius:5px` })),
        h('div', { class: 'muted' }, lv.nextAtHours ? `${hoursText(node.totalMinutes)} of ${lv.nextAtHours} h to the next level` : 'Top level reached'),
        h('div', { class: 'row', style: 'margin-top:10px' }, h('label', { class: 'muted' }, 'Part of ', parentSel), sub, h('button', { onclick: addSub }, 'Add')),
        h('div', { style: 'margin-top:8px' }, h('button', { class: 'danger', onclick: async () => { if (window.confirm(`Delete "${s.name}" with everything under it (sub-skills, practice and cards)?`)) { await deleteSkill(db, s.id); state.id = null; await paint(); } } }, 'Delete skill'))),
      h('div', { class: 'card' }, h('h3', {}, 'Log practice'),
        h('div', { class: 'row' }, minutes, ...[15, 30, 60].map(m => h('button', { onclick: () => { minutes.value = String(m); } }, `${m}m`)), day, note, h('button', { class: 'primary', onclick: log }, 'Log')),
        state.msg ? h('div', { class: 'err' }, state.msg) : null,
        h('ul', { class: 'list' }, ...(practice.length ? practice.map(p => h('li', {}, h('span', { class: 'muted', style: 'width:90px' }, p.day), h('span', { class: 'grow' }, p.note || 'Practice'), h('b', {}, `${p.minutes} min`),
          h('button', { class: 'danger', 'aria-label': 'Delete practice entry', onclick: async () => { await deletePractice(db, p.id); await paint(); } }, '✕'))) : [h('li', { class: 'muted' }, 'No practice logged yet')]))),
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { style: 'flex:1;margin:0' }, `Flashcards (${cards.length})`),
        dueHere.length ? h('button', { class: 'primary', onclick: () => startReview(s.id) }, `▶ Review ${dueHere.length} due`) : null),
        h('div', { class: 'row', style: 'margin-top:8px' }, front, back, h('button', { onclick: addC }, 'Add card')),
        h('ul', { class: 'list' }, ...cards.map(c => h('li', {}, h('span', { class: 'grow' }, `${c.front} → ${c.back}`), h('span', { class: 'muted' }, c.due <= today() ? 'due' : `due ${c.due}`),
          h('button', { class: 'danger', 'aria-label': 'Delete card', onclick: async () => { await deleteCard(db, c.id); await paint(); } }, '✕'))))));
  }

  // ---- review session
  async function startReview(skillId) {
    const queue = await dueCards(db, today(), { skillId });
    if (!queue.length) return;
    state.review = { queue, i: 0, revealed: false, done: 0 };
    paintReview();
    keyHandler = (e) => {
      const r = state.review;
      if (!r || r.busy) return;
      if (e.key === 'Escape') closeReview();
      else if (e.key === ' ' && !r.revealed) { e.preventDefault(); r.revealed = true; paintReview(); }
      else if (r.revealed && ['1', '2', '3', '4'].includes(e.key)) grade(GRADE_BUTTONS[Number(e.key) - 1][1]);
    };
    window.addEventListener('keydown', keyHandler);
  }

  async function grade(q) {
    const r = state.review;
    if (!r || r.busy) return; // ignore key repeats while a grade is being saved
    r.busy = true;
    try {
      await reviewCard(db, r.queue[r.i].id, q, today());
      r.done++;
      r.i++;
      r.revealed = false;
    } finally {
      r.busy = false;
    }
    paintReview();
  }

  function closeReview() {
    state.review = null;
    overlay.hidden = true;
    if (keyHandler) window.removeEventListener('keydown', keyHandler);
    keyHandler = null;
    paint();
  }

  function paintReview() {
    const r = state.review;
    overlay.hidden = false;
    overlay.innerHTML = '';
    if (r.i >= r.queue.length) {
      overlay.append(h('div', { class: 'card review' }, h('h2', {}, '🎉 All done'), h('p', {}, `You reviewed ${r.done} cards. See you tomorrow!`), h('button', { class: 'primary', onclick: closeReview }, 'Close')));
      return;
    }
    const c = r.queue[r.i];
    overlay.append(h('div', { class: 'card review' },
      h('div', { class: 'row' }, h('span', { class: 'muted', style: 'flex:1' }, `${c.skillName} · ${r.i + 1} / ${r.queue.length}`), h('button', { onclick: closeReview }, 'Close (Esc)')),
      h('div', { class: 'face' }, c.front),
      r.revealed ? h('div', { class: 'face back' }, c.back) : null,
      r.revealed
        ? h('div', { class: 'row', style: 'justify-content:center' }, ...GRADE_BUTTONS.map(([label, q, key]) => {
          const next = review(c, q, today());
          return h('button', { class: q === GRADES.good ? 'primary' : '', onclick: () => grade(q) }, `${label} (${key}) · ${next.interval === 1 ? 'tomorrow' : `${next.interval}d`}`);
        }))
        : h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'primary', onclick: () => { r.revealed = true; paintReview(); } }, 'Show answer (Space)'))));
  }

  root.innerHTML = '';
  root.append(h('div', { class: 'mod' }, h('h2', {}, '🌳 Skill Tree'), h('p', { class: 'sub' }, 'Grow skills, log practice, and remember what you learn with spaced repetition.'),
    dueEl, h('div', { style: 'display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr);gap:16px;align-items:start' }, treeEl, detailEl)), overlay);
  await paint();
  return () => { if (keyHandler) window.removeEventListener('keydown', keyHandler); };
}

registerModule({ id: 'skills', name: 'Skill Tree', icon: '🌳', ready: true, searchProvider: skillsSearch, render });
