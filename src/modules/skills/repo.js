import { canMove } from './tree.js';
import { review } from './sm2.js';

export async function listSkills(db) {
  return db.all('SELECT * FROM skills ORDER BY id');
}

export async function createSkill(db, { name, parentId = null }) {
  const n = String(name || '').trim();
  if (!n) throw new Error('empty name');
  const r = await db.run('INSERT INTO skills(name, parent_id, created) VALUES (?, ?, ?)', [n, parentId, Date.now()]);
  return { id: r.lastInsertId, name: n, parent_id: parentId };
}

export async function renameSkill(db, id, name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('empty name');
  await db.run('UPDATE skills SET name = ? WHERE id = ?', [n, id]);
}

export async function moveSkill(db, id, newParentId) {
  if (!canMove(await listSkills(db), id, newParentId)) throw new Error('cycle: a skill cannot move under itself');
  await db.run('UPDATE skills SET parent_id = ? WHERE id = ?', [newParentId, id]);
}

// Deletes the skill, everything under it, and their practice and cards.
export async function deleteSkill(db, id) {
  const all = await listSkills(db);
  const ids = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const s of all) if (s.parent_id != null && ids.has(s.parent_id) && !ids.has(s.id)) { ids.add(s.id); grew = true; }
  }
  const list = [...ids];
  const marks = list.map(() => '?').join(',');
  await db.batch([
    { sql: `DELETE FROM practice WHERE skill_id IN (${marks})`, params: list },
    { sql: `DELETE FROM cards WHERE skill_id IN (${marks})`, params: list },
    { sql: `DELETE FROM skills WHERE id IN (${marks})`, params: list },
  ]);
}

export async function logPractice(db, { skillId, minutes, day, note = '' }) {
  if (!(minutes > 0)) throw new Error('minutes must be positive');
  const r = await db.run('INSERT INTO practice(skill_id, minutes, day, note) VALUES (?, ?, ?, ?)', [skillId, Math.round(minutes), day, note]);
  return { id: r.lastInsertId, skill_id: skillId, minutes: Math.round(minutes), day, note };
}

export async function listPractice(db, skillId, limit = 100) {
  return db.all('SELECT * FROM practice WHERE skill_id = ? ORDER BY day DESC, id DESC LIMIT ?', [skillId, limit]);
}

export async function deletePractice(db, id) {
  await db.run('DELETE FROM practice WHERE id = ?', [id]);
}

export async function practiceTotals(db) {
  const rows = await db.all('SELECT skill_id, SUM(minutes) AS total FROM practice GROUP BY skill_id');
  return new Map(rows.map(r => [r.skill_id, r.total]));
}

export async function addCard(db, { skillId, front, back }, today) {
  const f = String(front || '').trim();
  const b = String(back || '').trim();
  if (!f) throw new Error('front is empty');
  if (!b) throw new Error('back is empty');
  const r = await db.run('INSERT INTO cards(skill_id, front, back, ease, interval, reps, due, created) VALUES (?, ?, ?, 2.5, 0, 0, ?, ?)',
    [skillId, f, b, today, Date.now()]);
  return { id: r.lastInsertId, skill_id: skillId, front: f, back: b, due: today };
}

export async function listCards(db, skillId) {
  return db.all('SELECT * FROM cards WHERE skill_id = ? ORDER BY due, id', [skillId]);
}

export async function deleteCard(db, id) {
  await db.run('DELETE FROM cards WHERE id = ?', [id]);
}

export async function dueCards(db, today, { skillId = null, limit = 200 } = {}) {
  return db.all(
    `SELECT c.*, s.name AS skillName FROM cards c JOIN skills s ON s.id = c.skill_id
     WHERE c.due <= ? ${skillId == null ? '' : 'AND c.skill_id = ?'} ORDER BY c.due, c.id LIMIT ?`,
    skillId == null ? [today, limit] : [today, skillId, limit]);
}

export async function reviewCard(db, id, grade, today) {
  const [card] = await db.all('SELECT * FROM cards WHERE id = ?', [id]);
  if (!card) throw new Error('card not found');
  const next = review(card, grade, today);
  await db.run('UPDATE cards SET ease = ?, interval = ?, reps = ?, due = ? WHERE id = ?', [next.ease, next.interval, next.reps, next.due, id]);
  return { id, ...next };
}

export async function skillsSearch(db, q) {
  const needle = q.toLowerCase();
  const skills = await listSkills(db);
  const cards = await db.all('SELECT skill_id, front, back FROM cards');
  const hits = [];
  for (const s of skills) {
    const card = cards.find(c => c.skill_id === s.id && (c.front.toLowerCase().includes(needle) || c.back.toLowerCase().includes(needle)));
    if (s.name.toLowerCase().includes(needle)) hits.push({ module: 'skills', id: s.id, title: s.name, snippet: '' });
    else if (card) hits.push({ module: 'skills', id: s.id, title: s.name, snippet: `${card.front} → ${card.back}` });
  }
  return hits.slice(0, 15);
}
