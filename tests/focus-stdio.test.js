import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createHelperClient } from '../src/modules/focus/helper-client.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = ['focus-helper', 'focus-helper.exe'].map((n) => join(root, 'target', 'debug', n)).find(existsSync);

test('JS client and Rust helper agree on the wire format', { skip: exe ? false : 'focus-helper binary not built' }, async (t) => {
  const state = join(mkdtempSync(join(tmpdir(), 'focus-stdio-')), 'state.json');
  const child = spawn(exe, ['stdio', '--state', state], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  t.after(() => { child.stdin.end(); child.kill(); });
  const call = async (json) => {
    child.stdin.write(json + '\n');
    const { value, done } = await lines.next();
    if (done) throw new Error('helper closed');
    return value;
  };
  const client = createHelperClient(call);
  const vectors = JSON.parse(readFileSync(join(root, 'tests/fixtures/unlock-vectors.json'), 'utf8'));
  const valid = vectors.find((v) => v.name === 'valid');

  assert.deepEqual(await client.setPartner(valid.publicKey), { type: 'Ok' });
  const now = Date.now();
  const w = { id: 'w-e2e', starts: now - 3600000, ends: now + 3600000, lock: 'locked', mode: 'block', sites: ['example.com'], apps: [] };
  assert.deepEqual(await client.pushWindows([w]), { type: 'Ok' });
  let s = await client.status();
  assert.equal(s.type, 'Status');
  assert.ok(s.windows.some((x) => x.id === 'w-e2e'));
  assert.ok(s.decision.blockSites.includes('example.com'));
  assert.equal(s.partner_set, true);

  await client.pushWindows([]);
  s = await client.status();
  assert.ok(s.windows.some((x) => x.id === 'w-e2e'), 'locked window cannot be removed by push');

  await assert.rejects(client.submitToken('garbage'), (e) => e.code === 'bad-format');
});
