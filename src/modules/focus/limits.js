// Focus window model, duration limits and extension rules (pure).

/**
 * @typedef {Object} Window
 * @property {string} id unique per window
 * @property {number} starts epoch ms
 * @property {number} ends epoch ms
 * @property {'none'|'locked'|'frozen'} lock
 * @property {'block'|'allow'} mode
 * @property {string[]} sites
 * @property {string[]} apps
 */

export const MAX_DURATION_MS = { locked: 604800000, frozen: 86400000 };

const LOCKS = ['none', 'locked', 'frozen'];

function capFor(lock) {
  return Object.prototype.hasOwnProperty.call(MAX_DURATION_MS, lock) ? MAX_DURATION_MS[lock] : Infinity;
}

/** @param {Window} w */
export function validateWindow(w) {
  if (!Number.isFinite(w.starts) || !Number.isFinite(w.ends) || !(w.ends > w.starts)) {
    return { ok: false, reason: 'bad-times' };
  }
  if (!LOCKS.includes(w.lock)) return { ok: false, reason: 'bad-lock' };
  if (w.ends - w.starts > capFor(w.lock)) return { ok: false, reason: 'too-long' };
  return { ok: true };
}

/** @param {Window} w @param {number} newEnds @returns {Window} */
export function extendWindow(w, newEnds) {
  if (!(newEnds > w.ends)) throw new Error('cannot shorten');
  if (!Number.isFinite(newEnds) || newEnds - w.starts > capFor(w.lock)) {
    throw new Error('exceeds maximum duration');
  }
  return { ...w, ends: newEnds };
}

export const MAX_WINDOWS = 1024;
export const MAX_ITEMS_PER_WINDOW = 512;

// Control characters (C0, DEL, C1) and Unicode whitespace other than an ordinary space.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const WHITESPACE_RE = /[\s\ufeff]/;

/** Mirrors `good_item` in focus-helper/src/lockstore.rs (shared vectors: tests/fixtures/item-vectors.json). */
export function validItem(kind, value) {
  if (typeof value !== 'string') return false;
  if (kind === 'site') {
    return value !== '' && !CONTROL_RE.test(value) && !WHITESPACE_RE.test(value) && !/[#/\\]/.test(value);
  }
  if (kind === 'app') {
    return value.trim() !== '' && !CONTROL_RE.test(value) && !/[^\S ]/.test(value) && !/[/\\:]/.test(value);
  }
  return false;
}

/** Item checks the helper applies to every pushed window. @param {Window} w */
export function validateItems(w) {
  if (!Array.isArray(w.sites) || !Array.isArray(w.apps)) return { ok: false, reason: 'bad-item' };
  if (w.sites.length + w.apps.length > MAX_ITEMS_PER_WINDOW) return { ok: false, reason: 'too-many' };
  if (!w.sites.every((s) => validItem('site', s)) || !w.apps.every((a) => validItem('app', a))) {
    return { ok: false, reason: 'bad-item' };
  }
  return { ok: true };
}

/**
 * Everything the helper checks on push, so one bad window never makes it reject the whole push:
 * times and caps, frozen (unavailable until sub-project 4), allow windows without apps
 * (site allow-lists are not enforced, so they would kill every non-critical app), and items.
 * @param {Window} w
 */
export function validateForPush(w) {
  const v = validateWindow(w);
  if (!v.ok) return v;
  if (w.lock === 'frozen') return { ok: false, reason: 'frozen-unavailable' };
  if (w.mode === 'allow' && (!Array.isArray(w.apps) || w.apps.length === 0)) {
    return { ok: false, reason: 'allow-needs-apps' };
  }
  return validateItems(w);
}
