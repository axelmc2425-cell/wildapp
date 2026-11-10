// End-to-end: app folder rules against the real focus-helper over stdio (Linux, fake Windows paths: the helper
// only validates, stores and reports them here; killing by path is checked on Windows, see the checklist).
// Skips like the locks e2e unless the helper is the test-clock build (same probe).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStdioCall } from '../scripts/helper-bridge.mjs';
import { createHelperClient } from '../src/modules/focus/helper-client.js';
import { generatePartnerKeys } from '../src/modules/focus/unlock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = ['focus-helper', 'focus-helper.exe'].map((n) => join(root, 'target', 'debug', n)).find(existsSync);
const DAY = 86400000;

async function probe() {
  if (!exe) return 'focus-helper binary not built';
  const dir = mkdtempSync(join(tmpdir(), 'focus-folders-probe-'));
  const b = createStdioCall(exe, join(dir, 'state.json'));
  try {
    const res = JSON.parse(await b.call(JSON.stringify({ type: 'AdvanceClock', ms: 0 })));
    if (res.type === 'Ok') return false;
    if (res.type === 'Error' && res.code === 'bad-request') return 'focus-helper was built without --features test-clock (AdvanceClock: bad-request)';
    throw new Error(`unexpected AdvanceClock reply: ${JSON.stringify(res)}`);
  } finally {
    await b.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
const skip = await probe();
const T = { skip };

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'focus-folders-e2e-'));
  const bridge = createStdioCall(exe, join(dir, 'state.json'));
  t.after(async () => { await bridge.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  const client = createHelperClient((line) => bridge.call(line));
  const now = (await client.status()).now_ms;
  const win = (id, folders, extra = {}) => ({
    id, starts: now - 1000, ends: now + 2 * DAY, lock: 'none', mode: 'block', sites: [], apps: [], app_folders: folders, ...extra,
  });
  return { client, win };
}

const refused = async (p) => {
  try { await p; } catch (e) { return e; }
  assert.fail('expected the helper to refuse');
};

test('a block window with a folder shows in the decision as blockFolders', T, async (t) => {
  const { client, win } = await setup(t);
  await client.pushWindows([win('w1', ['C:\\Games\\Foo'])]);
  const s = await client.status();
  assert.deepEqual(s.decision.blockFolders, ['C:\\Games\\Foo']);
  assert.deepEqual(s.windows[0].app_folders, ['C:\\Games\\Foo']);
});

test('blockFolders is absent when no active window has folders', T, async (t) => {
  const { client, win } = await setup(t);
  await client.pushWindows([win('w1', [])]);
  const s = await client.status();
  assert.equal('blockFolders' in s.decision, false);
});

test('a forbidden folder is refused with bad-window / forbidden-folder and nothing changes', T, async (t) => {
  const { client, win } = await setup(t);
  const e = await refused(client.pushWindows([win('w1', ['C:\\Windows'])]));
  assert.equal(e.code, 'bad-window');
  assert.equal(e.message, 'forbidden-folder');
  assert.deepEqual((await client.status()).windows, []);
});

test('a folder with .. is refused with bad-window / bad-folder', T, async (t) => {
  const { client, win } = await setup(t);
  const e = await refused(client.pushWindows([win('w1', ['C:\\a\\..\\b'])]));
  assert.equal(e.code, 'bad-window');
  assert.equal(e.message, 'bad-folder');
});

test('a locked window keeps its original folder when re-pushed with a different one', T, async (t) => {
  const { client, win } = await setup(t);
  const keys = await generatePartnerKeys();
  await client.setPartner(keys.publicKey);
  const locked = (folders) => win('lk', folders, { lock: 'locked', unlock_delay_ms: DAY });
  await client.pushWindows([locked(['C:\\Games\\One'])]);
  await client.pushWindows([locked(['C:\\Games\\Two'])]);
  const s = await client.status();
  assert.equal(s.windows.length, 1);
  assert.deepEqual(s.windows[0].app_folders, ['C:\\Games\\One']);
  assert.deepEqual(s.decision.blockFolders, ['C:\\Games\\One']);
});

test('case-only variants of one folder: the helper keeps both as separate entries (exact-string dedupe)', T, async (t) => {
  const { client, win } = await setup(t);
  await client.pushWindows([win('w1', ['C:\\Foo', 'c:\\foo'])]);
  const s = await client.status();
  // Accepted; no case folding in the decision list. Path matching itself is case-insensitive in the enforcer,
  // so both entries match the same programs; the duplicate is harmless.
  assert.deepEqual(s.decision.blockFolders, ['C:\\Foo', 'c:\\foo']);
});
