import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrate } from '../src/core/schema.js';
import {
  pearson, weekRange, weeklyReview, observations, promptsFor, weekSummaryText, weekdayName,
} from '../src/modules/journal/patterns.js';
import { saveEntry, getEntry, getEntryById, listEntries, deleteEntry, journalSearch } from '../src/modules/journal/repo.js';

async function fresh() {
  const db = await openNodeDb(join(mkdtempSync(join(tmpdir(), 'mybrain-')), 't.db'));
  await migrate(db);
  return db;
}

const e = (day, mood, extra = {}) => ({ day, mood, energy: null, sleep: null, text: '', tags: [], ...extra });

test('pearson correlation is 1, -1 and 0 for the obvious cases and null for too little data', () => {
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-9);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-9);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null);
  assert.equal(pearson([1], [1]), null);
});

test('weekRange runs Monday to Sunday and handles month ends and Sundays', () => {
  assert.deepEqual(weekRange('2026-06-10'), { start: '2026-06-08', end: '2026-06-14' }); // Wednesday
  assert.deepEqual(weekRange('2026-06-14'), { start: '2026-06-08', end: '2026-06-14' }); // Sunday
  assert.deepEqual(weekRange('2026-06-08'), { start: '2026-06-08', end: '2026-06-14' }); // Monday
  assert.deepEqual(weekRange('2026-07-01'), { start: '2026-06-29', end: '2026-07-05' });
  assert.equal(weekdayName('2026-06-08'), 'Monday');
});

test('weeklyReview averages ignore missing values and finds the best and hardest day', () => {
  const entries = [
    e('2026-06-08', 2, { energy: 2, sleep: 5, tags: ['work'] }), e('2026-06-09', 4, { energy: 4, sleep: 8, tags: ['work', 'run'] }),
    e('2026-06-10', 5, { energy: null, sleep: 7 }), e('2026-06-11', null), e('2026-06-20', 1),
  ];
  const r = weeklyReview(entries, '2026-06-10');
  assert.equal(r.start, '2026-06-08');
  assert.equal(r.daysLogged, 4);
  assert.ok(Math.abs(r.avgMood - 11 / 3) < 1e-9);
  assert.equal(r.avgEnergy, 3);
  assert.ok(Math.abs(r.avgSleep - 20 / 3) < 1e-9);
  assert.deepEqual(r.bestDay, { day: '2026-06-10', mood: 5 });
  assert.deepEqual(r.hardestDay, { day: '2026-06-08', mood: 2 });
  assert.deepEqual(r.topTags[0], { tag: 'work', count: 2 });
});

test('weeklyReview compares with the previous week and copes with an empty week', () => {
  const entries = [e('2026-06-01', 2), e('2026-06-02', 2), e('2026-06-08', 4), e('2026-06-09', 4)];
  const r = weeklyReview(entries, '2026-06-09');
  assert.equal(r.moodChange, 2);
  const empty = weeklyReview([], '2026-06-09');
  assert.equal(empty.daysLogged, 0);
  assert.equal(empty.avgMood, null);
  assert.equal(empty.bestDay, null);
  assert.equal(empty.moodChange, null);
});

function range(n, f) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(2026, 4, 1 + i);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push(f(i, day));
  }
  return out;
}

test('observations: notices that mood follows sleep once there is enough data', () => {
  const entries = range(14, (i, day) => (i % 2 ? e(day, 5, { sleep: 8 }) : e(day, 2, { sleep: 5 })));
  const obs = observations(entries, { now: '2026-05-20' });
  const sleep = obs.find(o => o.kind === 'sleep');
  assert.ok(sleep, JSON.stringify(obs));
  assert.match(sleep.text, /sleep/i);
  assert.match(sleep.text, /3\.0/);
});

test('observations: says nothing about sleep with fewer than 7 paired days', () => {
  const entries = range(5, (i, day) => e(day, 1 + (i % 5), { sleep: 5 + i }));
  assert.equal(observations(entries, { now: '2026-05-20' }).find(o => o.kind === 'sleep'), undefined);
});

test('observations: finds the best weekday', () => {
  // 2026-05-02 is a Saturday: make Saturdays great and the rest average.
  const entries = range(28, (i, day) => e(day, weekdayName(day) === 'Saturday' ? 5 : 3));
  const best = observations(entries, { now: '2026-05-29' }).find(o => o.kind === 'weekday');
  assert.match(best.text, /Saturdays/);
});

test('observations: words that show up on good days versus low days', () => {
  const good = (i, day) => e(day, 5, { text: 'long run with friends in the park' });
  const low = (i, day) => e(day, 1, { text: 'deadline stress and a late meeting' });
  const entries = range(8, (i, day) => (i % 2 ? good(i, day) : low(i, day)));
  const w = observations(entries, { now: '2026-05-20' }).find(o => o.kind === 'words');
  assert.match(w.text, /friends/);
  assert.match(w.text, /deadline/);
});

test('observations: reports a current journaling streak of 3 or more days, ending today or yesterday', () => {
  const entries = [e('2026-06-08', 3), e('2026-06-09', 3), e('2026-06-10', 3), e('2026-06-05', 3)];
  assert.match(observations(entries, { now: '2026-06-10' }).find(o => o.kind === 'streak').text, /3 days in a row/);
  assert.match(observations(entries, { now: '2026-06-11' }).find(o => o.kind === 'streak').text, /3 days in a row/);
  assert.equal(observations(entries, { now: '2026-06-14' }).find(o => o.kind === 'streak'), undefined);
});

test('promptsFor picks prompts from the week: low mood, poor sleep, few entries, and a default', () => {
  const low = promptsFor({ daysLogged: 5, avgMood: 2, avgSleep: 5.5, moodChange: -1 });
  assert.ok(low.some(p => /drained|hard/i.test(p)));
  assert.ok(low.some(p => /sleep/i.test(p)));
  assert.ok(promptsFor({ daysLogged: 1, avgMood: 3, avgSleep: 7, moodChange: null }).some(p => /get in the way|writing/i.test(p)));
  const happy = promptsFor({ daysLogged: 6, avgMood: 4.5, avgSleep: 8, moodChange: 1 });
  assert.ok(happy.some(p => /went well|more of/i.test(p)));
  assert.ok(promptsFor({ daysLogged: 0, avgMood: null, avgSleep: null, moodChange: null }).length >= 1);
  assert.ok(low.length <= 3);
});

test('weekSummaryText is a plain-text copy of the week with the numbers in it', () => {
  const entries = [e('2026-06-08', 2, { sleep: 6 }), e('2026-06-09', 4, { sleep: 8 })];
  const r = weeklyReview(entries, '2026-06-08');
  const text = weekSummaryText(r, [{ kind: 'streak', text: 'You have journaled 2 days in a row.' }], ['What went well?']);
  assert.match(text, /2026-06-08/);
  assert.match(text, /Average mood: 3\.0/);
  assert.match(text, /Average sleep: 7\.0/);
  assert.match(text, /journaled 2 days in a row/);
  assert.match(text, /What went well\?/);
});

// ---- repo
test('saveEntry creates then updates the same day; tags are kept as an array', async () => {
  const db = await fresh();
  await saveEntry(db, { day: '2026-06-10', mood: 4, energy: 3, sleep: 7.5, text: 'Good day', tags: ['run', 'friends'] });
  await saveEntry(db, { day: '2026-06-10', mood: 5, text: 'Great day' });
  const got = await getEntry(db, '2026-06-10');
  assert.equal(got.mood, 5);
  assert.equal(got.text, 'Great day');
  assert.equal((await listEntries(db)).length, 1);
  await saveEntry(db, { day: '2026-06-11', mood: 3, tags: ['a', 'b'] });
  assert.deepEqual((await getEntry(db, '2026-06-11')).tags, ['a', 'b']);
  assert.equal((await getEntryById(db, got.id)).day, '2026-06-10');
});

test('saveEntry rejects bad days, moods and sleep and keeps unspecified fields on update', async () => {
  const db = await fresh();
  await assert.rejects(saveEntry(db, { day: 'yesterday', mood: 3 }), /day/);
  await assert.rejects(saveEntry(db, { day: '2026-06-10', mood: 7 }), /mood/);
  await assert.rejects(saveEntry(db, { day: '2026-06-10', sleep: 30 }), /sleep/);
  await saveEntry(db, { day: '2026-06-10', mood: 4, energy: 2, sleep: 6, text: 'keep', tags: ['x'] });
  await saveEntry(db, { day: '2026-06-10', mood: 5 });
  const g = await getEntry(db, '2026-06-10');
  assert.deepEqual([g.mood, g.energy, g.sleep, g.text, g.tags], [5, 2, 6, 'keep', ['x']]);
});

test('listEntries filters by range, newest first; deleteEntry removes; search finds text, tags and days', async () => {
  const db = await fresh();
  for (const [d, t, tags] of [['2026-06-01', 'Hiking the ridge', ['outdoors']], ['2026-06-02', 'Quiet', []], ['2026-07-01', 'Moving house', ['home']]]) {
    await saveEntry(db, { day: d, mood: 3, text: t, tags });
  }
  assert.deepEqual((await listEntries(db, { from: '2026-06-01', to: '2026-06-30' })).map(x => x.day), ['2026-06-02', '2026-06-01']);
  assert.equal((await journalSearch(db, 'ridge'))[0].title, '2026-06-01');
  assert.equal((await journalSearch(db, 'HOME'))[0].title, '2026-07-01');
  assert.equal((await journalSearch(db, '2026-06-02'))[0].title, '2026-06-02');
  await deleteEntry(db, '2026-06-01');
  assert.equal(await getEntry(db, '2026-06-01'), null);
  assert.deepEqual(await journalSearch(db, 'zzz'), []);
});
