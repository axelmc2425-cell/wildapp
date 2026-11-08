import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrate } from '../src/core/schema.js';
import {
  parseQty, parseIngredientLine, formatQty, scaleIngredients, matchRecipe, rankRecipes,
  extractTimers, mealTotals, shoppingList, deductPantry,
} from '../src/modules/cooking/cooking.js';
import { addTimer, remainingSeconds, expiredIds } from '../src/modules/cooking/timers.js';
import {
  addPantryItem, listPantry, updatePantryItem, deletePantryItem, createRecipe, updateRecipe, getRecipe,
  listRecipes, deleteRecipe, cookRecipe, cookingSearch,
} from '../src/modules/cooking/repo.js';

async function fresh() {
  const db = await openNodeDb(join(mkdtempSync(join(tmpdir(), 'mybrain-')), 't.db'));
  await migrate(db);
  return db;
}

test('parseQty reads decimals, fractions, mixed numbers and unicode fractions', () => {
  assert.equal(parseQty('2'), 2);
  assert.equal(parseQty('2.5'), 2.5);
  assert.equal(parseQty('1/2'), 0.5);
  assert.equal(parseQty('1 1/2'), 1.5);
  assert.equal(parseQty('½'), 0.5);
  assert.equal(parseQty('1½'), 1.5);
  assert.equal(parseQty('a pinch'), null);
});

test('parseIngredientLine splits quantity, unit and name', () => {
  assert.deepEqual(parseIngredientLine('200 g flour'), { qty: 200, unit: 'g', name: 'flour' });
  assert.deepEqual(parseIngredientLine('2 eggs'), { qty: 2, unit: '', name: 'eggs' });
  assert.deepEqual(parseIngredientLine('1 1/2 cups whole milk'), { qty: 1.5, unit: 'cup', name: 'whole milk' });
  assert.deepEqual(parseIngredientLine('2 tablespoons olive oil'), { qty: 2, unit: 'tbsp', name: 'olive oil' });
  assert.deepEqual(parseIngredientLine('salt'), { qty: null, unit: '', name: 'salt' });
  assert.deepEqual(parseIngredientLine('  '), null);
});

test('formatQty shows tidy numbers and fractions', () => {
  assert.equal(formatQty(2), '2');
  assert.equal(formatQty(0.5), '½');
  assert.equal(formatQty(1.5), '1 ½');
  assert.equal(formatQty(0.333), '⅓');
  assert.equal(formatQty(2.37), '2.37');
  assert.equal(formatQty(null), '');
});

test('scaleIngredients scales quantities and leaves unspecified amounts alone', () => {
  const out = scaleIngredients([{ qty: 200, unit: 'g', name: 'flour' }, { qty: null, unit: '', name: 'salt' }], 2, 5);
  assert.deepEqual(out, [{ qty: 500, unit: 'g', name: 'flour' }, { qty: null, unit: '', name: 'salt' }]);
});

const recipe = (title, ingredients, extra = {}) => ({ id: 1, title, servings: 2, ingredients, steps: '', kcal: 500, protein: 30, carbs: 50, fat: 10, cost: 2, ...extra });

test('matchRecipe compares pantry quantities across compatible units', () => {
  const r = recipe('Pancakes', [{ qty: 200, unit: 'g', name: 'flour' }, { qty: 1, unit: 'cup', name: 'milk' }, { qty: 2, unit: '', name: 'eggs' }, { qty: null, unit: '', name: 'salt' }]);
  const pantry = [{ name: 'Flour', qty: 1, unit: 'kg' }, { name: 'milk', qty: 120, unit: 'ml' }, { name: 'egg', qty: 6, unit: '' }];
  const m = matchRecipe(r, pantry, 2);
  assert.deepEqual(m.missing, ['salt']);
  assert.equal(m.partial.length, 1);
  assert.equal(m.partial[0].name, 'milk');
  assert.ok(Math.abs(m.partial[0].fraction - 0.5) < 0.01);
  assert.ok(m.coverage > 0.6 && m.coverage < 0.9, String(m.coverage));
});

test('matchRecipe scales needs with the servings asked for', () => {
  const r = recipe('Rice', [{ qty: 100, unit: 'g', name: 'rice' }]);
  const pantry = [{ name: 'rice', qty: 300, unit: 'g' }];
  assert.equal(matchRecipe(r, pantry, 2).coverage, 1);
  assert.ok(matchRecipe(r, pantry, 8).coverage < 1);
});

test('matchRecipe treats a recipe with no ingredients as fully covered', () => {
  assert.equal(matchRecipe(recipe('Water', []), [], 2).coverage, 1);
});

test('rankRecipes puts the most covered recipe first and breaks ties by fewer missing', () => {
  const a = recipe('A', [{ qty: 1, unit: '', name: 'egg' }, { qty: 1, unit: '', name: 'ham' }], { id: 1 });
  const b = recipe('B', [{ qty: 1, unit: '', name: 'egg' }], { id: 2 });
  const c = recipe('C', [{ qty: 1, unit: '', name: 'truffle' }], { id: 3 });
  const ranked = rankRecipes([c, a, b], [{ name: 'egg', qty: 3, unit: '' }], 2);
  assert.deepEqual(ranked.map(r => r.recipe.title), ['B', 'A', 'C']);
});

test('extractTimers finds durations in step text, merges hours and minutes, takes the upper bound of a range', () => {
  assert.deepEqual(extractTimers('Simmer for 10 minutes.').map(t => t.minutes), [10]);
  assert.deepEqual(extractTimers('Bake 1 hour 30 minutes').map(t => t.minutes), [90]);
  assert.deepEqual(extractTimers('Rest 15-20 min, then chill 2 hours').map(t => t.minutes), [20, 120]);
  assert.deepEqual(extractTimers('Sear 30 seconds per side').map(t => t.minutes), [0.5]);
  assert.deepEqual(extractTimers('Mix well and serve'), []);
});

test('mealTotals multiplies per-serving values by servings', () => {
  const t = mealTotals(recipe('X', []), 3);
  assert.deepEqual(t, { kcal: 1500, protein: 90, carbs: 150, fat: 30, cost: 6 });
});

test('shoppingList lists what is missing or short, in the recipe unit', () => {
  const r = recipe('R', [{ qty: 200, unit: 'g', name: 'flour' }, { qty: 1, unit: 'cup', name: 'milk' }, { qty: null, unit: '', name: 'salt' }]);
  const list = shoppingList(r, [{ name: 'flour', qty: 150, unit: 'g' }], 2);
  assert.deepEqual(list, [{ name: 'flour', qty: 50, unit: 'g' }, { name: 'milk', qty: 1, unit: 'cup' }, { name: 'salt', qty: null, unit: '' }]);
});

test('deductPantry removes used amounts but never goes below zero', () => {
  const r = recipe('R', [{ qty: 200, unit: 'g', name: 'flour' }, { qty: 6, unit: '', name: 'egg' }]);
  const out = deductPantry(r, [{ id: 1, name: 'flour', qty: 0.5, unit: 'kg' }, { id: 2, name: 'eggs', qty: 4, unit: '' }], 2);
  assert.deepEqual(out, [{ id: 1, qty: 0.3 }, { id: 2, qty: 0 }]);
});

test('timers: remaining seconds count down and expired ids are reported once due', () => {
  const t1 = addTimer([], { label: 'Pasta', seconds: 600 }, 1000);
  const list = addTimer(t1, { label: 'Eggs', seconds: 60 }, 1000);
  assert.equal(remainingSeconds(list[0], 1000 + 100_000), 500);
  assert.deepEqual(expiredIds(list, 1000 + 61_000), [list[1].id]);
  assert.equal(remainingSeconds(list[1], 1000 + 90_000), 0);
});

test('pantry: add merges by name ignoring case, update and delete', async () => {
  const db = await fresh();
  await addPantryItem(db, { name: 'Flour', qty: 500, unit: 'g' });
  await addPantryItem(db, { name: 'flour', qty: 250, unit: 'g' });
  const [f] = await listPantry(db);
  assert.equal(f.qty, 750);
  await updatePantryItem(db, f.id, { qty: 100 });
  assert.equal((await listPantry(db))[0].qty, 100);
  await deletePantryItem(db, f.id);
  assert.deepEqual(await listPantry(db), []);
});

test('recipes: create, read back parsed ingredients, update, reject duplicate titles, delete', async () => {
  const db = await fresh();
  const r = await createRecipe(db, { title: 'Pancakes', servings: 4, ingredients: [{ qty: 200, unit: 'g', name: 'flour' }], steps: 'Mix.\nFry 3 minutes.', kcal: 300, protein: 8, carbs: 40, fat: 9, cost: 1.5 });
  assert.deepEqual((await getRecipe(db, r.id)).ingredients, [{ qty: 200, unit: 'g', name: 'flour' }]);
  await assert.rejects(createRecipe(db, { title: 'PANCAKES', servings: 1, ingredients: [] }), /duplicate/);
  await updateRecipe(db, r.id, { servings: 2, cost: 2 });
  const again = await getRecipe(db, r.id);
  assert.equal(again.servings, 2);
  assert.equal(again.cost, 2);
  assert.equal(again.title, 'Pancakes');
  assert.equal((await listRecipes(db)).length, 1);
  await deleteRecipe(db, r.id);
  assert.equal(await getRecipe(db, r.id), null);
});

test('cookRecipe deducts pantry stock and cookingSearch finds recipes by title and ingredient', async () => {
  const db = await fresh();
  await addPantryItem(db, { name: 'flour', qty: 500, unit: 'g' });
  const r = await createRecipe(db, { title: 'Bread', servings: 2, ingredients: [{ qty: 300, unit: 'g', name: 'flour' }], steps: '' });
  await cookRecipe(db, r.id, 2);
  assert.equal((await listPantry(db))[0].qty, 200);
  assert.equal((await cookingSearch(db, 'bre'))[0].title, 'Bread');
  assert.equal((await cookingSearch(db, 'FLOUR'))[0].title, 'Bread');
  assert.deepEqual(await cookingSearch(db, 'zzz'), []);
});

test('pantry matching works on whole words: salt is not unsalted, egg is not eggplant', () => {
  const pantry = [{ id: 1, name: 'salt', qty: 500, unit: 'g' }, { id: 2, name: 'egg', qty: 6, unit: '' }];
  const r = recipe('R', [{ qty: 250, unit: 'g', name: 'unsalted butter' }, { qty: 1, unit: '', name: 'eggplant' }]);
  assert.deepEqual(matchRecipe(r, pantry, 2).missing, ['unsalted butter', 'eggplant']);
  assert.deepEqual(deductPantry(r, pantry, 2), []);
});

test('pantry matching still links a short pantry name to a longer ingredient name and back', () => {
  assert.equal(matchRecipe(recipe('R', [{ qty: 1, unit: 'cup', name: 'whole milk' }]), [{ name: 'milk', qty: 500, unit: 'ml' }], 2).coverage, 1);
  assert.equal(matchRecipe(recipe('R', [{ qty: 1, unit: 'tbsp', name: 'oil' }]), [{ name: 'olive oil', qty: 500, unit: 'ml' }], 2).coverage, 1);
});

test('quantities written without a space are parsed: 500g flour, 1.5kg potatoes', () => {
  assert.deepEqual(parseIngredientLine('500g flour'), { qty: 500, unit: 'g', name: 'flour' });
  assert.deepEqual(parseIngredientLine('1.5kg potatoes'), { qty: 1.5, unit: 'kg', name: 'potatoes' });
  assert.deepEqual(parseIngredientLine('2 eggs'), { qty: 2, unit: '', name: 'eggs' });
});

test('small scaled amounts do not round down to zero', () => {
  const [i] = scaleIngredients([{ qty: 0.25, unit: 'tsp', name: 'saffron' }], 4, 1);
  assert.ok(i.qty > 0, String(i.qty));
  assert.equal(formatQty(0.004), '0.004');
});
