// Pure logic for the Start dialog (no DOM).
import { parseDuration } from '../model.js';
import { formatClock } from './util.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "14 sites, 3 apps"; zero parts are omitted. */
export function listSummary(list) {
  const s = Array.isArray(list?.sites) ? list.sites.length : 0;
  const a = Array.isArray(list?.apps) ? list.apps.length : 0;
  const parts = [];
  if (s > 0) parts.push(plural(s, 'site'));
  if (a > 0) parts.push(plural(a, 'app'));
  return parts.length ? parts.join(', ') : 'Empty list';
}

/** A non-empty custom value wins over the preset; validation is the model's. */
export function resolveMinutes({ preset, custom } = {}) {
  return parseDuration({ preset, custom });
}

export function canStart({ selectedIds, duration } = {}) {
  return Array.isArray(selectedIds) && selectedIds.length > 0 && !!duration && duration.ok === true;
}

export function endsAtText(nowMs, minutes) {
  if (!Number.isFinite(nowMs) || !Number.isInteger(minutes) || minutes < 1) return '';
  return `Ends at ${formatClock(nowMs + minutes * 60000)}`;
}
