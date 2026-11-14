// Pure logic for time limits. Mirrors focus-helper/src/limits.rs (validate_limit, is_weaker).
import { validItem, validateUnlockDelay } from './limits.js';
import { formatDuration } from './stats.js';

export const MAX_LIMITS = 64;
export const MAX_LIMIT_ITEMS = 100;
export const MIN_CAP_SECS = 60;
export const MAX_DAILY_CAP_SECS = 24 * 3600;
export const MAX_WEEKLY_CAP_SECS = 168 * 3600;
export const MAX_NAME_CHARS = 64;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * @typedef {{ id?: number, name: string, period: 'daily'|'weekly', capSecs: number, lock: 'none'|'locked',
 *   unlockDelayMs: number|null, enabled?: boolean, apps: string[], sites: string[] }} LimitRec
 */

/** @param {LimitRec} l */
export function validateLimit(l) {
  const errors = {};
  const name = typeof l.name === 'string' ? l.name : '';
  if (name.trim() === '' || [...name].length > MAX_NAME_CHARS || CONTROL_RE.test(name)) {
    errors.name = 'Give the limit a name up to 64 characters.';
  }
  const apps = Array.isArray(l.apps) ? l.apps : null;
  const sites = Array.isArray(l.sites) ? l.sites : null;
  if (!apps || !sites) errors.items = 'Add at least one app or site.';
  else {
    const n = apps.length + sites.length;
    if (n === 0) errors.items = 'Add at least one app or site.';
    else if (n > MAX_LIMIT_ITEMS) errors.items = 'A limit can hold up to 100 apps and sites.';
    else if (!apps.every(a => validItem('app', a)) || !sites.every(s => validItem('site', s))) {
      errors.items = 'One of the apps or sites is not valid.';
    }
  }
  const max = l.period === 'weekly' ? MAX_WEEKLY_CAP_SECS : l.period === 'daily' ? MAX_DAILY_CAP_SECS : -1;
  if (!Number.isInteger(l.capSecs) || l.capSecs < MIN_CAP_SECS || l.capSecs > max) {
    errors.cap = l.period === 'weekly'
      ? 'Choose between 1 minute and 168 hours.'
      : 'Choose between 1 minute and 24 hours.';
  }
  if (l.lock !== 'none' && l.lock !== 'locked') errors.delay = 'Unknown lock.';
  else if (!validateUnlockDelay(l.lock, l.unlockDelayMs ?? null).ok) {
    errors.delay = l.lock === 'locked' ? 'Choose a wait between 1 hour and 7 days.' : 'Only a locked limit has a wait.';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Helper wire shape; id is `limit-<id>`. */
export function toWire(l) {
  const w = {
    id: `limit-${l.id}`,
    name: l.name,
    apps: [...l.apps],
    sites: [...l.sites],
    period: l.period,
    cap_secs: l.capSecs,
    lock: l.lock,
  };
  if (l.lock === 'locked' && l.unlockDelayMs != null) w.unlock_delay_ms = l.unlockDelayMs;
  return w;
}

const set = (v) => new Set((v ?? []).map(s => s.trim().toLowerCase()));
const subset = (a, b) => [...a].every(x => b.has(x));

/** Mirrors `is_weaker` in focus-helper/src/limits.rs. */
export function isWeakening(oldL, newL) {
  const shorterWait = oldL.lock === 'locked' && newL.lock === 'locked'
    && oldL.unlockDelayMs != null && newL.unlockDelayMs != null && newL.unlockDelayMs < oldL.unlockDelayMs;
  return newL.capSecs > oldL.capSecs
    || shorterWait
    || newL.period !== oldL.period
    || (oldL.lock === 'locked' && newL.lock !== 'locked')
    || !subset(set(oldL.apps), set(newL.apps))
    || !subset(set(oldL.sites), set(newL.sites));
}

export function formatLeft(usedSecs, capSecs) {
  if (usedSecs >= capSecs) return 'Used up';
  return `${formatDuration(capSecs - usedSecs)} left`;
}

/**
 * @param {LimitRec} limit
 * @param {{ used_secs: number, cap_secs: number, blocked: boolean, period_ends_day?: string }|undefined} status
 * @param {string} helperKind HelperState.kind
 * @param {boolean} [trackingOff] the helper is up but no sampler is reporting (usage_tracking === false)
 * @returns {{ text: string, tone: 'ok'|'warn'|'blocked'|'muted' }}
 */
export function statusText(limit, status, helperKind, trackingOff = false) {
  if (helperKind !== 'ok') return { text: 'Enforcement is not running', tone: 'warn' };
  if (limit.enabled === false) return { text: 'Paused', tone: 'muted' };
  if (!status) return { text: 'Waiting for the helper', tone: 'muted' };
  if (status.blocked || status.used_secs >= status.cap_secs) {
    return { text: status.period_ends_day ? `Used up, back on ${status.period_ends_day}` : 'Used up', tone: 'blocked' };
  }
  // Nothing is being counted, so a remaining time would be shown as fact when it is not.
  if (trackingOff) return { text: 'Not counting right now', tone: 'warn' };
  return { text: formatLeft(status.used_secs, status.cap_secs), tone: 'ok' };
}

export function capParts(secs) {
  const s = Number.isFinite(secs) && secs > 0 ? Math.floor(secs) : 0;
  return { hours: Math.floor(s / 3600), minutes: Math.floor((s % 3600) / 60) };
}

export function partsToCap({ hours, minutes }) {
  return (Number(hours) || 0) * 3600 + (Number(minutes) || 0) * 60;
}
