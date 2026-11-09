import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTzOffsetAt } from '../src/modules/focus/tz.js';

test('UTC is zero', () => {
  assert.equal(makeTzOffsetAt('UTC')(0), 0);
});

test('New York is -300 in winter and -240 in summer', () => {
  const f = makeTzOffsetAt('America/New_York');
  assert.equal(f(Date.UTC(2026, 0, 15, 12)), -300);
  assert.equal(f(Date.UTC(2026, 6, 15, 12)), -240);
});

test('Kolkata is +330', () => {
  assert.equal(makeTzOffsetAt('Asia/Kolkata')(Date.UTC(2026, 0, 15, 12)), 330);
});

test('offset changes across the US spring-forward boundary', () => {
  const f = makeTzOffsetAt('America/New_York');
  assert.equal(f(Date.UTC(2026, 2, 8, 6, 59)), -300);
  assert.equal(f(Date.UTC(2026, 2, 8, 7, 1)), -240);
});

test('local midnight does not read as hour 24', () => {
  // 2026-01-01T00:00 in UTC and in Tokyo (15:00 UTC the day before)
  assert.equal(makeTzOffsetAt('UTC')(Date.UTC(2026, 0, 1, 0, 0)), 0);
  assert.equal(makeTzOffsetAt('Asia/Tokyo')(Date.UTC(2025, 11, 31, 15, 0)), 540);
});

test('default zone returns a finite number', () => {
  assert.ok(Number.isFinite(makeTzOffsetAt()(Date.now())));
});
