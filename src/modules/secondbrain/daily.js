import { createNote, findNoteByTitle } from './notes.js';

const pad = (n) => String(n).padStart(2, '0');

export function dailyTitle(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function openDailyNote(db, d = new Date()) {
  const title = dailyTitle(d);
  const existing = await findNoteByTitle(db, title);
  if (existing) return existing;
  return createNote(db, { title, body: `# ${title}\n\n## Today\n\n## Notes\n` });
}
