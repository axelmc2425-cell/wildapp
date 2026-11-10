import test from 'node:test';
import assert from 'node:assert/strict';
import { canStart, resolveMinutes, listSummary, endsAtText } from '../src/modules/focus/ui/start-logic.js';
import { formatClock } from '../src/modules/focus/ui/util.js';

test('listSummary pluralises and omits zero parts', () => {
  assert.equal(listSummary({ sites: new Array(14), apps: new Array(3) }), '14 sites, 3 apps');
  assert.equal(listSummary({ sites: ['a'], apps: [] }), '1 site');
  assert.equal(listSummary({ sites: [], apps: ['a', 'b', 'c'] }), '3 apps');
  assert.equal(listSummary({ sites: ['a'], apps: ['a', 'b'] }), '1 site, 2 apps');
  assert.equal(listSummary({ sites: [], apps: [] }), 'Empty list');
  assert.equal(listSummary({}), 'Empty list');
});

test('resolveMinutes: custom wins, preset otherwise, messages from the model', () => {
  assert.deepEqual(resolveMinutes({ preset: 60, custom: '' }), { ok: true, minutes: 60 });
  assert.deepEqual(resolveMinutes({ preset: 60, custom: '90' }), { ok: true, minutes: 90 });
  for (const c of ['abc', '0', '1441', '1.5']) {
    const r = resolveMinutes({ preset: 60, custom: c });
    assert.equal(r.ok, false);
    assert.equal(r.message, 'Enter a whole number of minutes from 1 to 1440.');
  }
  assert.equal(resolveMinutes({}).ok, false);
});

test('canStart needs a list and a valid duration', () => {
  assert.equal(canStart({ selectedIds: [1], duration: { ok: true, minutes: 5 } }), true);
  assert.equal(canStart({ selectedIds: [], duration: { ok: true, minutes: 5 } }), false);
  assert.equal(canStart({ selectedIds: [1], duration: { ok: false } }), false);
  assert.equal(canStart({}), false);
});

test('endsAtText', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0);
  assert.equal(endsAtText(now, 25), `Ends at ${formatClock(now + 25 * 60000)}`);
  assert.equal(endsAtText(now, NaN), '');
});

test('listSummary counts folders and a folder-only list is not empty', () => {
  assert.equal(listSummary({ sites: [], apps: [], folders: ['C:\\A'] }), '1 folder');
  assert.equal(listSummary({ sites: new Array(2), apps: [], folders: ['C:\\A', 'C:\\B'] }), '2 sites, 2 folders');
  assert.equal(listSummary({ sites: [], apps: [] }), 'Empty list');
});
