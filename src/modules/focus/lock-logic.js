// Pure rules for locked blocks: delay input, warning text, error wording, window ids. No DOM, no clock, no imports.

export const UNLOCK_DELAY_PRESETS_H = [1, 6, 24];

const MAX_LOCKED_MINUTES = 10080;

/** @param {{preset?: number, custom?: string}} input */
export function resolveDelayHours(input) {
  const bad = { ok: false, message: 'Enter a whole number of hours from 1 to 168.' };
  const i = input || {};
  if (i.custom !== undefined && i.custom !== null && String(i.custom).trim() !== '') {
    const t = String(i.custom).trim();
    if (!/^\d+$/.test(t)) return bad;
    const n = Number(t);
    if (n < 1 || n > 168) return bad;
    return { ok: true, hours: n };
  }
  if (typeof i.preset === 'number' && Number.isInteger(i.preset) && i.preset >= 1 && i.preset <= 168) {
    return { ok: true, hours: i.preset };
  }
  return bad;
}

/** @param {number} delayHours */
export function lockedWarning(delayHours) {
  return `You can't cancel this. Only your partner's code, or the waiting period (${delayHours} ${delayHours === 1 ? 'hour' : 'hours'}), ends it early.`;
}

const TOKEN_STAYS = 'The lock stays on.';
const MESSAGES = {
  'bad-format': `That code isn't in the right format. Check you copied all of it. ${TOKEN_STAYS}`,
  'bad-signature': `That code wasn't signed by your partner's key. Ask your partner to try again, or check the partner key in settings. ${TOKEN_STAYS}`,
  'wrong-challenge': `That code was made for a different request. Get a new code here and send it to your partner. ${TOKEN_STAYS}`,
  'wrong-lock': `That code is for a different locked block. Ask your partner for one for this block. ${TOKEN_STAYS}`,
  used: `That code has already been used. Get a new code and ask your partner again. ${TOKEN_STAYS}`,
  'challenge-expired': `The request for a code ran out of time. Get a new code and ask your partner again. ${TOKEN_STAYS}`,
  expired: `That code has expired. Ask your partner for a fresh one. ${TOKEN_STAYS}`,
  'no-partner': 'No partner key is set yet. Add your partner\'s key in the partner setup, then try again.',
  'no-such-lock': 'That locked block is no longer there, so there is nothing to unlock. Refresh the list.',
  'lock-active': "A lock is still active, so this can't be done right now. Wait until the locked block ends, or unlock it first.",
  'bad-key': "That partner key isn't valid. Check you copied the whole key and try again.",
  'not-delayable': "This block can't use a waiting period. Use your partner's code to end it early.",
  'no-pending-unlock': 'There is no waiting period running for this block, so there is nothing to cancel.',
  'bad-window': "The helper didn't recognise that block. Refresh the list and try again.",
  'bad-folder': "One of the folders in this list isn't a valid folder path. Open the list, remove it and pick the folder again with Browse folder.",
  'forbidden-folder': "One of the folders in this list is part of Windows or this app and can't be blocked. Open the list and remove it.",
  unreachable: "Couldn't reach the helper. Check it is running and try again. The lock stays on.",
  'persist-failed': "The helper couldn't save that change to disk, so it may be lost on restart. Try again.",
};

/** @param {unknown} err @returns {string} */
export function describeUnlockError(err) {
  try {
    const code = err && typeof err === 'object' ? err.code : undefined;
    if (code === 'bad-window' && typeof err.message === 'string') {
      // The helper reports the folder reason inside a bad-window message; match forbidden first.
      if (err.message.includes('forbidden-folder')) return MESSAGES['forbidden-folder'];
      if (err.message.includes('bad-folder')) return MESSAGES['bad-folder'];
    }
    if (typeof code === 'string' && Object.hasOwn(MESSAGES, code)) return MESSAGES[code];
    const message = typeof err === 'string' ? err : err && typeof err === 'object' ? err.message : undefined;
    if (typeof message === 'string' && message.trim()) return message;
  } catch { /* fall through */ }
  return 'Something went wrong talking to the helper. The lock stays on.';
}

/** Mirrors the id `lockedBlockToWindow` builds. @param {{starts: number, ends: number, listIds: number[]}} block */
export function windowIdForBlock(block) {
  if (typeof block.windowId === 'string' && block.windowId) return block.windowId;
  const listIds = [...new Set(block.listIds)].sort((a, b) => a - b);
  return 'b' + block.starts + '-' + listIds.join('.');
}

/** @returns {number|null} unlock_at for the window, or null */
export function pendingUnlockFor(status, windowId) {
  const list = status && Array.isArray(status.pending_unlocks) ? status.pending_unlocks : [];
  for (const p of list) {
    if (p && typeof p === 'object' && p.window_id === windowId && typeof p.unlock_at === 'number' && Number.isFinite(p.unlock_at)) {
      return p.unlock_at;
    }
  }
  return null;
}

/** @param {{selectedIds?: unknown[], duration?: {ok?: boolean, minutes?: number}, delay?: {ok?: boolean}, confirmed?: boolean}} a */
export function canStartLocked(a) {
  const { selectedIds, duration, delay, confirmed } = a || {};
  return Array.isArray(selectedIds) && selectedIds.length > 0
    && !!duration && duration.ok === true && Number.isFinite(duration.minutes) && duration.minutes >= 1 && duration.minutes <= MAX_LOCKED_MINUTES
    && !!delay && delay.ok === true
    && confirmed === true;
}

/** Duration chips for a locked block, as [minutes, label]. */
export const LOCKED_DURATION_PRESETS = [[25, '25 min'], [60, '1 h'], [120, '2 h'], [240, '4 h'], [1440, '1 day'], [10080, '7 days']];

/** Like the normal duration input but capped at 10080 minutes. @param {{preset?: number, custom?: string}} input */
export function resolveLockedMinutes(input) {
  const bad = { ok: false, message: 'Enter a whole number of minutes from 1 to 10080 (7 days).' };
  const i = input || {};
  if (i.custom !== undefined && i.custom !== null && String(i.custom).trim() !== '') {
    const t = String(i.custom).trim();
    if (!/^\d+$/.test(t)) return bad;
    const n = Number(t);
    if (n < 1 || n > MAX_LOCKED_MINUTES) return bad;
    return { ok: true, minutes: n };
  }
  if (typeof i.preset === 'number' && Number.isInteger(i.preset) && i.preset >= 1 && i.preset <= MAX_LOCKED_MINUTES) {
    return { ok: true, minutes: i.preset };
  }
  return bad;
}

/** "Locked for 2 days 3 h 5 min" style text. */
export function lockedSpanText(minutes) {
  if (!Number.isInteger(minutes) || minutes < 1) return '';
  const d = Math.floor(minutes / 1440), hr = Math.floor((minutes % 1440) / 60), m = minutes % 60;
  const parts = [];
  if (d) parts.push(`${d} ${d === 1 ? 'day' : 'days'}`);
  if (hr) parts.push(`${hr} h`);
  if (m) parts.push(`${m} min`);
  return `Locked for ${parts.join(' ')}`;
}

/** "24 hours" / "1 hour" from a waiting period in ms; falls back to minutes, or a neutral phrase when unknown. */
export function waitLengthText(delayMs) {
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs <= 0) return 'the waiting period you chose';
  const hours = delayMs / 3600000;
  if (Number.isInteger(hours)) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const mins = Math.max(1, Math.round(delayMs / 60000));
  return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
}

/** The running locked block (if any) that holds this list. @param {{lock?: string, state?: string, listIds: number[]}[]} blocks */
export function lockedBlockHolding(blocks, listId) {
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b && b.lock === 'locked' && b.state === 'running' && Array.isArray(b.listIds) && b.listIds.includes(listId)) return b;
  }
  return null;
}
