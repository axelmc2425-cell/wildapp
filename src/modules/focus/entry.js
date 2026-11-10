// Single source of entry validation for the Focus Room UI (pure).
import { normalizeDomain, normalizeApp } from './match.js';
import { validItem } from './limits.js';
import { normalizeFolder, folderProblem } from './folders.js';

const FOLDER_MALFORMED = 'Pick a folder with the Browse folder button.';

/**
 * @param {'site'|'app'|'folder'} kind
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
  if (kind === 'folder') {
    const value = normalizeFolder(text);
    if (/^(\\\\|\/\/)/.test(text)) return { ok: false, message: "Network paths aren't supported. Use a folder on a drive letter." };
    if (value === null) return { ok: false, message: FOLDER_MALFORMED };
    const problem = folderProblem(value);
    if (problem === 'forbidden') return { ok: false, message: "That folder is part of Windows and can't be blocked." };
    if (problem !== null) return { ok: false, message: FOLDER_MALFORMED };
    return { ok: true, value, changed: value !== text };
  }
  // Windows paths (backslashes) are reduced to the file name; a forward slash is never a Windows path.
  if (text.includes('/')) return { ok: false, message: "Use the program's file name, like steam.exe." };
  const value = normalizeApp(text);
  if (value.slice(0, -'.exe'.length).trim() === '') return { ok: false, message: "Use the program's file name, like steam.exe." };
  if (!validItem('app', value)) return { ok: false, message: "Use the program's file name, like steam.exe." };
  return { ok: true, value, changed: value !== text.toLowerCase() };
}
