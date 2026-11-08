import test from 'node:test';
import assert from 'node:assert/strict';
import { entriesToFiles, textsToEntries, summarizeImport, quickTitle } from '../src/core/filebridge.js';

test('entriesToFiles turns number arrays into Uint8Array bytes', () => {
  const [f] = entriesToFiles([{ path: 'a.md', bytes: [104, 105] }]);
  assert.equal(f.path, 'a.md');
  assert.ok(f.bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(f.bytes), 'hi');
});

test('textsToEntries encodes UTF-8 text as number arrays', () => {
  const [e] = textsToEntries([{ path: 'é.md', text: 'bêta' }]);
  assert.equal(e.path, 'é.md');
  assert.deepEqual(e.bytes, [...new TextEncoder().encode('bêta')]);
});

test('summarizeImport names counts and the first skipped files', () => {
  assert.equal(summarizeImport({ created: 1, skipped: [] }), 'Imported 1 note.');
  assert.equal(summarizeImport({ created: 3, skipped: [] }), 'Imported 3 notes.');
  const s = summarizeImport({ created: 2, skipped: [{ path: 'a.md', reason: 'already exists' }, { path: 'b.md', reason: 'not UTF-8' }] });
  assert.equal(s, 'Imported 2 notes. Skipped 2: a.md (already exists), b.md (not UTF-8).');
});

test('summarizeImport truncates a long skipped list', () => {
  const skipped = Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.md`, reason: 'x' }));
  const s = summarizeImport({ created: 0, skipped });
  assert.ok(s.includes('and 3 more'), s);
  assert.ok(s.startsWith('Imported 0 notes. Skipped 8:'), s);
});

test('quickTitle uses the local date and time', () => {
  assert.equal(quickTitle(new Date(2026, 0, 5, 9, 7)), 'Quick 2026-01-05 09:07');
});
