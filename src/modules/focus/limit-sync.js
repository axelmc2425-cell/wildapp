// Push the app's time limits to the helper. Disabled unlocked limits are left out; a locked limit is
// never left out, because the helper would report the omission as a rejected delete.
import { listLimits } from './store.js';
import { toWire } from './limit-logic.js';

/** The limits that go on the wire: every enabled one, plus every locked one. */
export function limitsForPush(limits) {
  return limits.filter((l) => l.enabled || l.lock === 'locked');
}

/**
 * @param {{ force?: boolean }} opts force: push even an empty set (the helper may still hold limits).
 * @returns {Promise<null | { pushed: number, applied: number, keptLocked: string[], skippedTombstoned: string[] }>}
 *   null when there was nothing to do (no limits and none ever pushed).
 */
export async function syncLimits(db, client, { force = false } = {}) {
  const all = await listLimits(db);
  const wire = limitsForPush(all).map(toWire);
  if (all.length === 0 && !force) return null;
  const res = await client.pushLimits(wire);
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return {
    pushed: wire.length,
    applied: Number.isFinite(res && res.applied) ? res.applied : wire.length,
    keptLocked: list(res && res.kept_locked),
    skippedTombstoned: list(res && res.skipped_tombstoned),
  };
}

/** Helper wire limit -> app record fields (no id, no enabled). */
export function fromWire(h) {
  return {
    name: h.name,
    period: h.period,
    capSecs: h.cap_secs,
    lock: h.lock === 'locked' ? 'locked' : 'none',
    unlockDelayMs: h.lock === 'locked' && h.unlock_delay_ms != null ? h.unlock_delay_ms : null,
    apps: Array.isArray(h.apps) ? [...h.apps] : [],
    sites: Array.isArray(h.sites) ? [...h.sites] : [],
  };
}

const norm = (v) => [...new Set((v ?? []).map((s) => s.trim().toLowerCase()))].sort().join('\n');

/** True when the helper's copy differs from the app row in anything that matters. */
export function limitDiffers(row, h) {
  const w = fromWire(h);
  return row.name !== w.name || row.period !== w.period || row.capSecs !== w.capSecs
    || row.lock !== w.lock || (row.unlockDelayMs ?? null) !== w.unlockDelayMs
    || norm(row.apps) !== norm(w.apps) || norm(row.sites) !== norm(w.sites);
}
