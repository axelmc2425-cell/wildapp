// Folder rules for the Focus Room (pure). Mirrors `folder_problem` in focus-helper/src/lockstore.rs
// (shared vectors: tests/fixtures/folder-vectors.json).

const BAD_CHARS_RE = /[\u0000-\u001f\u007f-\u009f*?<>|"]/;

/**
 * Canonical stored form: backslashes, no trailing `\`, no `.` segments. Case is kept.
 * @param {string} raw
 * @returns {string | null} null when not an absolute drive path, or when it has `..`, empty or `:` segments
 */
export function normalizeFolder(raw) {
  if (typeof raw !== 'string' || BAD_CHARS_RE.test(raw)) return null;
  const s = raw.replace(/\//g, '\\');
  if (!/^[A-Za-z]:\\/.test(s)) return null;
  const rest = s.slice(3).replace(/\\$/, '');
  const segs = rest === '' ? [] : rest.split('\\').filter((g) => g !== '.');
  if (segs.some((g) => g === '' || g === '..' || g.includes(':'))) return null;
  return s.slice(0, 3) + segs.join('\\');
}

/**
 * @param {string} value
 * @returns {'malformed' | 'forbidden' | null}
 */
export function folderProblem(value) {
  if (typeof value !== 'string' || BAD_CHARS_RE.test(value)) return 'malformed';
  const n = value.replace(/\//g, '\\').replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (!/^[A-Za-z]:\\/.test(n)) return 'malformed';
  let rest = n.slice(3);
  if (rest.endsWith('\\')) rest = rest.slice(0, -1);
  const segs = rest === '' ? [] : rest.split('\\');
  if (segs.some((g) => g === '' || g === '.' || g === '..' || g.includes(':'))) return 'malformed';
  if (segs.length === 0) return 'forbidden';
  if (segs[0] === 'windows') return 'forbidden';
  if (segs.length === 1 && ['program files', 'program files (x86)', 'users'].includes(segs[0])) return 'forbidden';
  if (segs[0] === 'program files' && segs[1] === 'mybrainfocus') return 'forbidden';
  return null;
}
