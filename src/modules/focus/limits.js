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
