// Generates tests/fixtures/unlock-vectors.json (shared with the Rust helper).
// ECDSA signatures are randomized, so the tokens are signed once and committed;
// the test re-verifies them and checks the static inputs below against the file.
// Re-running this script replaces the tokens with fresh (equally valid) ones.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHALLENGE_TTL_MS, DEFAULT_TOKEN_TTL_MS, generatePartnerKeys, signUnlock } from '../src/modules/focus/unlock.js';

// Fixed P-256 key pair (test-only; never use for anything real).
export const FIXED_JWK = {
  kty: 'EC', crv: 'P-256', ext: true, key_ops: ['sign'],
  x: 'uvHiajpKCio-kaUadY4eW95YrDNh2cL3VJqJ0AUOh94', y: 't9lUXhplvCcQ18vD-68E7dvVoKfpjBaaYW-QLy0da5U', d: 'h5VD54FsL2PtAAztzujS5LJLNuLDwO2f1gcovg_lrWA',
};
export const FIXED_PUBLIC_KEY = 'BLrx4mo6SgoqPpGlGnWOHlveWKwzYdnC91SaidAFDofet9lUXhplvCcQ18vD-68E7dvVoKfpjBaaYW-QLy0da5U';

const NOW = 1_700_000_000_000;
const NONCE = 'AAECAwQFBgcICQoLDA0ODw';
const WINDOW = 'win-1';
const b64u = (s) => Buffer.from(s).toString('base64url');
const code = (n, w) => b64u(JSON.stringify({ n, w }));
const challenge = (o = {}) => ({ nonce: NONCE, windowId: WINDOW, issued: NOW - 1000, used: false, ...o });

// kind says how to build the token for each case.
const CASES = [
  { name: 'valid', kind: 'good', challenge: challenge(), expect: { ok: true } },
  { name: 'bad-format garbage', kind: 'garbage', challenge: challenge(), expect: { ok: false, reason: 'bad-format' } },
  { name: 'bad-signature other key', kind: 'other-key', challenge: challenge(), expect: { ok: false, reason: 'bad-signature' } },
  { name: 'bad-signature edited payload', kind: 'edited', challenge: challenge(), expect: { ok: false, reason: 'bad-signature' } },
  { name: 'wrong-challenge', kind: 'other-nonce', challenge: challenge(), expect: { ok: false, reason: 'wrong-challenge' } },
  { name: 'wrong-lock', kind: 'other-window', challenge: challenge(), expect: { ok: false, reason: 'wrong-lock' } },
  { name: 'used', kind: 'good', challenge: challenge({ used: true }), expect: { ok: false, reason: 'used' } },
  { name: 'challenge-expired', kind: 'good', challenge: challenge({ issued: NOW - CHALLENGE_TTL_MS - 1 }), expect: { ok: false, reason: 'challenge-expired' } },
  { name: 'expired', kind: 'late', challenge: challenge(), expect: { ok: false, reason: 'expired' } },
];

export function staticVectors() {
  return CASES.map((c) => ({
    name: c.name, publicKey: FIXED_PUBLIC_KEY, challenge: c.challenge,
    now: c.kind === 'late' ? NOW + DEFAULT_TOKEN_TTL_MS : NOW, expect: c.expect,
  }));
}

async function makeToken(kind) {
  const good = code(NONCE, WINDOW);
  switch (kind) {
    case 'garbage': return 'garbage';
    case 'other-key': return signUnlock((await generatePartnerKeys()).privateKeyJwk, good, NOW);
    case 'edited': {
      const [p, s] = (await signUnlock(FIXED_JWK, good, NOW)).split('.');
      const edited = Buffer.from(Buffer.from(p, 'base64url').toString().replace(/"exp":\d+/, '"exp":9999999999999'));
      return `${edited.toString('base64url')}.${s}`;
    }
    case 'other-nonce': return signUnlock(FIXED_JWK, code('BBECAwQFBgcICQoLDA0ODw', WINDOW), NOW);
    case 'other-window': return signUnlock(FIXED_JWK, code(NONCE, 'win-2'), NOW);
    default: return signUnlock(FIXED_JWK, good, NOW);
  }
}

export async function buildVectors() {
  const stat = staticVectors();
  const out = [];
  for (let i = 0; i < CASES.length; i++) {
    const { name, publicKey, challenge: ch, now, expect } = stat[i];
    out.push({ name, publicKey, token: await makeToken(CASES[i].kind), challenge: ch, now, expect });
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = fileURLToPath(new URL('../tests/fixtures/unlock-vectors.json', import.meta.url));
  writeFileSync(out, JSON.stringify(await buildVectors(), null, 2) + '\n');
  console.log('wrote', out);
}
