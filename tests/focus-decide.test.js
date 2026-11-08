import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CRITICAL_APPS, decide, isBlockedSite, isBlockedApp } from '../src/modules/focus/decide.js';
import { buildVectors } from '../scripts/gen-decide-vectors.js';

const win = (o) => ({ id: 'w', starts: 1000, ends: 2000, lock: 'none', mode: 'block', sites: [], apps: [], ...o });

test('no windows gives empty decision', () => {
  assert.deepEqual(decide([], 1500), {
    blockSites: [], blockApps: [], allow: null, frozen: false, locks: [],
  });
});

test('window active at starts, inactive at ends', () => {
  const w = win({ sites: ['a.com'] });
  assert.deepEqual(decide([w], 1000).blockSites, ['a.com']);
  assert.deepEqual(decide([w], 1999).blockSites, ['a.com']);
  assert.deepEqual(decide([w], 2000).blockSites, []);
  assert.deepEqual(decide([w], 999).blockSites, []);
});

test('block wins over allow; allow windows union', () => {
  const d = decide([
    win({ id: 'b', sites: ['x.com'] }),
    win({ id: 'a1', mode: 'allow', sites: ['x.com', 'y.com'], apps: ['code.exe'] }),
    win({ id: 'a2', mode: 'allow', sites: ['z.com'] }),
  ], 1500);
  assert.deepEqual(d.allow, { sites: ['x.com', 'y.com', 'z.com'], apps: ['code.exe'] });
  assert.equal(isBlockedSite(d, 'x.com'), true);
  assert.equal(isBlockedSite(d, 'y.com'), false);
  assert.equal(isBlockedSite(d, 'other.com'), true);
});

test('arrays sorted and unique; locks listed', () => {
  const d = decide([
    win({ id: 'b', lock: 'locked', sites: ['b.com', 'a.com'] }),
    win({ id: 'a', ends: 3000, sites: ['a.com'] }),
  ], 1500);
  assert.deepEqual(d.blockSites, ['a.com', 'b.com']);
  assert.deepEqual(d.locks, [{ id: 'b', lock: 'locked', ends: 2000 }]);
});

test('frozen without allow list', () => {
  const d = decide([win({ lock: 'frozen' })], 1500);
  assert.equal(d.frozen, true);
  assert.equal(d.allow, null);
  assert.equal(isBlockedApp(d, 'notepad.exe'), true);
  assert.equal(isBlockedApp(d, 'explorer.exe'), false);
  assert.equal(isBlockedApp(d, 'MyBrain.exe'), false);
});

test('subdomain and normalized host matching', () => {
  const d = decide([win({ sites: ['reddit.com'] })], 1500);
  assert.equal(isBlockedSite(d, 'old.reddit.com'), true);
  assert.equal(isBlockedSite(d, 'OLD.Reddit.com.'), true);
  assert.equal(isBlockedSite(d, 'notreddit.com'), false);
});

test('invalid probes do not throw', () => {
  const d = decide([win({ sites: ['a.com'], apps: ['x.exe'] })], 1500);
  for (const v of ['', '.', null, undefined, 5]) {
    assert.equal(isBlockedSite(d, v), false);
    assert.equal(isBlockedApp(d, v), false);
  }
});

test('critical apps never blocked', () => {
  const frozen = decide([win({ lock: 'frozen' })], 1500);
  const allow = decide([win({ mode: 'allow', apps: ['code.exe'] })], 1500);
  const block = decide([win({ apps: CRITICAL_APPS })], 1500);
  for (const a of CRITICAL_APPS) {
    for (const d of [frozen, allow, block]) {
      assert.equal(isBlockedApp(d, a), false, a);
      assert.equal(isBlockedApp(d, a.toUpperCase()), false, a);
    }
  }
  assert.equal(isBlockedApp(allow, 'notepad.exe'), true);
  assert.equal(isBlockedApp(allow, 'C:\\Tools\\Code.EXE'), false);
});

test('vectors file matches generator and implementation', () => {
  const built = buildVectors();
  assert.ok(built.length >= 10);
  const file = JSON.parse(readFileSync(new URL('./fixtures/decide-vectors.json', import.meta.url), 'utf8'));
  assert.deepEqual(file, built);
  for (const v of file) {
    const d = decide(v.windows, v.now);
    assert.deepEqual(d, v.decision, v.name);
    for (const p of v.probes) {
      const got = p.kind === 'site' ? isBlockedSite(d, p.value) : isBlockedApp(d, p.value);
      assert.equal(got, p.blocked, `${v.name}: ${p.kind} ${p.value}`);
    }
  }
});
