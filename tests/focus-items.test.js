import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validItem, validateItems, validateForPush, MAX_ITEMS_PER_WINDOW } from '../src/modules/focus/limits.js';
import { normalizeDomain } from '../src/modules/focus/match.js';
import { CRITICAL_APPS } from '../src/modules/focus/decide.js';
import { buildItemVectors } from '../scripts/gen-item-vectors.js';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/item-vectors.json', import.meta.url), 'utf8'));
const win = (o = {}) => ({ id: 'w', starts: 1, ends: 2, lock: 'none', mode: 'block', sites: [], apps: [], ...o });

test('shared item vectors match the generator and validItem', () => {
  assert.deepEqual(vectors, buildItemVectors());
  for (const v of vectors) assert.equal(validItem(v.kind, v.value), v.valid, `${v.kind} ${JSON.stringify(v.value)}`);
  assert.ok(vectors.some((v) => v.kind === 'app' && v.value === 'League of Legends.exe' && v.valid));
});

test('validateItems rejects bad entries and over-cap windows', () => {
  assert.deepEqual(validateItems(win({ apps: ['League of Legends.exe'] })), { ok: true });
  assert.deepEqual(validateItems(win({ sites: ['a/b'] })), { ok: false, reason: 'bad-item' });
  assert.deepEqual(validateItems(win({ apps: ['a:b'] })), { ok: false, reason: 'bad-item' });
  const sites = Array.from({ length: MAX_ITEMS_PER_WINDOW + 1 }, (_, i) => `s${i}.com`);
  assert.deepEqual(validateItems(win({ sites })), { ok: false, reason: 'too-many' });
});

test('validateForPush: frozen and allow windows without apps are not pushable', () => {
  assert.deepEqual(validateForPush(win({ lock: 'locked', unlock_delay_ms: 86400000 })), { ok: true });
  assert.deepEqual(validateForPush(win({ lock: 'frozen' })), { ok: false, reason: 'frozen-unavailable' });
  assert.deepEqual(validateForPush(win({ mode: 'allow', sites: ['a.com'] })), { ok: false, reason: 'allow-needs-apps' });
  assert.deepEqual(validateForPush(win({ mode: 'allow', apps: ['code.exe'] })), { ok: true });
  assert.deepEqual(validateForPush(win({ ends: 1 })), { ok: false, reason: 'bad-times' });
});

test('normalizeDomain never lets a backslash or control character through', () => {
  assert.equal(normalizeDomain('a\\b.com'), null);
  assert.equal(normalizeDomain('evil.com\\x'), null);
  assert.equal(normalizeDomain('a\u0007b.com'), null);
  assert.equal(normalizeDomain('https://www.Example.com/path'), 'example.com');
});

test('CRITICAL_APPS is identical in JS and Rust', () => {
  const rs = readFileSync(new URL('../focus-helper/src/decide.rs', import.meta.url), 'utf8');
  const block = rs.slice(rs.indexOf('pub const CRITICAL_APPS'), rs.indexOf('];', rs.indexOf('pub const CRITICAL_APPS')));
  const rust = [...block.replace(/\/\/.*$/gm, '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rust, CRITICAL_APPS);
  assert.equal(CRITICAL_APPS.length, 51);
  for (const n of ['logonui.exe', 'consent.exe', 'memory compression', 'secure system', 'shellhost.exe']) {
    assert.ok(CRITICAL_APPS.includes(n), n);
  }
});
