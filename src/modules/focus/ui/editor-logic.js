// Pure logic behind the list editor's chip inputs (no DOM).
import { checkEntry } from '../entry.js';

export const MAX_ENTRIES = 512;
const CAP_MESSAGE = 'A list can hold up to 512 entries.';

const keyOf = (kind) => (kind === 'site' ? 'sites' : kind === 'folder' ? 'folders' : 'apps');

/** The folder's name (last path segment) for display; falls back to the whole path. */
export function folderLabel(path) {
  const parts = String(path ?? '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path ?? '');
}

/** Splits pasted text into raw pieces. Apps keep inner spaces; sites split on any whitespace too. */
export function splitPaste(kind, text) {
  const re = kind === 'site' ? /[\s,]+/ : /[\r\n,]+/;
  return String(text ?? '').split(re).map(s => s.trim()).filter(Boolean);
}

/** Adds each raw piece to the state. Returns a new state plus notes (normalized-value notices) and errors. */
export function addEntries(state, kind, rawPieces) {
  const key = keyOf(kind);
  const next = { sites: [...state.sites], apps: [...state.apps], folders: [...(state.folders || [])] };
  const notes = [];
  const errors = [];
  for (const raw of rawPieces) {
    const res = checkEntry(kind, raw);
    if (!res.ok) { errors.push({ value: raw, message: res.message }); continue; }
    if (next[key].includes(res.value)) continue;
    if (next.sites.length + next.apps.length + next.folders.length >= MAX_ENTRIES) {
      if (!errors.some(e => e.message === CAP_MESSAGE)) errors.push({ value: raw, message: CAP_MESSAGE });
      break;
    }
    next[key].push(res.value);
    if (res.changed) notes.push(`Will be saved as ${res.value}`);
  }
  return { state: next, notes, errors };
}

export function canSave({ name, sites, apps, folders }) {
  return String(name ?? '').trim() !== '' && (sites.length + apps.length + (folders || []).length) > 0;
}

export function removeLast(state, kind) {
  const key = keyOf(kind);
  if (!state[key] || state[key].length === 0) return state;
  return { ...state, [key]: state[key].slice(0, -1) };
}
