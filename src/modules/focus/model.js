// Focus Room UI rules: pure functions, no DOM, no clock reads, no imports.

/**
 * The helper's Status response, as the client returns it.
 * @typedef {{ blockSites: string[], blockApps: string[], allow: ({sites: string[], apps: string[]}|null), frozen: boolean, locks: {id: number, lock: string, ends: number}[] }} Decision
 * @typedef {{ type?: string, decision: Decision, windows: object[], partner_set: boolean, now_ms: number, warnings: string[] }} Status
 */

/**
 * @typedef {{ kind: 'ok', status: Status }
 *   | { kind: 'not-running' }
 *   | { kind: 'unavailable' }
 *   | { kind: 'timeout' }
 *   | { kind: 'persist-failed', message: string }
 *   | { kind: 'unknown', message: string }} HelperState
 */

/**
 * @typedef {{ key: string, ids: number[], listIds: number[], listNames: string[], starts: number, ends: number, state: 'running'|'upcoming'|'finished', progress: number }} Block
 */

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** @param {number} msLeft */
export function formatCountdown(msLeft) {
  if (typeof msLeft !== 'number' || !Number.isFinite(msLeft) || msLeft <= 0) return 'Ending…';
  if (msLeft < MIN) return `${Math.ceil(msLeft / SEC)} s left`;
  if (msLeft < HOUR) return `${Math.ceil(msLeft / MIN)} min left`;
  const totalMin = Math.ceil(msLeft / MIN);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} h left` : `${h} h ${m} min left`;
}

/**
 * @param {{id: number, listId: number, starts: number, ends: number, lock?: string}[]} sessions
 * @param {{id: number, name: string}[]} lists
 * @param {number} nowMs
 * @returns {Block[]}
 */
export function groupSessions(sessions, lists, nowMs) {
  const names = new Map();
  for (const l of Array.isArray(lists) ? lists : []) if (l) names.set(l.id, l.name);
  const groups = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s.starts !== 'number' || typeof s.ends !== 'number') continue;
    if (!Number.isFinite(s.starts) || !Number.isFinite(s.ends) || s.ends <= s.starts) continue;
    const gk = `${s.starts}:${s.ends}:${s.lock ?? 'none'}`;
    let g = groups.get(gk);
    if (!g) {
      g = { key: `${s.starts}:${s.ends}`, ids: [], listIds: [], listNames: [], starts: s.starts, ends: s.ends };
      groups.set(gk, g);
    }
    g.ids.push(s.id);
    g.listIds.push(s.listId);
    g.listNames.push(names.has(s.listId) ? names.get(s.listId) : '(deleted list)');
  }
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  const out = [];
  for (const g of groups.values()) {
    const state = now >= g.ends ? 'finished' : now >= g.starts ? 'running' : 'upcoming';
    const progress = Math.min(1, Math.max(0, (now - g.starts) / (g.ends - g.starts)));
    out.push({ ...g, state, progress });
  }
  out.sort((a, b) => a.ends - b.ends || a.starts - b.starts);
  return out;
}

/** @param {{preset?: number, custom?: string}} input */
export function parseDuration(input) {
  const bad = { ok: false, message: 'Enter a whole number of minutes from 1 to 1440.' };
  const i = input || {};
  if (i.custom !== undefined && i.custom !== null && String(i.custom).trim() !== '') {
    const t = String(i.custom).trim();
    if (!/^\d+$/.test(t)) return bad;
    const n = Number(t);
    if (n < 1 || n > 1440) return bad;
    return { ok: true, minutes: n };
  }
  if (typeof i.preset === 'number' && Number.isInteger(i.preset) && i.preset >= 1 && i.preset <= 1440) {
    return { ok: true, minutes: i.preset };
  }
  return bad;
}

/** @param {{code?: string, message?: string}} err @returns {HelperState} */
export function classifyHelperFailure(err) {
  const message = typeof err === 'string' ? err : String(err?.message ?? '');
  const code = typeof err === 'object' && err ? err.code : undefined;
  if (code === 'persist-failed') return { kind: 'persist-failed', message };
  const m = message.toLowerCase();
  if (m.includes('not running')) return { kind: 'not-running' };
  if (
    m.includes('only available on windows') ||
    m.includes('only available in the desktop app') ||
    m.includes('__tauri__') ||
    /cannot read propert(y|ies) of undefined/.test(m) ||
    /(undefined|not defined)/.test(m) && m.includes('tauri')
  ) return { kind: 'unavailable' };
  if (m.includes('did not answer in time')) return { kind: 'timeout' };
  return { kind: 'unknown', message: message || 'Unknown error' };
}

function wordsFor(warning) {
  const w = String(warning ?? '').trim();
  if (/^[a-z0-9]+([-_][a-z0-9]+)+$/i.test(w)) {
    const s = w.replace(/[-_]+/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1) + '.';
  }
  return w;
}

/** @param {HelperState} h */
export function bannerFor(h) {
  switch (h && h.kind) {
    case 'ok': {
      const warnings = h.status && Array.isArray(h.status.warnings) ? h.status.warnings : [];
      if (warnings.length) {
        return { level: 'warn', title: 'Helper running, with warnings.', detail: wordsFor(warnings[0]) };
      }
      return { level: 'ok', title: 'Helper running.', detail: '' };
    }
    case 'not-running':
      return {
        level: 'error',
        title: "Blocking is not active. The helper isn't running.",
        detail: 'Install the Focus Room helper (run the MyBrain installer) or, if it is installed, start the MyBrainFocus service.',
      };
    case 'persist-failed':
      return {
        level: 'error',
        title: 'A change is active but will be lost on restart.',
        detail: h.message || "The helper couldn't save it to disk.",
      };
    case 'unavailable':
      return { level: 'muted', title: "Can't reach the helper here.", detail: 'Blocking only works in the Windows app.' };
    case 'timeout':
      return { level: 'error', title: "The helper didn't answer.", detail: 'It may be busy. This will retry automatically.' };
    default:
      return {
        level: 'error',
        title: 'Something went wrong talking to the helper.',
        detail: (h && h.message) || '',
      };
  }
}

/**
 * @param {{code?: string, message?: string}} err
 * @param {number} skipped
 * @param {string[]} listNames
 */
export function describePushProblem(err, skipped, listNames) {
  const message = String(err?.message ?? '').trim();
  const named = (Array.isArray(listNames) ? listNames : []).find((n) => n && message.includes(n));
  let s = named
    ? `The helper rejected the list "${named}": ${message}`
    : message
      ? `The helper rejected the blocking rules: ${message}`
      : "The helper couldn't accept the blocking rules.";
  if (!/[.!?]$/.test(s)) s += '.';
  if (skipped > 0) s += ` ${skipped} ${skipped === 1 ? 'item' : 'items'} couldn't be sent.`;
  return s;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** @param {Status | null} status */
export function detailRows(status) {
  if (!status) {
    return [
      { label: 'Helper', value: 'Not reachable' },
      { label: 'Partner key', value: 'Unknown' },
      { label: 'Blocking now', value: 'Unknown' },
      { label: 'Windows held', value: 'Unknown' },
      { label: 'Warnings', value: 'None' },
      { label: 'Helper clock', value: 'Unknown' },
    ];
  }
  const d = status.decision || {};
  const sites = Array.isArray(d.blockSites) ? d.blockSites.length : 0;
  const apps = Array.isArray(d.blockApps) ? d.blockApps.length : 0;
  const warnings = Array.isArray(status.warnings) ? status.warnings : [];
  let clock = 'Unknown';
  if (Number.isFinite(status.now_ms)) {
    const dt = new Date(status.now_ms);
    if (!Number.isNaN(dt.getTime())) clock = dt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }
  return [
    { label: 'Helper', value: 'Running' },
    { label: 'Partner key', value: status.partner_set ? 'set' : 'not set' },
    { label: 'Blocking now', value: `${plural(sites, 'site', 'sites')}, ${plural(apps, 'app', 'apps')}` },
    { label: 'Windows held', value: String(Array.isArray(status.windows) ? status.windows.length : 0) },
    { label: 'Warnings', value: warnings.length ? warnings.join('; ') : 'None' },
    { label: 'Helper clock', value: clock },
  ];
}
