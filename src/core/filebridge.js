// Helpers for moving files between the Rust commands (JSON byte arrays) and the JS note code.
const pad = (n) => String(n).padStart(2, '0');

export function entriesToFiles(entries) {
  return entries.map(e => ({ path: e.path, bytes: Uint8Array.from(e.bytes) }));
}

export function textsToEntries(files) {
  const enc = new TextEncoder();
  return files.map(f => ({ path: f.path, bytes: [...enc.encode(f.text)] }));
}

export function summarizeImport({ created, skipped }) {
  let s = `Imported ${created} ${created === 1 ? 'note' : 'notes'}.`;
  if (skipped.length) {
    const shown = skipped.slice(0, 5).map(x => `${x.path} (${x.reason})`).join(', ');
    const more = skipped.length > 5 ? `, and ${skipped.length - 5} more` : '';
    s += ` Skipped ${skipped.length}: ${shown}${more}.`;
  }
  return s;
}

export function quickTitle(d = new Date()) {
  return `Quick ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
