// Pure rules for uninstall protection: wait bounds, countdown text, status line. No DOM, no clock, no imports.

const HOUR = 3600000;
export const MIN_WAIT_MS = HOUR;
export const MAX_WAIT_MS = 7 * 24 * HOUR;
export const DEFAULT_WAIT_MS = 24 * HOUR;

const NOT_RUNNING = 'Enforcement is not running';

/** @param {number} ms @returns {{ok: true} | {ok: false, reason: string}} */
export function validateWait(ms) {
  if (typeof ms !== 'number' || !Number.isInteger(ms)) return { ok: false, reason: 'Enter a whole waiting period from 1 hour to 7 days.' };
  if (ms < MIN_WAIT_MS) return { ok: false, reason: 'The waiting period must be at least 1 hour.' };
  if (ms > MAX_WAIT_MS) return { ok: false, reason: 'The waiting period can be at most 7 days.' };
  return { ok: true };
}

/** Shortening the wait is the weakening direction (it needs a permit). */
export function isWaitWeakening(oldMs, newMs) {
  return newMs < oldMs;
}

/** '23h 59m', '4m 05s', '0s'. */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Whole days and leftover hours of a wait, for a days/hours input. */
export function waitParts(ms) {
  const hours = Math.floor(ms / HOUR);
  return { days: Math.floor(hours / 24), hours: hours % 24 };
}

export function partsToWait({ days, hours }) {
  return ((Number(days) || 0) * 24 + (Number(hours) || 0)) * HOUR;
}

function waitText(ms) {
  const h = ms / HOUR;
  if (Number.isInteger(h) && h % 24 === 0 && h >= 48) return `${h / 24} days`;
  if (Number.isInteger(h)) return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  const m = Math.round(ms / 60000);
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
}

function clock(t, tzOffsetMin) {
  const off = typeof tzOffsetMin === 'number' ? tzOffsetMin : -new Date(t).getTimezoneOffset();
  const d = new Date(t + off * 60000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * @param {{waitMs?: number, pendingAt?: number|null, permitUntil?: number|null, partnerReadyAt?: number|null, known?: boolean}} state
 * @param {number} nowMs @param {string} helperKind @param {boolean} partnerSet
 * @param {number} [tzOffsetMin] minutes east of UTC for the clock time; defaults to the device zone
 * @returns {{headline: string, detail: string, tone: 'ok'|'warn'|'open'|'down'}}
 */
export function uninstallStatusText(state, nowMs, helperKind, partnerSet, tzOffsetMin) {
  if (helperKind !== 'ok' || !state || state.known !== true) {
    return { headline: NOT_RUNNING, detail: "Protection status isn't available right now.", tone: 'down' };
  }
  if (typeof state.permitUntil === 'number' && state.permitUntil > nowMs) {
    return { headline: `You can uninstall until ${clock(state.permitUntil, tzOffsetMin)}`, detail: `Uninstalling is allowed until ${clock(state.permitUntil, tzOffsetMin)}. After that the protection is back on.`, tone: 'open' };
  }
  if (typeof state.pendingAt === 'number') {
    if (state.pendingAt > nowMs) {
      return { headline: 'Waiting period running', detail: `You can uninstall in ${formatCountdown(state.pendingAt - nowMs)}. Cancel it any time to stay protected.`, tone: 'warn' };
    }
    return { headline: 'The waiting period finished', detail: "The helper is applying it. If you can't uninstall in a minute, request the waiting period again.", tone: 'warn' };
  }
  const wait = typeof state.waitMs === 'number' ? waitText(state.waitMs) : 'the waiting period';
  let detail = partnerSet
    ? `Uninstalling needs your partner's code, or a waiting period of ${wait}.`
    : `Uninstalling needs a waiting period of ${wait}. Add a partner so someone else can approve it sooner.`;
  if (typeof state.partnerReadyAt === 'number' && state.partnerReadyAt > nowMs) {
    detail += ` Your partner can approve uninstalling from ${clock(state.partnerReadyAt, tzOffsetMin)}.`;
  }
  return { headline: 'Uninstall is protected', detail, tone: 'ok' };
}
