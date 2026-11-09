import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrate } from '../src/core/schema.js';
import { createNote, listNotes } from '../src/modules/secondbrain/notes.js';
import { parseMarkdownFiles, importNotes, exportNotes } from '../src/modules/secondbrain/importexport.js';

const enc = (s) => new TextEncoder().encode(s);
const file = (path, text) => ({ path, bytes: enc(text) });

async function fresh() {
  const db = await openNodeDb(join(mkdtempSync(join(tmpdir(), 'mybrain-')), 't.db'));
  await migrate(db);
  return db;
}

test('CRLF file imports with LF body', () => {
  const { notes } = parseMarkdownFiles([file('a/Hello.md', 'line one\r\nline two\r\n')]);
  assert.equal(notes[0].title, 'Hello');
  assert.equal(notes[0].body, 'line one\nline two\n');
});

test('front matter title and tags are used', () => {
  const text = '---\ntitle: My Title\ntags: [alpha, beta]\n---\nBody here\n';
  const { notes } = parseMarkdownFiles([file('x.md', text)]);
  assert.equal(notes[0].title, 'My Title');
  assert.ok(notes[0].body.startsWith('Body here'));
  assert.ok(notes[0].body.includes('#alpha') && notes[0].body.includes('#beta'));
});

test('front matter tags as a list and a BOM are handled', () => {
  const text = '﻿---\ntags:\n  - one\n  - two\n---\nText';
  const { notes } = parseMarkdownFiles([file('List.md', text)]);
  assert.equal(notes[0].title, 'List');
  assert.ok(notes[0].body.includes('#one') && notes[0].body.includes('#two'));
});

test('a non-UTF8 file is skipped and reported', () => {
  const bad = { path: 'bad.md', bytes: new Uint8Array([0xff, 0xfe, 0xfd, 0x80]) };
  const r = parseMarkdownFiles([bad, file('ok.md', 'fine')]);
  assert.deepEqual(r.notes.map(n => n.title), ['ok']);
  assert.deepEqual(r.skipped, [{ path: 'bad.md', reason: 'not UTF-8' }]);
});

test('two files titled Ideas become Ideas and Ideas (2)', () => {
  const r = parseMarkdownFiles([file('a/Ideas.md', '1'), file('b/Ideas.md', '2'), file('c/ideas.md', '3')]);
  assert.deepEqual(r.notes.map(n => n.title), ['Ideas', 'Ideas (2)', 'ideas (3)']);
});

test('importNotes creates notes and skips titles that already exist', async () => {
  const db = await fresh();
  await createNote(db, { title: 'Exists', body: 'keep me' });
  const r = await importNotes(db, [file('Exists.md', 'new'), file('Fresh.md', 'hello [[Exists]]')]);
  assert.equal(r.created, 1);
  assert.deepEqual(r.skipped, [{ path: 'Exists.md', reason: 'already exists' }]);
  assert.equal((await listNotes(db)).length, 2);
});

test('export then import round-trips titles and bodies', async () => {
  const notes = [
    { id: 1, title: 'Plain', body: 'a\n#tag\n', tags: ['tag'], created: 1, updated: 1 },
    { id: 2, title: 'Odd: "title" / with *chars*', body: 'b', tags: [], created: 1, updated: 1 },
  ];
  const files = exportNotes(notes).map(f => ({ path: f.path, bytes: enc(f.text) }));
  const back = parseMarkdownFiles(files).notes;
  assert.deepEqual(back.map(n => [n.title, n.body]), notes.map(n => [n.title, n.body]));
});

test('export file names never contain reserved characters and collisions are suffixed', () => {
  const notes = [
    { id: 1, title: 'a/b', body: '', tags: [], created: 1, updated: 1 },
    { id: 2, title: 'a-b', body: '', tags: [], created: 1, updated: 1 },
    { id: 3, title: 'what?*"<>|:\\', body: '', tags: [], created: 1, updated: 1 },
  ];
  const paths = exportNotes(notes).map(f => f.path);
  assert.deepEqual(paths.slice(0, 2), ['a-b.md', 'a-b (2).md']);
  for (const p of paths) assert.ok(!/[\\/:*?"<>|]/.test(p), p);
});

test('export prefixes Windows reserved names and shortens very long titles', () => {
  const mk = (id, title) => ({ id, title, body: '', tags: [], created: 1, updated: 1 });
  const paths = exportNotes([mk(1, 'CON'), mk(2, 'aux'), mk(3, 'Nul'), mk(4, 'x'.repeat(400)), mk(5, 'com1')]).map(f => f.path);
  for (const p of paths.slice(0, 3).concat(paths[4])) assert.ok(/^_/.test(p), p);
  assert.ok(paths[3].length <= 130, String(paths[3].length));
});

test('export never produces the same file name twice, even for look-alike titles', () => {
  const mk = (id, title) => ({ id, title, body: '', tags: [], created: 1, updated: 1 });
  const paths = exportNotes([mk(1, 'a?'), mk(2, 'a*'), mk(3, 'a- (2)'), mk(4, 'A-')]).map(f => f.path.toLowerCase());
  assert.equal(new Set(paths).size, paths.length, paths.join(' | '));
});

test('importNotes relinks once at the end and backlinks to later files still resolve', async () => {
  const db = await fresh();
  const counting = {
    scans: 0,
    all(sql, p) { if (sql.includes("body LIKE '%[[%'")) this.scans++; return db.all(sql, p); },
    run: (...a) => db.run(...a),
    batch: (...a) => db.batch(...a),
  };
  const files = [file('A.md', 'goes to [[B]] and [[C]]'), file('B.md', 'b'), file('C.md', 'c'), file('D.md', 'd'), file('E.md', 'e')];
  const r = await importNotes(counting, files);
  assert.equal(r.created, 5);
  assert.ok(counting.scans <= 1, 'scans: ' + counting.scans);
  const { backlinks, findNoteByTitle } = await import('../src/modules/secondbrain/notes.js');
  const b = await findNoteByTitle(db, 'B');
  assert.deepEqual((await backlinks(db, b.id)).map(n => n.title), ['A']);
});
