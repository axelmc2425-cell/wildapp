import test from 'node:test';
import assert from 'node:assert/strict';
import { relatedNotes } from '../src/modules/secondbrain/resurface.js';

const note = (id, title, body, tags = [], updated = id) => ({ id, title, body, tags, created: 1, updated });

test('relatedNotes ranks shared tags above shared words', () => {
  const cur = note(1, 'Current', 'quantum entanglement experiments', ['physics']);
  const tagged = note(2, 'Tagged', 'unrelated text', ['physics']);
  const worded = note(3, 'Worded', 'notes about quantum experiments', []);
  const res = relatedNotes(cur, [tagged, worded]);
  assert.deepEqual(res.map(r => r.note.id), [2, 3]);
  assert.equal(res[0].score, 3);
  assert.equal(res[1].score, 2);
});

test('relatedNotes on a one-note list returns []', () => {
  const cur = note(1, 'Only', 'hello world');
  assert.deepEqual(relatedNotes(cur, [cur]), []);
});

test('relatedNotes ignores the current note even with a self-link', () => {
  const cur = note(1, 'Self', 'talks about [[Self]] and gardening', ['a']);
  assert.deepEqual(relatedNotes(cur, [cur]), []);
});

test('relatedNotes drops zero scores and honours the limit', () => {
  const cur = note(1, 'C', 'gardening tomatoes', ['g']);
  const others = [2, 3, 4, 5, 6, 7, 8].map(i => note(i, 'N' + i, 'gardening', []));
  others.push(note(9, 'None', 'completely different', []));
  const res = relatedNotes(cur, others, 5);
  assert.equal(res.length, 5);
  assert.ok(!res.some(r => r.note.id === 9));
});

test('relatedNotes ties go to the newest note', () => {
  const cur = note(1, 'C', 'gardening', []);
  const old = note(2, 'Old', 'gardening', [], 10);
  const recent = note(3, 'Recent', 'gardening', [], 20);
  assert.deepEqual(relatedNotes(cur, [old, recent]).map(r => r.note.id), [3, 2]);
});

test('relatedNotes ignores stop words and short words', () => {
  const cur = note(1, 'C', 'this that with from the and', []);
  const other = note(2, 'O', 'this that with from the and', []);
  assert.deepEqual(relatedNotes(cur, [other]), []);
});
