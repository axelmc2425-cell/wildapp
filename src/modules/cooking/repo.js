import { titleKey } from '../../core/titlekey.js';
import { deductPantry } from './cooking.js';

export async function listPantry(db) {
  return db.all('SELECT id, name, qty, unit FROM pantry ORDER BY name_key');
}

// Adding an item that already exists (ignoring case) adds to its quantity.
export async function addPantryItem(db, { name, qty = 0, unit = '' }) {
  const n = String(name).trim();
  if (!n) throw new Error('empty name');
  const key = titleKey(n);
  const [existing] = await db.all('SELECT id, qty FROM pantry WHERE name_key = ?', [key]);
  if (existing) {
    await db.run('UPDATE pantry SET qty = ? WHERE id = ?', [existing.qty + qty, existing.id]);
    return existing.id;
  }
  return (await db.run('INSERT INTO pantry(name, name_key, qty, unit) VALUES (?, ?, ?, ?)', [n, key, qty, unit])).lastInsertId;
}

export async function updatePantryItem(db, id, { name, qty, unit }) {
  const sets = [];
  const params = [];
  if (name !== undefined) { sets.push('name = ?', 'name_key = ?'); params.push(name.trim(), titleKey(name)); }
  if (qty !== undefined) { sets.push('qty = ?'); params.push(qty); }
  if (unit !== undefined) { sets.push('unit = ?'); params.push(unit); }
  if (sets.length) await db.run(`UPDATE pantry SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

export async function deletePantryItem(db, id) {
  await db.run('DELETE FROM pantry WHERE id = ?', [id]);
}

const parseRow = (r) => (r ? { ...r, ingredients: JSON.parse(r.ingredients) } : null);
const FIELDS = ['servings', 'steps', 'kcal', 'protein', 'carbs', 'fat', 'cost'];

export async function getRecipe(db, id) {
  const [r] = await db.all('SELECT * FROM recipes WHERE id = ?', [id]);
  return parseRow(r);
}

export async function listRecipes(db) {
  return (await db.all('SELECT * FROM recipes ORDER BY title_key')).map(parseRow);
}

export async function createRecipe(db, r) {
  const title = String(r.title || '').trim();
  if (!title) throw new Error('empty title');
  const [dup] = await db.all('SELECT id FROM recipes WHERE title_key = ?', [titleKey(title)]);
  if (dup) throw new Error('duplicate title');
  const res = await db.run(
    'INSERT INTO recipes(title, title_key, servings, ingredients, steps, kcal, protein, carbs, fat, cost, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [title, titleKey(title), r.servings || 1, JSON.stringify(r.ingredients || []), r.steps || '', r.kcal || 0, r.protein || 0, r.carbs || 0, r.fat || 0, r.cost || 0, Date.now()]);
  return getRecipe(db, res.lastInsertId);
}

export async function updateRecipe(db, id, fields) {
  const sets = [];
  const params = [];
  if (fields.title !== undefined) {
    const title = String(fields.title).trim();
    if (!title) throw new Error('empty title');
    const [dup] = await db.all('SELECT id FROM recipes WHERE title_key = ?', [titleKey(title)]);
    if (dup && dup.id !== id) throw new Error('duplicate title');
    sets.push('title = ?', 'title_key = ?');
    params.push(title, titleKey(title));
  }
  if (fields.ingredients !== undefined) { sets.push('ingredients = ?'); params.push(JSON.stringify(fields.ingredients)); }
  for (const f of FIELDS) if (fields[f] !== undefined) { sets.push(`${f} = ?`); params.push(fields[f]); }
  if (sets.length) await db.run(`UPDATE recipes SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  return getRecipe(db, id);
}

export async function deleteRecipe(db, id) {
  await db.run('DELETE FROM recipes WHERE id = ?', [id]);
}

// "I cooked this": take the used ingredients out of the pantry.
export async function cookRecipe(db, id, servings) {
  const recipe = await getRecipe(db, id);
  if (!recipe) throw new Error('recipe not found');
  const changes = deductPantry(recipe, await listPantry(db), servings);
  if (changes.length) await db.batch(changes.map(c => ({ sql: 'UPDATE pantry SET qty = ? WHERE id = ?', params: [c.qty, c.id] })));
  return changes.length;
}

export async function cookingSearch(db, q) {
  const needle = q.toLowerCase();
  return (await listRecipes(db))
    .filter(r => r.title.toLowerCase().includes(needle) || r.ingredients.some(i => i.name.toLowerCase().includes(needle)))
    .slice(0, 15)
    .map(r => ({ module: 'cooking', id: r.id, title: r.title, snippet: r.ingredients.slice(0, 5).map(i => i.name).join(', ') }));
}
