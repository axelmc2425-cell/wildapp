import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FIXED_JWK, FIXED_PUBLIC_KEY } from '../scripts/gen-unlock-vectors.js';
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

const b64 = (x) => Buffer.from(x).toString('base64url');
const signRaw = async (payloadBytes, jwk = FIXED_JWK) => {
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, payloadBytes));
  return { payload: payloadBytes, sig };
};
const CH = { nonce: 'nonce1', windowId: 'w1', issued: NOW, used: false };
const verify = (token, ch = CH, pub = FIXED_PUBLIC_KEY, now = NOW) => verifyUnlock(pub, token, ch, now);
const tokenFor = async (obj) => {
  const { payload, sig } = await signRaw(new TextEncoder().encode(typeof obj === 'string' ? obj : JSON.stringify(obj)));
  return `${b64(payload)}.${b64(sig)}`;
};
const good = { n: 'nonce1', w: 'w1', exp: NOW + 1000 };

test('signature of wrong length is bad-format', async () => {
  const { payload, sig } = await signRaw(new TextEncoder().encode(JSON.stringify(good)));
  assert.deepEqual(await verify(`${b64(payload)}.${b64(sig.slice(0, 63))}`), { ok: false, reason: 'bad-format' });
  assert.deepEqual(await verify(`${b64(payload)}.${b64(new Uint8Array([...sig, 0]))}`), { ok: false, reason: 'bad-format' });
  assert.deepEqual(await verify(`${b64(payload)}.`), { ok: false, reason: 'bad-format' });
});

test('non-canonical base64url in signature or payload does not verify (bad-format)', async () => {
  const token = await tokenFor(good);
  const [p, s] = token.split('.');
  assert.deepEqual(await verify(token), { ok: true });
  // 64-byte signature encodes to 86 chars; last char carries 2 unused bits. Flip them.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bump = (str) => str.slice(0, -1) + alphabet[(alphabet.indexOf(str.at(-1)) + 1) % 64];
  const sig2 = bump(s);
  assert.deepEqual(Buffer.from(sig2, 'base64url'), Buffer.from(s, 'base64url'));
  assert.deepEqual(await verify(`${p}.${sig2}`), { ok: false, reason: 'bad-format' });
  // payload: pad it so it has trailing unused bits, then bump the last char
  const pl = await tokenFor('{"n":"nonce1","w":"w1","exp":' + (NOW + 1000) + '} ');
  const [p3, s3] = pl.split('.');
  assert.deepEqual(await verify(`${p3}.${s3}`), { ok: true });
  const p4 = bump(p3);
  if (Buffer.from(p4, 'base64url').equals(Buffer.from(p3, 'base64url'))) {
    assert.deepEqual(await verify(`${p4}.${s3}`), { ok: false, reason: 'bad-format' });
  }
  // padded form is not canonical either
  assert.deepEqual(await verify(`${p}.${s}==`), { ok: false, reason: 'bad-format' });
});

test('validly signed payloads with missing or mistyped fields are bad-format', async () => {
  for (const bad of [
    { w: 'w1', exp: NOW + 1000 }, { n: 'nonce1', exp: NOW + 1000 }, { n: 'nonce1', w: 'w1' },
    { n: 'nonce1', w: 'w1', exp: String(NOW + 1000) }, { n: 1, w: 'w1', exp: NOW + 1000 }, null, [], 'x',
  ]) {
    assert.deepEqual(await verify(await tokenFor(bad)), { ok: false, reason: 'bad-format' }, JSON.stringify(bad));
  }
  assert.deepEqual(await verify(await tokenFor('not json')), { ok: false, reason: 'bad-format' });
});

test('wrong-length or invalid public key is bad-signature', async () => {
  const token = await tokenFor(good);
  const raw = Buffer.from(FIXED_PUBLIC_KEY, 'base64url');
  for (const pk of [b64(raw.subarray(0, 64)), b64(new Uint8Array([...raw, 0])), '', 'not a key!', b64(new Uint8Array(65)), FIXED_PUBLIC_KEY + '=', null]) {
    assert.deepEqual(await verify(token, CH, pk), { ok: false, reason: 'bad-signature' }, String(pk));
  }
});

test('check order: wrong-challenge beats used and wrong-lock; used beats challenge-expired', async () => {
  const t = await tokenFor({ n: 'other', w: 'w2', exp: NOW + 1000 });
  assert.deepEqual(await verify(t, { ...CH, used: true }), { ok: false, reason: 'wrong-challenge' });
  const t2 = await tokenFor({ n: 'nonce1', w: 'w2', exp: NOW + 1000 });
  assert.deepEqual(await verify(t2, { ...CH, used: true }), { ok: false, reason: 'wrong-lock' });
  const t3 = await tokenFor(good);
  assert.deepEqual(await verify(t3, { ...CH, used: true, issued: NOW - 2 * CHALLENGE_TTL_MS }), { ok: false, reason: 'used' });
  const t4 = await tokenFor({ ...good, exp: NOW - 1 });
  assert.deepEqual(await verify(t4, { ...CH, issued: NOW - 2 * CHALLENGE_TTL_MS }), { ok: false, reason: 'challenge-expired' });
  assert.deepEqual(await verify(await tokenFor('garbage'), { ...CH, used: true }), { ok: false, reason: 'bad-format' });
});

test('the committed page script runs on its own and produces tokens verifyUnlock accepts', async () => {
  const html = readFileSync(new URL('../src/modules/focus/partner-unlock.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const el = () => ({ addEventListener() {}, set textContent(_) {}, hidden: true, value: '' });
  const ctx = vm.createContext({
    crypto: globalThis.crypto, TextEncoder, TextDecoder, atob, btoa, console,
    document: { getElementById: el, createElement: el }, URL, Blob,
  });
  vm.runInContext(script, ctx);
  const keys = await vm.runInContext('generatePartnerKeys()', ctx);
  const challenge = createChallenge('w1', NOW);
  ctx.jwk = keys.privateKeyJwk; ctx.code = challenge.code;
  const token = await vm.runInContext(`signUnlock(jwk, code, ${NOW})`, ctx);
  assert.deepEqual(await verifyUnlock(keys.publicKey, token, challenge, NOW + 1), { ok: true });
});
