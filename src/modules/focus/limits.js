// Focus window model, duration limits and extension rules (pure).
import { folderProblem } from './folders.js';

/**
 * @typedef {Object} Window
 * @property {string} id unique per window
 * @property {number} starts epoch ms
 * @property {number} ends epoch ms
 * @property {'none'|'locked'|'frozen'} lock
 * @property {'block'|'allow'} mode
 * @property {string[]} sites
 * @property {string[]} apps
 * @property {string[]} [app_folders] absolute Windows folders (block mode only)
 * @property {number|null} [unlock_delay_ms] required for `locked` (1 h to 7 days), null/absent otherwise
 */

export const MAX_DURATION_MS = { locked: 604800000, frozen: 86400000 };

export const MIN_UNLOCK_DELAY_MS = 3600000;
export const MAX_UNLOCK_DELAY_MS = 604800000;

const LOCKS = ['none', 'locked', 'frozen'];

function capFor(lock) {
  return Object.prototype.hasOwnProperty.call(MAX_DURATION_MS, lock) ? MAX_DURATION_MS[lock] : Infinity;
}

/** Locked windows need a delay in range; other locks must not carry one. */
export function validateUnlockDelay(lock, delayMs) {
  if (lock === 'locked') {
    const ok = Number.isInteger(delayMs)
      && delayMs >= MIN_UNLOCK_DELAY_MS && delayMs <= MAX_UNLOCK_DELAY_MS;
    return ok ? { ok: true } : { ok: false, reason: 'bad-delay' };
  }
  return delayMs == null ? { ok: true } : { ok: false, reason: 'bad-delay' };
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
  if (kind === 'folder') return folderProblem(value) === null;
  return false;
}

/** Item checks the helper applies to every pushed window. @param {Window} w */
export function validateItems(w) {
  if (!Array.isArray(w.sites) || !Array.isArray(w.apps)) return { ok: false, reason: 'bad-item' };
  if (w.app_folders != null && !Array.isArray(w.app_folders)) return { ok: false, reason: 'bad-item' };
  const folders = w.app_folders ?? [];
  if (w.sites.length + w.apps.length + folders.length > MAX_ITEMS_PER_WINDOW) return { ok: false, reason: 'too-many' };
  if (!w.sites.every((s) => validItem('site', s)) || !w.apps.every((a) => validItem('app', a))
    || !folders.every((f) => validItem('folder', f))) {
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
  const d = validateUnlockDelay(w.lock, w.unlock_delay_ms);
  if (!d.ok) return d;
  if (w.lock === 'frozen') return { ok: false, reason: 'frozen-unavailable' };
  if (w.mode === 'allow' && (!Array.isArray(w.apps) || w.apps.length === 0)) {
    return { ok: false, reason: 'allow-needs-apps' };
  }
  return validateItems(w);
}
