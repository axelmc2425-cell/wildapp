// Single source of entry validation for the Focus Room UI (pure).
import { normalizeDomain, normalizeApp } from './match.js';
import { validItem } from './limits.js';

/**
 * @param {'site'|'app'} kind
 * @param {string} raw
 * @returns {{ok: true, value: string, changed: boolean} | {ok: false, message: string}}
 */
export function checkEntry(kind, raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { ok: false, message: 'Type something first.' };
  if (kind === 'site') {
    const value = normalizeDomain(text);
    if (value === null || !validItem('site', value)) {
      return { ok: false, message: "That doesn't look like a website address." };
    }
    return { ok: true, value, changed: value !== text.toLowerCase() };
  }
  // Windows paths (backslashes) are reduced to the file name; a forward slash is never a Windows path.
  if (text.includes('/')) return { ok: false, message: "Use the program's file name, like steam.exe." };
  const value = normalizeApp(text);
  if (!validItem('app', value)) return { ok: false, message: "Use the program's file name, like steam.exe." };
  return { ok: true, value, changed: value !== text.toLowerCase() };
}
