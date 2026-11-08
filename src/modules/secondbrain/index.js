import { registerModule } from '../../shell/modules.js';
import { notesSearchProvider } from '../../core/search.js';
import { listNotes, getNote, createNote, saveNote, deleteNote, backlinks, findNoteByTitle } from './notes.js';
import { openDailyNote } from './daily.js';
import { relatedNotes } from './resurface.js';
import { renderPreview } from './preview.js';
import { createAutosaver, wikiQuery, applyCompletion } from './editor.js';
import { mountGraph } from './graph-view.js';
import { importNotes, exportNotes } from './importexport.js';
import { entriesToFiles, textsToEntries, summarizeImport } from '../../core/filebridge.js';
import { hasNative, invoke, pickFolder } from '../../shell/native.js';

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter(k => k != null));
  return el;
}

function render(root, ctx) {
  const db = ctx.db;
  const state = { all: [], cur: null, tag: '', q: '', titles: new Set() };
  let alive = true;
  let ac = { items: [], sel: 0 };

  const searchInput = h('input', { type: 'search', placeholder: 'Filter notes…', 'aria-label': 'Filter notes' });
  const tagSelect = h('select', { 'aria-label': 'Filter by tag' });
  const listEl = h('ul', { class: 'sb-list' });
  const titleInput = h('input', { class: 'sb-title', type: 'text', placeholder: 'Title', 'aria-label': 'Note title' });
  const statusEl = h('span', { class: 'muted sb-status' });
  const tagsEl = h('div', { class: 'sb-tags' });
  const textarea = h('textarea', { class: 'sb-text', placeholder: 'Write in Markdown. Link notes with [[Title]]. Tag with #tag.', spellcheck: 'true', 'aria-label': 'Note body' });
  const acEl = h('ul', { class: 'sb-ac', hidden: true });
  const previewEl = h('div', { class: 'sb-preview md' });
  const backEl = h('ul', { class: 'sb-links' });
  const relEl = h('ul', { class: 'sb-links' });
  const bannerEl = h('div', { class: 'banner', hidden: true });
  const editorPane = h('div', { class: 'sb-pane' }, textarea, acEl);
  const main = h('div', { class: 'sb-main' },
    bannerEl,
    h('div', { class: 'sb-head' }, titleInput, statusEl,
      h('button', { class: 'danger', onclick: () => removeCurrent() }, 'Delete')),
    tagsEl,
    h('div', { class: 'sb-split' }, editorPane, previewEl),
    h('div', { class: 'sb-bottom' },
      h('div', {}, h('h4', {}, 'Backlinks'), backEl),
      h('div', {}, h('h4', {}, 'Related notes'), relEl)));
  const side = h('div', { class: 'sb-side' },
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => newNote() }, '＋ New note'),
      h('button', { onclick: () => today() }, '📅 Today')),
    hasNative() ? h('div', { class: 'row' },
      h('button', { onclick: () => importFolder() }, '⬇ Import folder…'),
      h('button', { onclick: () => exportAll() }, '⬆ Export all…')) : null,
    searchInput, tagSelect, listEl);
  const notesView = h('div', { class: 'sb' }, side, main);
  const graphHost = h('div', { class: 'sg', hidden: true });
  let graph = null;
  const notesTab = h('button', { class: 'tab on', onclick: () => showTab('notes') }, 'Notes');
  const graphTab = h('button', { class: 'tab', onclick: () => showTab('graph') }, 'Graph');
  const tabs = h('div', { class: 'sb-tabs' }, notesTab, graphTab);
  root.innerHTML = '';
  root.append(h('div', { class: 'sb-wrap' }, tabs, notesView, graphHost));

  async function showTab(which) {
    const g = which === 'graph';
    notesTab.classList.toggle('on', !g);
    graphTab.classList.toggle('on', g);
    notesView.hidden = g;
    graphHost.hidden = !g;
    if (g) {
      await autosaver.flush();
      if (graph) graph.dispose();
      graph = mountGraph(graphHost, { db, onOpen: async (id) => { await showTab('notes'); await openNote(id); } });
    }
  }

  function banner(msg) {
    bannerEl.hidden = !msg;
    bannerEl.textContent = msg || '';
  }

  const autosaver = createAutosaver({
    save: async ({ id, body }) => { await saveNote(db, id, { body }); },
    onStatus: (s) => {
      if (!alive) return;
      if (s === 'saving') statusEl.textContent = 'Saving…';
      else if (s === 'saved') { statusEl.textContent = 'Saved'; banner(''); afterSave(); }
      else if (s === 'error') { statusEl.textContent = ''; banner("Couldn't save — your text is kept and I'm retrying."); }
    },
  });

  async function loadNotes() {
    state.all = await listNotes(db);
    state.titles = new Set(state.all.map(n => n.title.toLowerCase()));
    paintTags();
    paintList();
  }

  function paintTags() {
    const tags = [...new Set(state.all.flatMap(n => n.tags))].sort();
    tagSelect.innerHTML = '';
    tagSelect.append(h('option', { value: '' }, 'All tags'));
    for (const t of tags) tagSelect.append(h('option', { value: t }, '#' + t));
    if (state.tag && !tags.includes(state.tag)) state.tag = '';
    tagSelect.value = state.tag;
  }

  function paintList() {
    const q = state.q.toLowerCase();
    const shown = state.all.filter(n =>
      (!state.tag || n.tags.includes(state.tag)) &&
      (!q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)));
    listEl.innerHTML = '';
    if (!shown.length) listEl.append(h('li', { class: 'muted sb-empty' }, state.all.length ? 'No matching notes' : 'No notes yet'));
    for (const n of shown) {
      listEl.append(h('li', { class: n.id === state.cur?.id ? 'sel' : '', onclick: () => openNote(n.id) }, n.title));
    }
  }

  function paintTagChips() {
    tagsEl.innerHTML = '';
    for (const t of state.cur?.tags || []) {
      tagsEl.append(h('button', { class: 'chip', onclick: () => { state.tag = t; tagSelect.value = t; paintList(); } }, '#' + t));
    }
  }

  function paintPreview() {
    previewEl.innerHTML = renderPreview(textarea.value, state.titles);
  }

  async function paintSide() {
    if (!state.cur) { backEl.innerHTML = ''; relEl.innerHTML = ''; return; }
    const links = await backlinks(db, state.cur.id);
    backEl.innerHTML = '';
    if (!links.length) backEl.append(h('li', { class: 'muted' }, 'None yet'));
    for (const n of links) backEl.append(h('li', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openNote(n.id); } }, n.title)));
    const rel = relatedNotes({ ...state.cur, body: textarea.value }, state.all);
    relEl.innerHTML = '';
    if (!rel.length) relEl.append(h('li', { class: 'muted' }, 'Nothing related yet'));
    for (const r of rel) relEl.append(h('li', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openNote(r.note.id); } }, r.note.title)));
  }

  async function afterSave() {
    if (!state.cur) return;
    await loadNotes();
    state.cur = await getNote(db, state.cur.id);
    if (!alive) return;
    paintTagChips();
    paintPreview();
    await paintSide();
  }

  async function openNote(id) {
    await autosaver.flush();
    const n = await getNote(db, id);
    if (!alive) return;
    state.cur = n;
    banner('');
    statusEl.textContent = '';
    hideAc();
    if (!n) {
      titleInput.value = '';
      textarea.value = '';
      titleInput.disabled = textarea.disabled = true;
      previewEl.innerHTML = '<p class="muted">Create or pick a note to start.</p>';
      paintTagChips();
      paintList();
      await paintSide();
      return;
    }
    titleInput.disabled = textarea.disabled = false;
    titleInput.value = n.title;
    textarea.value = n.body;
    paintTagChips();
    paintPreview();
    paintList();
    await paintSide();
  }

  async function newNote() {
    await autosaver.flush();
    let title = 'Untitled';
    for (let i = 2; await findNoteByTitle(db, title); i++) title = 'Untitled ' + i;
    const n = await createNote(db, { title });
    await loadNotes();
    await openNote(n.id);
    titleInput.focus();
    titleInput.select();
  }

  async function today() {
    await autosaver.flush();
    const n = await openDailyNote(db);
    await loadNotes();
    await openNote(n.id);
  }

  async function removeCurrent() {
    if (!state.cur) return;
    if (!window.confirm(`Delete "${state.cur.title}"? This cannot be undone.`)) return;
    const id = state.cur.id;
    autosaver.dispose();
    await deleteNote(db, id);
    window.location.reload();
  }

  async function importFolder() {
    try {
      const dir = await pickFolder('Choose a folder of Markdown (.md) files');
      if (!dir) return;
      const entries = await invoke('read_folder_md', { dir });
      await autosaver.flush();
      await invoke('backup_auto', { label: 'before-import' }); // a failure here stops the import
      const result = await importNotes(db, entriesToFiles(entries));
      await loadNotes();
      banner(summarizeImport(result));
    } catch (e) {
      banner('Import stopped: ' + (e && e.message ? e.message : e));
    }
  }

  async function exportAll() {
    try {
      const dir = await pickFolder('Choose a folder to export your notes into');
      if (!dir) return;
      await autosaver.flush();
      const notes = await listNotes(db);
      await invoke('write_files', { dir, files: textsToEntries(exportNotes(notes)) });
      banner(`Exported ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} to ${dir}`);
    } catch (e) {
      banner('Export stopped: ' + (e && e.message ? e.message : e));
    }
  }

  function showAc(q) {
    const needle = q.query.toLowerCase();
    ac.items = state.all.map(n => n.title).filter(t => t.toLowerCase().includes(needle)).slice(0, 6);
    ac.sel = 0;
    if (!ac.items.length) { hideAc(); return; }
    acEl.innerHTML = '';
    ac.items.forEach((t, i) => acEl.append(h('li', {
      class: i === ac.sel ? 'sel' : '',
      onmousedown: (e) => { e.preventDefault(); pick(i); },
    }, t)));
    acEl.hidden = false;
  }

  function hideAc() { acEl.hidden = true; ac.items = []; }

  function pick(i) {
    const r = applyCompletion(textarea.value, textarea.selectionStart, ac.items[i]);
    textarea.value = r.text;
    textarea.setSelectionRange(r.caret, r.caret);
    hideAc();
    onBody();
  }

  function onBody() {
    if (!state.cur) return;
    statusEl.textContent = '…';
    autosaver.change({ id: state.cur.id, body: textarea.value });
    paintPreview();
    const q = wikiQuery(textarea.value, textarea.selectionStart);
    if (q) showAc(q); else hideAc();
  }

  textarea.addEventListener('input', onBody);
  textarea.addEventListener('keydown', (e) => {
    if (acEl.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); ac.sel = (ac.sel + 1) % ac.items.length; [...acEl.children].forEach((li, i) => li.className = i === ac.sel ? 'sel' : ''); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); ac.sel = (ac.sel - 1 + ac.items.length) % ac.items.length; [...acEl.children].forEach((li, i) => li.className = i === ac.sel ? 'sel' : ''); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(ac.sel); }
    else if (e.key === 'Escape') { e.preventDefault(); hideAc(); }
  });
  textarea.addEventListener('blur', () => setTimeout(hideAc, 100));

  titleInput.addEventListener('change', async () => {
    if (!state.cur) return;
    try {
      await saveNote(db, state.cur.id, { title: titleInput.value });
      banner('');
      await afterSave();
    } catch (e) {
      banner(e.message === 'duplicate title' ? 'Another note already has that title.' : e.message === 'empty title' ? 'A note needs a title.' : "Couldn't rename: " + e.message);
      titleInput.value = state.cur.title;
    }
  });

  previewEl.addEventListener('click', async (e) => {
    const a = e.target.closest('a.wikilink');
    if (!a) return;
    e.preventDefault();
    const title = a.dataset.title;
    await autosaver.flush();
    let n = await findNoteByTitle(db, title);
    if (!n) n = await createNote(db, { title });
    await loadNotes();
    await openNote(n.id);
  });

  searchInput.addEventListener('input', () => { state.q = searchInput.value; paintList(); });
  tagSelect.addEventListener('change', () => { state.tag = tagSelect.value; paintList(); });

  (async () => {
    await loadNotes();
    const wanted = Number(ctx.route()[0]);
    const start = wanted && state.all.find(n => n.id === wanted) ? wanted : state.all[0]?.id;
    if (start) await openNote(start); else await openNote(-1);
  })();

  let unlisten = null;
  const ev = window.__TAURI__ && window.__TAURI__.event;
  if (ev) {
    ev.listen('notes-changed', async () => { if (alive) { await loadNotes(); await paintSide(); } })
      .then(u => { unlisten = u; }).catch(() => {});
  }

  return () => {
    alive = false;
    if (unlisten) unlisten();
    if (graph) graph.dispose();
    autosaver.flush().finally(() => autosaver.dispose());
  };
}

registerModule({
  id: 'secondbrain',
  name: 'Second Brain',
  icon: '🧠',
  ready: true,
  searchProvider: notesSearchProvider,
  render,
});
