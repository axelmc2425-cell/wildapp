// Pure decision of what is blocked at a point in time, from focus windows.
import { hostMatches, appMatches } from './match.js';

export const CRITICAL_APPS = [
  'system', 'system idle process', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe',
  'winlogon.exe', 'services.exe', 'lsass.exe', 'svchost.exe', 'dwm.exe', 'explorer.exe',
  'fontdrvhost.exe', 'sihost.exe', 'taskhostw.exe', 'ctfmon.exe', 'conhost.exe',
  'runtimebroker.exe', 'searchhost.exe', 'startmenuexperiencehost.exe',
  'shellexperiencehost.exe', 'audiodg.exe', 'spoolsv.exe', 'msedgewebview2.exe',
  'mybrain.exe', 'focus-helper.exe',
  // Logon/UAC/session, shell hosts, security and servicing: killing any of these can lock the
  // owner out of Windows, so they are never killed even in an allow-list.
  'logonui.exe', 'consent.exe', 'credentialuibroker.exe', 'userinit.exe', 'lockapp.exe',
  'dllhost.exe', 'wmiprvse.exe', 'applicationframehost.exe', 'textinputhost.exe',
  'securityhealthservice.exe', 'msmpeng.exe', 'nissrv.exe', 'searchindexer.exe',
  'wudfhost.exe', 'tiworker.exe', 'trustedinstaller.exe', 'sgrmbroker.exe', 'dashost.exe',
  'smartscreen.exe', 'backgroundtaskhost.exe', 'memory compression', 'secure system',
  'sppsvc.exe', 'searchapp.exe', 'shellhost.exe',
];

/**
 * @typedef {Object} Decision
 * @property {string[]} blockSites
 * @property {string[]} blockApps
 * @property {{sites: string[], apps: string[]} | null} allow
 * @property {boolean} frozen
 * @property {{id: string, lock: string, ends: number}[]} locks sorted by id
 */

const uniqSorted = (xs) => [...new Set(xs)].sort();

/** @param {import('./limits.js').Window[]} windows @param {number} nowMs @returns {Decision} */
export function decide(windows, nowMs) {
  const active = windows.filter((w) => w.starts <= nowMs && nowMs < w.ends);
  const blocks = active.filter((w) => w.mode === 'block');
  const allows = active.filter((w) => w.mode === 'allow');
  return {
    blockSites: uniqSorted(blocks.flatMap((w) => w.sites)),
    blockApps: uniqSorted(blocks.flatMap((w) => w.apps)),
    allow: allows.length
      ? { sites: uniqSorted(allows.flatMap((w) => w.sites)), apps: uniqSorted(allows.flatMap((w) => w.apps)) }
      : null,
    frozen: active.some((w) => w.lock === 'frozen'),
    locks: active
      .filter((w) => w.lock !== 'none')
      .map((w) => ({ id: w.id, lock: w.lock, ends: w.ends }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/** @param {Decision} d @param {string} host */
export function isBlockedSite(d, host) {
  if (typeof host !== 'string') return false;
  const h = host.trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return false;
  if (d.blockSites.some((s) => hostMatches(h, s))) return true;
  return d.allow !== null && !d.allow.sites.some((s) => hostMatches(h, s));
}

/** @param {Decision} d @param {string} processName */
export function isBlockedApp(d, processName) {
  if (typeof processName !== 'string' || !processName.trim()) return false;
  if (CRITICAL_APPS.some((c) => appMatches(processName, c))) return false;
  if (d.blockApps.some((a) => appMatches(processName, a))) return true;
  if (d.allow !== null || d.frozen) {
    const apps = d.allow ? d.allow.apps : [];
    return !apps.some((a) => appMatches(processName, a));
  }
  return false;
}
