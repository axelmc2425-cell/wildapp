import { createDb } from './core/db.js';
import { searchAll } from './core/search.js';
import { listModules, getModule, runStartHooks } from './shell/modules.js';
import './shell/builtin.js';
import './modules/secondbrain/index.js';
import './modules/focus/index.js';
import { applyTheme } from './shell/theme.js';
import { createPalette } from './shell/palette.js';
import { renderSettings } from './shell/settings.js';
import './shell/settings-data.js';

applyTheme();

const content = document.getElementById('content');
const modlist = document.getElementById('modlist');
let db = null;
let cleanup = null;

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { id: parts[0] || 'secondbrain', rest: parts.slice(1) };
}

function open(moduleId, itemId) {
  location.hash = '#/' + moduleId + (itemId === undefined ? '' : '/' + itemId);
}

const ctx = { get db() { return db; }, open, route: () => parseRoute().rest, reload: () => route() };

function paintSidebar(activeId) {
  modlist.innerHTML = '';
  for (const m of listModules()) {
    const a = document.createElement('a');
    a.href = '#/' + m.id;
    a.className = 'navitem' + (m.id === activeId ? ' active' : '') + (m.ready ? '' : ' soon-item');
    a.textContent = `${m.icon} ${m.name}`;
    if (!m.ready) {
      const s = document.createElement('small');
      s.textContent = 'soon';
      a.append(s);
    }
    modlist.append(a);
  }
  document.getElementById('settingslink').classList.toggle('active', activeId === 'settings');
}

function route() {
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;
  const { id } = parseRoute();
  paintSidebar(id);
  if (id === 'settings') { renderSettings(content, ctx); return; }
  const mod = getModule(id);
  if (!mod) { content.textContent = 'Not found.'; return; }
  cleanup = mod.render(content, ctx);
}

async function boot() {
  try {
    db = await createDb();
  } catch (e) {
    content.innerHTML = '';
    const p = document.createElement('div');
    p.className = 'page';
    p.textContent = 'Could not open the database: ' + (e && e.message ? e.message : e);
    content.append(p);
    return;
  }
  const palette = createPalette({
    root: document.getElementById('palette'),
    input: document.getElementById('palette-input'),
    list: document.getElementById('palette-results'),
    search: (q) => searchAll(db, q),
    open,
  });
  document.getElementById('searchbtn').addEventListener('click', () => palette.show());
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.isOpen() ? palette.hide() : palette.show(); }
  });
  window.addEventListener('hashchange', route);
  try { await runStartHooks(ctx); } catch (e) { console.error('start hooks failed', e); }
  route();
}

boot();
