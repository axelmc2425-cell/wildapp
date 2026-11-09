import test from 'node:test';
import assert from 'node:assert/strict';
import { describeLastSync, detailsSignature } from '../src/modules/focus/ui/helper-details.js';
import { chipSummary, formatClock, minutesLeft } from '../src/modules/focus/ui/util.js';

test('chipSummary caps and counts the rest', () => {
  assert.deepEqual(chipSummary(['a', 'b', 'c'], 2), { shown: ['a', 'b'], more: 1 });
  assert.deepEqual(chipSummary(['a'], 6), { shown: ['a'], more: 0 });
  assert.deepEqual(chipSummary([], 6), { shown: [], more: 0 });
  assert.deepEqual(chipSummary(null, 6), { shown: [], more: 0 });
  assert.deepEqual(chipSummary([1, 2, 3, 4, 5, 6, 7, 8], 6).more, 2);
});

test('formatClock never throws on absurd times', () => {
  for (const v of [NaN, Infinity, -Infinity, 8.64e15 + 1, 'x', null, undefined]) assert.equal(formatClock(v), 'later');
  assert.match(formatClock(Date.UTC(2026, 0, 1, 12, 0)), /\d{1,2}:\d{2}/);
});

test('minutesLeft rounds up and clamps', () => {
  assert.equal(minutesLeft(1), 1);
  assert.equal(minutesLeft(60000), 1);
  assert.equal(minutesLeft(60001), 2);
  assert.equal(minutesLeft(-5), 0);
  assert.equal(minutesLeft(NaN), 0);
});

test('describeLastSync', () => {
  assert.equal(describeLastSync(null), null);
  assert.equal(describeLastSync(undefined), null);
  assert.equal(describeLastSync({ pushed: 3, skipped: 1 }), 'Last sync: 3 windows sent, 1 skipped');
  assert.equal(describeLastSync({ pushed: 1, skipped: 0 }), 'Last sync: 1 window sent, 0 skipped');
});

test('detailsSignature changes only with visible content', () => {
  const ok = { helper: { kind: 'ok', status: { decision: {}, windows: [], partner_set: false, now_ms: 0, warnings: [] } }, syncPending: false, lastSync: null };
  assert.equal(detailsSignature(ok), detailsSignature(JSON.parse(JSON.stringify(ok))));
  assert.notEqual(detailsSignature(ok), detailsSignature({ ...ok, syncPending: true }));
  assert.notEqual(detailsSignature(ok), detailsSignature({ ...ok, lastSync: { pushed: 1, skipped: 0 } }));
  assert.notEqual(detailsSignature(ok), detailsSignature({ ...ok, helper: { kind: 'not-running' } }));
});
