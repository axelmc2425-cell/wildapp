import { registerModule } from '../../shell/modules.js';
import { h } from '../../ui/dom.js';
import { parseIngredientLine, formatQty, scaleIngredients, matchRecipe, rankRecipes, extractTimers, mealTotals, shoppingList } from './cooking.js';
import { addTimer, remainingSeconds, expiredIds, markDone, removeTimer } from './timers.js';
import {
  listPantry, addPantryItem, updatePantryItem, deletePantryItem, listRecipes, getRecipe, createRecipe,
  updateRecipe, deleteRecipe, cookRecipe, cookingSearch,
} from './repo.js';

// Kitchen timers live at module level so they keep running while you look at something else.
let timers = [];
let tick = null;
const listeners = new Set();
const notify = () => listeners.forEach(fn => fn());

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    o.frequency.value = 660;
    const g = ctx.createGain();
    g.gain.value = 0.2;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.8);
  } catch { /* no audio */ }
}

function startTimer(label, minutes) {
  timers = addTimer(timers, { label, seconds: Math.round(minutes * 60) }, Date.now());
  if (!tick) {
    tick = setInterval(() => {
      for (const id of expiredIds(timers, Date.now())) { timers = markDone(timers, id); beep(); }
      notify();
    }, 500);
  }
  notify();
}

const UNITS = ['', 'g', 'kg', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'oz', 'lb', 'clove', 'slice', 'can', 'pinch'];
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const ingText = (i) => [formatQty(i.qty), i.unit, i.name].filter(Boolean).join(' ');

async function render(root, ctx) {
  const db = ctx.db;
  const state = { tab: 'tonight', servings: 2, recipeId: Number(ctx.route()[0]) || null, editing: null, pantry: [], recipes: [], msg: '' };
  const main = h('div', {});
  const timersEl = h('div', { class: 'card' });
  const tabs = h('div', { class: 'sb-tabs' });
  let alive = true;

  async function load() {
    state.pantry = await listPantry(db);
    state.recipes = await listRecipes(db);
  }

  async function go(patch) {
    Object.assign(state, patch);
    await paint();
  }

  function paintTabs() {
    tabs.innerHTML = '';
    for (const [id, label] of [['tonight', 'Tonight'], ['recipes', 'Recipes'], ['pantry', 'Pantry']]) {
      tabs.append(h('button', { class: 'tab' + (state.tab === id && !state.recipeId && !state.editing ? ' on' : ''),
        onclick: () => go({ tab: id, recipeId: null, editing: null, msg: '' }) }, label));
    }
  }

  function paintTimers() {
    if (!alive) return;
    const now = Date.now();
    timersEl.innerHTML = '';
    const label = h('input', { type: 'text', placeholder: 'Timer name', 'aria-label': 'Timer name', style: 'flex:1' });
    const mins = h('input', { type: 'number', min: '0.5', step: '0.5', value: '10', style: 'width:70px', 'aria-label': 'Minutes' });
    timersEl.append(h('h3', {}, '⏱ Kitchen timers'),
      h('div', { class: 'row' }, label, mins, h('button', { onclick: () => startTimer(label.value.trim() || 'Timer', Number(mins.value) || 10) }, 'Start')),
      h('ul', { class: 'list' }, ...(timers.length ? timers.map(t => h('li', {},
        h('span', { class: 'grow' }, t.label),
        h('b', { class: t.done ? 'err' : '' }, t.done ? 'Done!' : mmss(remainingSeconds(t, now))),
        h('button', { title: 'Remove', onclick: () => { timers = removeTimer(timers, t.id); notify(); } }, '✕'))) : [h('li', { class: 'muted' }, 'No timers running')])));
  }

  function tonightView() {
    const ranked = rankRecipes(state.recipes, state.pantry, state.servings);
    const sv = h('input', { type: 'number', min: '1', max: '50', value: String(state.servings), style: 'width:70px', 'aria-label': 'Servings',
      onchange: () => go({ servings: Math.max(1, Number(sv.value) || 2) }) });
    return h('div', {},
      h('div', { class: 'row' }, h('b', {}, 'What can I cook tonight?'), h('label', { class: 'muted' }, 'for ', sv, ' servings')),
      h('p', { class: 'sub' }, 'Recipes ranked by how much of them your pantry already covers.'),
      ...(ranked.length ? ranked.map(({ recipe, match }) => h('div', { class: 'card', style: 'cursor:pointer', onclick: () => go({ recipeId: recipe.id, servings: state.servings }) },
        h('div', { class: 'row' }, h('b', { class: 'grow', style: 'flex:1' }, recipe.title), h('span', { class: 'pill' }, `${Math.round(match.coverage * 100)}% in pantry`)),
        h('div', { class: 'bars', style: 'height:8px;margin:8px 0' }, h('i', { style: `display:block;height:100%;width:${Math.round(match.coverage * 100)}%;background:var(--accent);border-radius:4px` })),
        match.missing.length || match.partial.length
          ? h('div', { class: 'muted' }, 'Need: ' + [...match.missing, ...match.partial.map(p => p.name + ' (more)')].join(', '))
          : h('div', {}, '✅ You have everything'))) : [h('p', { class: 'muted' }, 'Add a few recipes and pantry items and the best matches show up here.')]));
  }

  function recipesView() {
    return h('div', {},
      h('div', { class: 'row' }, h('b', { style: 'flex:1' }, 'Recipes'), h('button', { class: 'primary', onclick: () => go({ editing: { ingredients: [], servings: 2 }, recipeId: null }) }, '＋ New recipe')),
      h('ul', { class: 'list' }, ...(state.recipes.length ? state.recipes.map(r => h('li', { style: 'cursor:pointer', onclick: () => go({ recipeId: r.id, servings: r.servings }) },
        h('span', { class: 'grow' }, r.title), h('span', { class: 'muted' }, `${r.servings} servings`))) : [h('li', { class: 'muted' }, 'No recipes yet')])));
  }

  function pantryView() {
    const name = h('input', { type: 'text', placeholder: 'Ingredient', 'aria-label': 'Ingredient name', style: 'flex:1' });
    const qty = h('input', { type: 'number', min: '0', step: 'any', placeholder: 'Qty', 'aria-label': 'Quantity', style: 'width:80px' });
    const unit = h('select', { 'aria-label': 'Unit' }, ...UNITS.map(u => h('option', { value: u }, u || '(count)')));
    const add = async () => { if (!name.value.trim()) return; await addPantryItem(db, { name: name.value, qty: Number(qty.value) || 0, unit: unit.value }); await load(); await paint(); };
    return h('div', {},
      h('div', { class: 'row' }, name, qty, unit, h('button', { class: 'primary', onclick: add }, 'Add')),
      h('ul', { class: 'list' }, ...(state.pantry.length ? state.pantry.map(p => {
        const q = h('input', { type: 'number', min: '0', step: 'any', value: String(p.qty), style: 'width:80px', 'aria-label': `Quantity of ${p.name}`,
          onchange: async () => { await updatePantryItem(db, p.id, { qty: Number(q.value) || 0 }); await load(); } });
        return h('li', {}, h('span', { class: 'grow' }, p.name), q, h('span', { class: 'muted', style: 'width:40px' }, p.unit),
          h('button', { class: 'danger', 'aria-label': `Remove ${p.name}`, onclick: async () => { await deletePantryItem(db, p.id); await load(); await paint(); } }, '✕'));
      }) : [h('li', { class: 'muted' }, 'Your pantry is empty')])));
  }

  function editorView() {
    const r = state.editing;
    const f = (label, el) => h('label', { class: 'field' }, label, el);
    const title = h('input', { type: 'text', value: r.title || '' });
    const servings = h('input', { type: 'number', min: '1', value: String(r.servings || 2) });
    const ings = h('textarea', { rows: '6', placeholder: '200 g flour\n2 eggs\n1 1/2 cups milk\nsalt' }, (r.ingredients || []).map(ingText).join('\n'));
    const steps = h('textarea', { rows: '6', placeholder: 'One step per line. "Simmer 10 minutes" gets a timer button.' }, r.steps || '');
    const num = (v) => h('input', { type: 'number', min: '0', step: 'any', value: String(v ?? 0), style: 'width:90px' });
    const kcal = num(r.kcal), protein = num(r.protein), carbs = num(r.carbs), fat = num(r.fat), cost = num(r.cost);
    const err = h('div', { class: 'err' });
    const save = async () => {
      const data = {
        title: title.value, servings: Number(servings.value) || 1, steps: steps.value,
        ingredients: ings.value.split('\n').map(parseIngredientLine).filter(Boolean),
        kcal: Number(kcal.value), protein: Number(protein.value), carbs: Number(carbs.value), fat: Number(fat.value), cost: Number(cost.value),
      };
      try {
        const saved = r.id ? await updateRecipe(db, r.id, data) : await createRecipe(db, data);
        await load();
        await go({ editing: null, recipeId: saved.id, servings: saved.servings });
      } catch (e) { err.textContent = e.message === 'duplicate title' ? 'You already have a recipe with that name.' : e.message === 'empty title' ? 'Give the recipe a name.' : e.message; }
    };
    return h('div', { class: 'card' }, h('h3', {}, r.id ? 'Edit recipe' : 'New recipe'),
      f('Name', title), f('Servings', servings), f('Ingredients (one per line)', ings), f('Steps (one per line)', steps),
      h('div', { class: 'row' }, f('kcal / serving', kcal), f('Protein g', protein), f('Carbs g', carbs), f('Fat g', fat), f('Cost / serving', cost)),
      err, h('div', { class: 'row' }, h('button', { class: 'primary', onclick: save }, 'Save'), h('button', { onclick: () => go({ editing: null, recipeId: r.id || null }) }, 'Cancel')));
  }

  async function recipeView() {
    const r = await getRecipe(db, state.recipeId);
    if (!r) return h('p', { class: 'muted' }, 'That recipe no longer exists.');
    const sv = h('input', { type: 'number', min: '1', max: '100', value: String(state.servings), style: 'width:70px', 'aria-label': 'Servings',
      onchange: () => go({ servings: Math.max(1, Number(sv.value) || r.servings) }) });
    const scaled = scaleIngredients(r.ingredients, r.servings, state.servings);
    const m = matchRecipe(r, state.pantry, state.servings);
    const status = (name) => (m.missing.includes(name) ? '✗' : m.partial.some(p => p.name === name) ? '½' : '✓');
    const totals = mealTotals(r, state.servings);
    const shop = shoppingList(r, state.pantry, state.servings);
    const shopText = shop.map(i => '- ' + ingText(i)).join('\n');
    return h('div', {},
      h('div', { class: 'row' }, h('h3', { style: 'flex:1;margin:0;font-size:20px' }, r.title),
        h('button', { onclick: () => go({ editing: r, recipeId: null }) }, 'Edit'),
        h('button', { class: 'danger', onclick: async () => { if (window.confirm(`Delete "${r.title}"?`)) { await deleteRecipe(db, r.id); await load(); await go({ recipeId: null, tab: 'recipes' }); } } }, 'Delete')),
      h('div', { class: 'row', style: 'margin:8px 0' }, h('label', { class: 'muted' }, 'Servings ', sv), h('span', { class: 'pill' }, `${Math.round(m.coverage * 100)}% in pantry`)),
      h('div', { class: 'tiles' }, ...[[totals.kcal, 'kcal'], [totals.protein + ' g', 'protein'], [totals.carbs + ' g', 'carbs'], [totals.fat + ' g', 'fat'], ['$' + totals.cost.toFixed(2), 'total cost']]
        .map(([v, l]) => h('div', { class: 'tile' }, h('b', {}, String(v)), h('span', {}, l)))),
      h('div', { class: 'card' }, h('h3', {}, 'Ingredients'),
        h('ul', { class: 'list' }, ...scaled.map(i => h('li', {}, h('span', { style: 'width:20px' }, status(i.name)), h('span', { class: 'grow' }, ingText(i)))))),
      h('div', { class: 'card' }, h('h3', {}, 'Steps'),
        h('ol', {}, ...r.steps.split('\n').filter(s => s.trim()).map(line => h('li', {}, line, ' ',
          ...extractTimers(line).map(t => h('button', { class: 'pill', onclick: () => startTimer(t.label, t.minutes) }, `⏱ ${t.minutes} min`)))))),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => { const n = await cookRecipe(db, r.id, state.servings); await load(); await go({ msg: n ? `Pantry updated (${n} items used).` : 'Nothing in your pantry matched.' }); } }, '🍳 I cooked this'),
        shop.length ? h('button', { onclick: async () => { try { await navigator.clipboard.writeText(shopText); state.msg = 'Shopping list copied.'; } catch { state.msg = 'Shopping list:\n' + shopText; } await paint(); } }, `🛒 Copy shopping list (${shop.length})`) : null),
      state.msg ? h('pre', { class: 'muted' }, state.msg) : null);
  }

  async function paint() {
    if (!alive) return;
    paintTabs();
    main.innerHTML = '';
    if (state.editing) main.append(editorView());
    else if (state.recipeId) main.append(await recipeView());
    else main.append(state.tab === 'recipes' ? recipesView() : state.tab === 'pantry' ? pantryView() : tonightView());
  }

  listeners.add(paintTimers);
  await load();
  root.innerHTML = '';
  root.append(h('div', { class: 'mod' }, h('h2', {}, '🍳 Cooking Coach'), h('p', { class: 'sub' }, 'Pantry, recipes, timers, macros and cost. Everything stays on this computer.'),
    tabs, h('div', { class: 'grid2', style: 'margin-top:12px' }, main, timersEl)));
  paintTimers();
  await paint();
  return () => { alive = false; listeners.delete(paintTimers); };
}

registerModule({ id: 'cooking', name: 'Cooking Coach', icon: '🍳', ready: true, searchProvider: cookingSearch, render });
