// Pure cooking logic: ingredient parsing, scaling, pantry matching, timers in step text, totals.
const UNIT_ALIASES = {
  g: 'g', gram: 'g', grams: 'g', gr: 'g', kg: 'kg', kilogram: 'kg', kilograms: 'kg',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp', tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  cup: 'cup', cups: 'cup', oz: 'oz', ounce: 'oz', ounces: 'oz', lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  pinch: 'pinch', clove: 'clove', cloves: 'clove', slice: 'slice', slices: 'slice', can: 'can', cans: 'can',
};
const BASE = {
  g: ['mass', 1], kg: ['mass', 1000], oz: ['mass', 28.35], lb: ['mass', 453.6],
  ml: ['volume', 1], l: ['volume', 1000], tsp: ['volume', 5], tbsp: ['volume', 15], cup: ['volume', 240],
};
const UNICODE = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

export function parseQty(str) {
  const s = String(str).trim();
  let m;
  if ((m = /^(\d+(?:\.\d+)?)$/.exec(s))) return Number(m[1]);
  if ((m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s))) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  if ((m = /^(\d+)\/(\d+)$/.exec(s))) return Number(m[1]) / Number(m[2]);
  if ((m = /^(\d+)?\s*([½¼¾⅓⅔])$/.exec(s))) return (m[1] ? Number(m[1]) : 0) + UNICODE[m[2]];
  return null;
}

export function parseIngredientLine(line) {
  // "500g flour" -> "500 g flour"
  const spaced = String(line).trim().replace(/^(\d+(?:[./]\d+)?)([a-zA-Z]+)(?=\s|$)/, '$1 $2');
  const tokens = spaced.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  let i = 0;
  const q = [];
  while (i < tokens.length && q.length < 2 && /^[\d./½⅓⅔¼¾]+$/.test(tokens[i])) q.push(tokens[i++]);
  const qty = q.length ? parseQty(q.join(' ')) : null;
  if (qty === null) return { qty: null, unit: '', name: tokens.join(' ') };
  let unit = '';
  const alias = tokens[i] ? UNIT_ALIASES[tokens[i].toLowerCase().replace(/\.$/, '')] : undefined;
  if (alias && i < tokens.length - 1) { unit = alias; i++; }
  if (tokens[i] && tokens[i].toLowerCase() === 'of') i++;
  const name = tokens.slice(i).join(' ');
  return { qty, unit, name: name || tokens[tokens.length - 1] };
}

export function formatQty(n) {
  if (n === null || n === undefined) return '';
  if (n > 0 && n < 0.01) return String(Number(n.toPrecision(2)));
  const whole = Math.floor(n + 0.02 > Math.floor(n) + 1 ? n + 0.02 : n);
  const frac = n - whole;
  if (frac < 0.02) return String(whole);
  const sym = [[0.25, '¼'], [1 / 3, '⅓'], [0.5, '½'], [2 / 3, '⅔'], [0.75, '¾']].find(([v]) => Math.abs(frac - v) < 0.02);
  if (sym) return (whole ? whole + ' ' : '') + sym[1];
  return String(round2(n));
}

export function scaleIngredients(ingredients, fromServings, toServings) {
  const f = fromServings > 0 ? toServings / fromServings : 1;
  return ingredients.map(i => ({ ...i, qty: i.qty === null || i.qty === undefined ? null : round3(i.qty * f) }));
}

function toBase(qty, unit) {
  const b = BASE[unit];
  return b ? { qty: qty * b[1], kind: b[0] } : { qty, kind: 'count:' + unit };
}

const foldWord = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const words = (name) => (String(name).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).map(foldWord);

// Whole-word matching: "salt" is not "unsalted butter" and "egg" is not "eggplant", but "milk" matches "whole milk".
function findPantry(name, pantry) {
  const k = words(name);
  const same = (a, b) => a.length === b.length && a.every((w, i) => w === b[i]);
  const within = (a, b) => a.length > 0 && a.every(w => b.includes(w));
  return pantry.find(p => same(words(p.name), k)) || pantry.find(p => within(words(p.name), k) || within(k, words(p.name)));
}

function fractionHave(ing, item) {
  if (!item) return 0;
  if (ing.qty === null || ing.qty === undefined) return 1;
  const need = toBase(ing.qty, ing.unit);
  const have = toBase(item.qty, item.unit);
  if (need.kind === have.kind) return need.qty <= 0 ? 1 : Math.min(1, have.qty / need.qty);
  return item.qty > 0 ? 1 : 0; // units cannot be compared: having some counts as having it
}

export function matchRecipe(recipe, pantry, servings = recipe.servings) {
  const scaled = scaleIngredients(recipe.ingredients, recipe.servings, servings);
  const out = { coverage: 1, have: [], partial: [], missing: [] };
  let total = 0;
  for (const ing of scaled) {
    const item = findPantry(ing.name, pantry);
    const f = fractionHave(ing, item);
    total += f;
    if (f >= 0.999) out.have.push(ing.name);
    else if (f > 0) out.partial.push({ name: ing.name, fraction: f, need: `${formatQty(ing.qty)} ${ing.unit}`.trim(), have: `${formatQty(item.qty)} ${item.unit}`.trim() });
    else out.missing.push(ing.name);
  }
  if (scaled.length) out.coverage = total / scaled.length;
  return out;
}

export function rankRecipes(recipes, pantry, servings) {
  return recipes
    .map(recipe => ({ recipe, match: matchRecipe(recipe, pantry, servings ?? recipe.servings) }))
    .sort((a, b) => b.match.coverage - a.match.coverage
      || a.match.missing.length - b.match.missing.length
      || a.match.partial.length - b.match.partial.length
      || a.recipe.title.localeCompare(b.recipe.title));
}

const TIME = /(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/gi;

// Durations written in step text: "simmer 10 minutes" -> 10. Ranges use the upper bound; "1 hour 30 minutes" is 90.
export function extractTimers(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    let prev = null;
    for (const m of line.matchAll(TIME)) {
      const n = Number(m[2] ?? m[1]);
      const u = m[3].toLowerCase();
      const minutes = u.startsWith('h') ? n * 60 : u.startsWith('m') ? n : n / 60;
      const label = line.trim().slice(0, 50);
      if (prev && prev.hour && u.startsWith('m') && /^\s*(and|,)?\s*$/.test(line.slice(prev.end, m.index))) {
        out[out.length - 1].minutes = round2(out[out.length - 1].minutes + minutes);
      } else {
        out.push({ minutes: round2(minutes), label });
      }
      prev = { end: m.index + m[0].length, hour: u.startsWith('h') };
    }
  }
  return out;
}

export function mealTotals(recipe, servings) {
  const t = (v) => round2((v || 0) * servings);
  return { kcal: t(recipe.kcal), protein: t(recipe.protein), carbs: t(recipe.carbs), fat: t(recipe.fat), cost: t(recipe.cost) };
}

export function shoppingList(recipe, pantry, servings = recipe.servings) {
  const out = [];
  for (const ing of scaleIngredients(recipe.ingredients, recipe.servings, servings)) {
    const item = findPantry(ing.name, pantry);
    const f = fractionHave(ing, item);
    if (f >= 0.999) continue;
    if (!item || ing.qty === null) { out.push({ name: ing.name, qty: ing.qty, unit: ing.unit }); continue; }
    const need = toBase(ing.qty, ing.unit);
    const have = toBase(item.qty, item.unit);
    const factor = BASE[ing.unit] ? BASE[ing.unit][1] : 1;
    out.push({ name: ing.name, qty: round2((need.qty - (need.kind === have.kind ? have.qty : 0)) / factor), unit: ing.unit });
  }
  return out;
}

// New pantry quantities after cooking: [{ id, qty }] for the items that changed (never below zero).
export function deductPantry(recipe, pantry, servings = recipe.servings) {
  const changes = new Map();
  for (const ing of scaleIngredients(recipe.ingredients, recipe.servings, servings)) {
    if (ing.qty === null) continue;
    const item = findPantry(ing.name, pantry);
    if (!item) continue;
    const need = toBase(ing.qty, ing.unit);
    const haveQty = changes.has(item.id) ? changes.get(item.id) : item.qty;
    const have = toBase(haveQty, item.unit);
    if (need.kind !== have.kind) continue;
    const factor = BASE[item.unit] ? BASE[item.unit][1] : 1;
    changes.set(item.id, round2(Math.max(0, have.qty - need.qty) / factor));
  }
  return [...changes].map(([id, qty]) => ({ id, qty }));
}
