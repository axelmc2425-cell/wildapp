import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { helperPaths } from '../scripts/stage-helper.mjs';

test('helperPaths names the staged exe and the cargo output per platform', () => {
  assert.equal(helperPaths('win32').source, join('target', 'release', 'focus-helper.exe'));
  assert.equal(helperPaths('linux').source, join('target', 'release', 'focus-helper'));
  for (const p of ['win32', 'linux', 'darwin']) {
    assert.equal(helperPaths(p).destination, join('src-tauri', 'resources', 'focus-helper.exe'));
  }
});
