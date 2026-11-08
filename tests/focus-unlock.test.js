import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_TOKEN_TTL_MS, CHALLENGE_TTL_MS,
  generatePartnerKeys, createChallenge, signUnlock, verifyUnlock,
} from '../src/modules/focus/unlock.js';
import { buildPartnerPage } from '../scripts/build-partner-page.js';
import { staticVectors } from '../scripts/gen-unlock-vectors.js';

const NOW = 1_700_000_000_000;
const setup = async (windowId = 'w1') => {
  const keys = await generatePartnerKeys();
  const challenge = createChallenge(windowId, NOW);
  return { keys, challenge };
};

test('constants', () => {
  assert.equal(DEFAULT_TOKEN_TTL_MS, 600000);
  assert.equal(CHALLENGE_TTL_MS, 3600000);
});

test('public key is 65-byte raw SEC1 base64url without padding', async () => {
  const { publicKey, privateKeyJwk } = await generatePartnerKeys();
  assert.match(publicKey, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
  assert.equal(Buffer.from(publicKey, 'base64url')[0], 4);
  assert.equal(privateKeyJwk.kty, 'EC');
});

test('createChallenge shape and uniqueness', () => {
  const a = createChallenge('w1', NOW);
  const b = createChallenge('w1', NOW);
  assert.notEqual(a.nonce, b.nonce);
  assert.equal(Buffer.from(a.nonce, 'base64url').length, 16);
  assert.deepEqual(JSON.parse(Buffer.from(a.code, 'base64url').toString('utf8')), { n: a.nonce, w: 'w1' });
  assert.equal(a.windowId, 'w1');
  assert.equal(a.issued, NOW);
  assert.equal(a.used, false);
});

test('round trip is ok and token has the documented layout', async () => {
  const { keys, challenge } = await setup();
  const token = await signUnlock(keys.privateKeyJwk, challenge.code, NOW);
  const [p, s] = token.split('.');
  assert.equal(Buffer.from(s, 'base64url').length, 64);
  assert.equal(Buffer.from(p, 'base64url').toString('utf8'),
    `{"n":"${challenge.nonce}","w":"w1","exp":${NOW + DEFAULT_TOKEN_TTL_MS}}`);
  assert.deepEqual(await verifyUnlock(keys.publicKey, token, challenge, NOW + 1000), { ok: true });
});

test('token signed by another key is bad-signature', async () => {
  const { keys, challenge } = await setup();
  const other = await generatePartnerKeys();
  const token = await signUnlock(other.privateKeyJwk, challenge.code, NOW);
  assert.deepEqual(await verifyUnlock(keys.publicKey, token, challenge, NOW), { ok: false, reason: 'bad-signature' });
});

test('payload edited after signing is bad-signature', async () => {
  const { keys, challenge } = await setup();
  const token = await signUnlock(keys.privateKeyJwk, challenge.code, NOW);
  const [p, s] = token.split('.');
  const edited = Buffer.from(Buffer.from(p, 'base64url').toString('utf8').replace(/"exp":\d+/, '"exp":9999999999999')).toString('base64url');
  assert.deepEqual(await verifyUnlock(keys.publicKey, `${edited}.${s}`, challenge, NOW), { ok: false, reason: 'bad-signature' });
});

test('garbage is bad-format', async () => {
  const { keys, challenge } = await setup();
  for (const t of ['garbage', '', 'a.b.c', '!!.@@', 5]) {
    assert.deepEqual(await verifyUnlock(keys.publicKey, t, challenge, NOW), { ok: false, reason: 'bad-format' }, String(t));
  }
});

test('token for another challenge is wrong-challenge', async () => {
  const { keys, challenge } = await setup();
  const other = createChallenge('w1', NOW);
  const token = await signUnlock(keys.privateKeyJwk, other.code, NOW);
  assert.deepEqual(await verifyUnlock(keys.publicKey, token, challenge, NOW), { ok: false, reason: 'wrong-challenge' });
});

test('another window id is wrong-lock', async () => {
  const { keys, challenge } = await setup();
  const code = Buffer.from(JSON.stringify({ n: challenge.nonce, w: 'w2' })).toString('base64url');
  const token = await signUnlock(keys.privateKeyJwk, code, NOW);
  assert.deepEqual(await verifyUnlock(keys.publicKey, token, challenge, NOW), { ok: false, reason: 'wrong-lock' });
});

test('used challenge is used', async () => {
  const { keys, challenge } = await setup();
  const token = await signUnlock(keys.privateKeyJwk, challenge.code, NOW);
  assert.deepEqual(await verifyUnlock(keys.publicKey, token, { ...challenge, used: true }, NOW), { ok: false, reason: 'used' });
});

test('challenge older than an hour is challenge-expired', async () => {
  const { keys, challenge } = await setup();
  const token = await signUnlock(keys.privateKeyJwk, challenge.code, NOW, 10 * CHALLENGE_TTL_MS);
  const at = NOW + CHALLENGE_TTL_MS;
  assert.deepEqual(await verifyUnlock(keys.publicKey, token, challenge, at), { ok: true });
  assert.deepEqual(await verifyUnlock(keys.publicKey, token, challenge, at + 1), { ok: false, reason: 'challenge-expired' });
});

test('token past exp is expired', async () => {
  const { keys, challenge } = await setup();
  const token = await signUnlock(keys.privateKeyJwk, challenge.code, NOW, 1000);
  assert.deepEqual(await verifyUnlock(keys.publicKey, token, challenge, NOW + 999), { ok: true });
  assert.deepEqual(await verifyUnlock(keys.publicKey, token, challenge, NOW + 1000), { ok: false, reason: 'expired' });
});

test('committed partner page equals build output and is offline-only', () => {
  const file = readFileSync(new URL('../src/modules/focus/partner-unlock.html', import.meta.url), 'utf8');
  assert.equal(file, buildPartnerPage());
  assert.ok(!file.includes('http://'));
  assert.ok(!file.includes('https://'));
  assert.ok(!file.includes('fetch('));
});

test('vectors fixture matches generator inputs and tokens verify', async () => {
  const file = JSON.parse(readFileSync(new URL('./fixtures/unlock-vectors.json', import.meta.url), 'utf8'));
  const stat = staticVectors();
  assert.deepEqual(file.map(({ token, ...rest }) => rest), stat);
  const reasons = new Set();
  for (const v of file) {
    const got = await verifyUnlock(v.publicKey, v.token, v.challenge, v.now);
    assert.deepEqual(got, v.expect, v.name);
    if (!v.expect.ok) reasons.add(v.expect.reason);
  }
  assert.equal(file.filter((v) => v.expect.ok).length, 1);
  assert.deepEqual([...reasons].sort(), ['bad-format', 'bad-signature', 'challenge-expired', 'expired', 'used', 'wrong-challenge', 'wrong-lock']);
});
