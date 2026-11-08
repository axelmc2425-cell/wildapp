import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrate } from '../src/core/schema.js';
import { createNote, saveNote } from '../src/modules/secondbrain/notes.js';
import { graphData, layoutGraph } from '../src/modules/secondbrain/graph.js';

async function fresh() {
  const db = await openNodeDb(join(mkdtempSync(join(tmpdir(), 'mybrain-')), 't.db'));
  await migrate(db);
  return db;
}

test('empty database gives empty nodes and a layout of size 0', async () => {
  const db = await fresh();
  const g = await graphData(db, {});
  assert.deepEqual(g, { nodes: [], edges: [] });
  assert.equal(layoutGraph(g.nodes, g.edges, { width: 400, height: 300 }).size, 0);
});

test('self-link produces no edge', async () => {
  const db = await fresh();
  const a = await createNote(db, { title: 'A' });
  await saveNote(db, a.id, { body: '[[A]]' });
  assert.deepEqual((await graphData(db, {})).edges, []);
});

test('edges connect linked notes', async () => {
  const db = await fresh();
  const a = await createNote(db, { title: 'A' });
  const b = await createNote(db, { title: 'B' });
  await saveNote(db, a.id, { body: '[[B]]' });
  assert.deepEqual((await graphData(db, {})).edges, [{ from: a.id, to: b.id }]);
});

test('tag filter drops edges to excluded notes', async () => {
  const db = await fresh();
  const a = await createNote(db, { title: 'A', body: '#x' });
  await createNote(db, { title: 'B' });
  await saveNote(db, a.id, { body: '#x [[B]]' });
  const g = await graphData(db, { tag: 'x' });
  assert.deepEqual(g.nodes.map(n => n.title), ['A']);
  assert.deepEqual(g.edges, []);
});

test('layout is deterministic for the same input', () => {
  const nodes = [1, 2, 3, 4].map(id => ({ id, title: 'n' + id, tags: [] }));
  const edges = [{ from: 1, to: 2 }, { from: 2, to: 3 }];
  const a = layoutGraph(nodes, edges, { width: 400, height: 300 });
  const b = layoutGraph(nodes, edges, { width: 400, height: 300 });
  assert.deepEqual([...a], [...b]);
});

test('every point is within width and height', () => {
  const nodes = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, title: 'n', tags: [] }));
  const edges = nodes.slice(1).map(n => ({ from: 1, to: n.id }));
  for (const p of layoutGraph(nodes, edges, { width: 400, height: 300 }).values()) {
    assert.ok(p.x >= 0 && p.x <= 400 && p.y >= 0 && p.y <= 300, JSON.stringify(p));
  }
});

test('single node is centered', () => {
  const m = layoutGraph([{ id: 7, title: 'x', tags: [] }], [], { width: 400, height: 300 });
  assert.deepEqual(m.get(7), { x: 200, y: 150 });
});

test('layout keeps points inside the margin option', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: 'n', tags: [] }));
  const edges = nodes.slice(1).map(n => ({ from: 1, to: n.id }));
  for (const p of layoutGraph(nodes, edges, { width: 600, height: 400, margin: 60 }).values()) {
    assert.ok(p.x >= 60 && p.x <= 540 && p.y >= 60 && p.y <= 340, JSON.stringify(p));
  }
});

test('layout of 1500 nodes finishes quickly', () => {
  const nodes = Array.from({ length: 1500 }, (_, i) => ({ id: i + 1, title: 'n', tags: [] }));
  const edges = nodes.slice(1).map((n, i) => ({ from: 1 + (i % 50), to: n.id }));
  const t = Date.now();
  const m = layoutGraph(nodes, edges, { width: 1000, height: 800 });
  assert.equal(m.size, 1500);
  assert.ok(Date.now() - t < 4000, 'took ' + (Date.now() - t) + ' ms');
});
