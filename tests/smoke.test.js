import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

test('node:sqlite is available', () => {
  assert.equal(typeof DatabaseSync, 'function');
});
