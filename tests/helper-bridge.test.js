import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
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

test('close is idempotent and a call after close rejects with "helper closed"', { skip }, async (t) => {
  const b = mk();
  t.after(() => b.close());
  assert.equal(JSON.parse(await b.call('{"type":"GetStatus"}')).type, 'Status');
  await b.close();
  await b.close();
  await assert.rejects(b.call('{"type":"GetStatus"}'), /helper closed/);
});

// Fake helpers: executable node scripts (spawned as `<script> stdio --state <path>`).
const fake = (body) => {
  const f = join(mkdtempSync(join(tmpdir(), 'fake-helper-')), 'fake.js');
  writeFileSync(f, '#!/usr/bin/env node\n' + body);
  chmodSync(f, 0o755);
  return createStdioCall(f, join(tmpdir(), 'unused-state.json'));
};
const skipFake = process.platform === 'win32' ? 'needs a shebang-executable script' : false;

test('child death rejects an in-flight call and later calls, distinct from close', { skip: skipFake }, async (t) => {
  const b = fake('setTimeout(() => {}, 60000); process.stdin.resume();');
  t.after(() => b.close());
  assert.equal(typeof b.pid, 'number');
  const inflight = b.call('{"type":"GetStatus"}');
  const settled = assert.rejects(inflight, (e) => e instanceof Error && /helper exited/.test(e.message));
  await new Promise((r) => setTimeout(r, 100));
  process.kill(b.pid, 'SIGKILL');
  await settled;
  await assert.rejects(b.call('{"type":"GetStatus"}'), (e) => /helper exited/.test(e.message) && !/closed/.test(e.message));
});

test('a reply printed just before the child exits is still delivered', { skip: skipFake }, async (t) => {
  const b = fake("process.stdin.once('data', () => { process.stdout.write('{\"type\":\"Ok\"}\\n'); process.exit(0); });");
  t.after(() => b.close());
  assert.equal(await b.call('{"type":"GetStatus"}'), '{"type":"Ok"}');
  await assert.rejects(b.call('{"type":"GetStatus"}'), /helper exited/);
});

test('a malformed request returns the helper bad-request error', { skip }, async (t) => {
  const b = mk();
  t.after(() => b.close());
  const m = JSON.parse(await b.call('not json'));
  assert.equal(m.type, 'Error');
  assert.equal(m.code, 'bad-request');
});
