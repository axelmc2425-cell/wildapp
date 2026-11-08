import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrate } from '../src/core/schema.js';
import { review, addDays, dayKey, GRADES } from '../src/modules/skills/sm2.js';
import { levelFor } from '../src/modules/skills/levels.js';
import { buildTree, canMove } from '../src/modules/skills/tree.js';
import {
  createSkill, renameSkill, moveSkill, deleteSkill, listSkills, logPractice, listPractice, deletePractice,
  practiceTotals, addCard, listCards, dueCards, reviewCard, deleteCard, skillsSearch,
} from '../src/modules/skills/repo.js';

async function fresh() {
  const db = await openNodeDb(join(mkdtempSync(join(tmpdir(), 'mybrain-')), 't.db'));
  await migrate(db);
  return db;
}

const fresh0 = { ease: 2.5, interval: 0, reps: 0 };

test('addDays and dayKey work on local calendar days, across month and year ends', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(dayKey(new Date(2026, 4, 9, 23, 30)), '2026-05-09');
});

test('SM-2: good answers give 1 day, then 6 days, then interval times ease', () => {
  const a = review(fresh0, GRADES.good, '2026-06-01');
  assert.deepEqual([a.reps, a.interval, a.due], [1, 1, '2026-06-02']);
  const b = review(a, GRADES.good, '2026-06-02');
  assert.deepEqual([b.reps, b.interval, b.due], [2, 6, '2026-06-08']);
  const c = review(b, GRADES.good, '2026-06-08');
  assert.equal(c.reps, 3);
  assert.equal(c.interval, Math.round(6 * b.ease));
});

test('SM-2: a failed answer restarts the card for tomorrow and lowers ease, never below 1.3', () => {
  const learned = { ease: 2.5, interval: 30, reps: 5 };
  const f = review(learned, GRADES.again, '2026-06-01');
  assert.deepEqual([f.reps, f.interval, f.due], [0, 1, '2026-06-02']);
  assert.ok(Math.abs(f.ease - 2.3) < 1e-9);
  let e = { ease: 1.35, interval: 3, reps: 2 };
  for (let i = 0; i < 5; i++) e = review(e, GRADES.again, '2026-06-01');
  assert.equal(e.ease, 1.3);
});

test('SM-2: ease rises for easy answers, stays for good ones and falls for hard ones', () => {
  assert.ok(review(fresh0, GRADES.easy, '2026-06-01').ease > 2.5);
  assert.ok(Math.abs(review(fresh0, GRADES.good, '2026-06-01').ease - 2.5) < 1e-9);
  assert.ok(review(fresh0, GRADES.hard, '2026-06-01').ease < 2.5);
});

test('levelFor maps practice minutes to a level, a name and progress to the next one', () => {
  assert.deepEqual([levelFor(0).level, levelFor(0).name], [0, 'Curious']);
  assert.equal(levelFor(59).level, 0);
  assert.equal(levelFor(60).level, 1);
  const l = levelFor(10 * 60);
  assert.equal(l.level, 3);
  assert.equal(l.nextAtHours, 25);
  assert.ok(l.progress >= 0 && l.progress < 1);
  assert.equal(levelFor(1_000_000).level, 9);
  assert.equal(levelFor(1_000_000).progress, 1);
});

const skills = [
  { id: 1, name: 'Music', parent_id: null }, { id: 2, name: 'Guitar', parent_id: 1 },
  { id: 3, name: 'Chords', parent_id: 2 }, { id: 4, name: 'Cooking', parent_id: null },
];

test('buildTree nests skills and rolls practice minutes up to parents', () => {
  const tree = buildTree(skills, new Map([[3, 120], [2, 60], [4, 30]]));
  assert.deepEqual(tree.map(n => n.name), ['Cooking', 'Music']);
  const music = tree.find(n => n.name === 'Music');
  assert.equal(music.totalMinutes, 180);
  assert.equal(music.minutes, 0);
  assert.equal(music.children[0].children[0].name, 'Chords');
  assert.equal(music.children[0].depth, 1);
});

test('buildTree survives an orphan whose parent is missing', () => {
  const tree = buildTree([{ id: 9, name: 'Lost', parent_id: 99 }], new Map());
  assert.deepEqual(tree.map(n => n.name), ['Lost']);
});

test('canMove refuses moving a skill under itself or its own descendant', () => {
  assert.equal(canMove(skills, 1, 3), false);
  assert.equal(canMove(skills, 1, 1), false);
  assert.equal(canMove(skills, 3, 4), true);
  assert.equal(canMove(skills, 3, null), true);
});

test('skills: create, rename, move (with cycle guard) and list', async () => {
  const db = await fresh();
  const music = await createSkill(db, { name: 'Music' });
  const guitar = await createSkill(db, { name: 'Guitar', parentId: music.id });
  await renameSkill(db, guitar.id, 'Acoustic guitar');
  assert.equal((await listSkills(db)).find(s => s.id === guitar.id).name, 'Acoustic guitar');
  await assert.rejects(moveSkill(db, music.id, guitar.id), /cycle/);
  await moveSkill(db, guitar.id, null);
  assert.equal((await listSkills(db)).find(s => s.id === guitar.id).parent_id, null);
  await assert.rejects(createSkill(db, { name: '  ' }), /empty name/);
});

test('deleting a skill removes its descendants, practice and cards', async () => {
  const db = await fresh();
  const a = await createSkill(db, { name: 'A' });
  const b = await createSkill(db, { name: 'B', parentId: a.id });
  const keep = await createSkill(db, { name: 'Keep' });
  await logPractice(db, { skillId: b.id, minutes: 30, day: '2026-06-01' });
  await addCard(db, { skillId: b.id, front: 'q', back: 'a' }, '2026-06-01');
  await logPractice(db, { skillId: keep.id, minutes: 10, day: '2026-06-01' });
  await deleteSkill(db, a.id);
  assert.deepEqual((await listSkills(db)).map(s => s.name), ['Keep']);
  assert.equal((await db.all('SELECT * FROM practice')).length, 1);
  assert.equal((await db.all('SELECT * FROM cards')).length, 0);
});

test('practice: log, list newest first, totals per skill, delete; bad minutes are rejected', async () => {
  const db = await fresh();
  const s = await createSkill(db, { name: 'Chess' });
  await logPractice(db, { skillId: s.id, minutes: 20, day: '2026-06-01', note: 'openings' });
  const p2 = await logPractice(db, { skillId: s.id, minutes: 40, day: '2026-06-02' });
  assert.deepEqual((await listPractice(db, s.id)).map(p => p.minutes), [40, 20]);
  assert.equal((await practiceTotals(db)).get(s.id), 60);
  await deletePractice(db, p2.id);
  assert.equal((await practiceTotals(db)).get(s.id), 20);
  await assert.rejects(logPractice(db, { skillId: s.id, minutes: 0, day: '2026-06-01' }), /minutes/);
});

test('cards: new cards are due today; reviewing schedules them and removes them from today\'s queue', async () => {
  const db = await fresh();
  const s = await createSkill(db, { name: 'Spanish' });
  const c1 = await addCard(db, { skillId: s.id, front: 'hola', back: 'hello' }, '2026-06-01');
  await addCard(db, { skillId: s.id, front: 'adios', back: 'bye' }, '2026-06-01');
  assert.equal((await dueCards(db, '2026-06-01')).length, 2);
  assert.equal((await dueCards(db, '2026-06-01'))[0].skillName, 'Spanish');
  const r = await reviewCard(db, c1.id, GRADES.good, '2026-06-01');
  assert.equal(r.due, '2026-06-02');
  assert.equal((await dueCards(db, '2026-06-01')).length, 1);
  assert.equal((await dueCards(db, '2026-06-02')).length, 2);
  await deleteCard(db, c1.id);
  assert.equal((await listCards(db, s.id)).length, 1);
  await assert.rejects(addCard(db, { skillId: s.id, front: ' ', back: 'x' }, '2026-06-01'), /front/);
});

test('skillsSearch finds skills and cards', async () => {
  const db = await fresh();
  const s = await createSkill(db, { name: 'Spanish' });
  await addCard(db, { skillId: s.id, front: 'la biblioteca', back: 'library' }, '2026-06-01');
  assert.equal((await skillsSearch(db, 'spani'))[0].title, 'Spanish');
  assert.equal((await skillsSearch(db, 'LIBRARY'))[0].id, s.id);
  assert.deepEqual(await skillsSearch(db, 'zzz'), []);
});
