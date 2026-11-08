import { createDb } from '../core/db.js';
import { createNote, findNoteByTitle } from '../modules/secondbrain/notes.js';
import { quickTitle } from '../core/filebridge.js';
import { applyTheme } from '../shell/theme.js';

applyTheme();
const q = document.getElementById('q');
const msg = document.getElementById('msg');
const T = window.__TAURI__;
const closeWindow = () => (T && T.window ? T.window.getCurrentWindow().close() : window.close());

async function save() {
  const text = q.value.trim();
  if (!text) { closeWindow(); return; }
  try {
    const db = await createDb();
    let title = quickTitle();
    for (let i = 2; await findNoteByTitle(db, title); i++) title = `${quickTitle()} (${i})`;
    await createNote(db, { title, body: text + '\n' });
    if (T && T.event) await T.event.emit('notes-changed');
    closeWindow();
  } catch (e) {
    msg.textContent = "Couldn't save: " + (e.message || e) + ' — your text is still here.';
  }
}

document.getElementById('save').addEventListener('click', save);
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeWindow(); }
});
q.focus();
