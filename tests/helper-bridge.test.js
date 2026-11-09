import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStdioCall } from '../scripts/helper-bridge.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = ['focus-helper', 'focus-helper.exe'].map((n) => join(root, 'target', 'debug', n)).find(existsSync);
const skip = exe ? false : 'focus-helper binary not built';
const mk = () => createStdioCall(exe, join(mkdtempSync(join(tmpdir(), 'helper-bridge-')), 'state.json'));

test('replies match requests under concurrent calls', { skip }, async (t) => {
  const b = mk();
  t.after(() => b.close());
  const reqs = Array.from({ length: 20 }, (_, i) => i % 2 === 0
    ? { type: 'GetStatus' }
    : { type: 'PushWindows', windows: [] });
  const replies = await Promise.all(reqs.map((r) => b.call(JSON.stringify(r))));
  replies.forEach((line, i) => {
    const m = JSON.parse(line);
    assert.equal(m.type, i % 2 === 0 ? 'Status' : 'Ok', `reply ${i}: ${line}`);
  });
});

test('close is idempotent and a call after close rejects', { skip }, async () => {
  const b = mk();
  assert.equal(JSON.parse(await b.call('{"type":"GetStatus"}')).type, 'Status');
  await b.close();
  await b.close();
  await assert.rejects(b.call('{"type":"GetStatus"}'), Error);
});

test('a call after the child died rejects', { skip }, async () => {
  const b = mk();
  await b.call('{"type":"GetStatus"}');
  await b.close();
  await assert.rejects(b.call('{"type":"GetStatus"}'), /exit|closed|helper/i);
});

test('a malformed request returns the helper bad-request error', { skip }, async (t) => {
  const b = mk();
  t.after(() => b.close());
  const m = JSON.parse(await b.call('not json'));
  assert.equal(m.type, 'Error');
  assert.equal(m.code, 'bad-request');
});
