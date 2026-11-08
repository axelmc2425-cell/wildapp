// Partner unlock tokens: ECDSA P-256 / SHA-256 over the exact payload bytes.
// Wire formats (shared with the Rust helper):
//   publicKey  = base64url(raw uncompressed SEC1 point, 65 bytes), no padding
//   code       = base64url(UTF-8 JSON {"n":nonce,"w":windowId})
//   token      = base64url(payload JSON bytes) + "." + base64url(r||s, 64 bytes)
//   payload    = UTF-8 JSON {"n":nonce,"w":windowId,"exp":ms}
// Uses Web Crypto only, so it runs unchanged in Node and in a browser.

export const DEFAULT_TOKEN_TTL_MS = 600000;
export const CHALLENGE_TTL_MS = 3600000;

const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };

function b64uEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Returns a Uint8Array, or null when the text is not unpadded base64url.
function b64uDecode(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function generatePartnerKeys() {
  const pair = await globalThis.crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey));
  const privateKeyJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64uEncode(raw), privateKeyJwk };
}

export function createChallenge(windowId, nowMs) {
  const nonce = b64uEncode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const code = b64uEncode(new TextEncoder().encode(JSON.stringify({ n: nonce, w: windowId })));
  return { code, nonce, windowId, issued: nowMs, used: false };
}

export async function signUnlock(privateKeyJwk, challengeCode, nowMs, ttlMs = 600000) {
  const bytes = b64uDecode(challengeCode);
  if (!bytes) throw new Error('Invalid challenge code');
  let c;
  try { c = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('Invalid challenge code'); }
  if (!c || typeof c.n !== 'string' || typeof c.w !== 'string') throw new Error('Invalid challenge code');
  const payload = new TextEncoder().encode(JSON.stringify({ n: c.n, w: c.w, exp: nowMs + ttlMs }));
  const key = await globalThis.crypto.subtle.importKey('jwk', privateKeyJwk, ALG, false, ['sign']);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign(SIG, key, payload));
  return b64uEncode(payload) + '.' + b64uEncode(sig);
}

const fail = (reason) => ({ ok: false, reason });

export async function verifyUnlock(publicKey, token, challenge, nowMs) {
  if (typeof token !== 'string') return fail('bad-format');
  const parts = token.split('.');
  if (parts.length !== 2) return fail('bad-format');
  const payload = b64uDecode(parts[0]);
  const sig = b64uDecode(parts[1]);
  if (!payload || !sig || sig.length !== 64) return fail('bad-format');
  let p;
  try { p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); } catch { return fail('bad-format'); }
  if (!p || typeof p.n !== 'string' || typeof p.w !== 'string' || typeof p.exp !== 'number') return fail('bad-format');

  let valid = false;
  try {
    const raw = b64uDecode(publicKey);
    const key = await globalThis.crypto.subtle.importKey('raw', raw, ALG, false, ['verify']);
    valid = await globalThis.crypto.subtle.verify(SIG, key, sig, payload);
  } catch { valid = false; }
  if (!valid) return fail('bad-signature');

  if (p.n !== challenge.nonce) return fail('wrong-challenge');
  if (p.w !== challenge.windowId) return fail('wrong-lock');
  if (challenge.used) return fail('used');
  if (nowMs - challenge.issued > CHALLENGE_TTL_MS) return fail('challenge-expired');
  if (nowMs >= p.exp) return fail('expired');
  return { ok: true };
}

// Source of the functions the offline partner page inlines (see scripts/build-partner-page.js).
export const PARTNER_PAGE_SOURCE = [b64uEncode, b64uDecode, generatePartnerKeys, signUnlock]
  .map((f) => f.toString()).join('\n\n');
