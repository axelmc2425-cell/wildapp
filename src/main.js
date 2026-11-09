import { createDb } from './core/db.js';
import { listModules, getModule, runStartHooks } from './shell/modules.js';
import './modules/focus/index.js';
import { applyTheme } from './shell/theme.js';
import { renderSettings } from './shell/settings.js';
import { createRouteRunner } from './shell/router.js';
import './shell/settings-data.js';

applyTheme();

const content = document.getElementById('content');
const modlist = document.getElementById('modlist');
let db = null;
const runner = createRouteRunner();

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { id: parts[0] || 'focus', rest: parts.slice(1) };
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

async function route() {
  const { id } = parseRoute();
  paintSidebar(id);
  // Each screen gets its own container, so a slow render that finishes late can only write into a screen nobody sees.
  const host = document.createElement('div');
  host.style.height = '100%';
  content.replaceChildren(host);
  try {
    await runner.run(async () => {
      if (id === 'settings') { renderSettings(host, ctx); return undefined; }
      const mod = getModule(id);
      if (!mod) { host.textContent = 'Not found.'; return undefined; }
      return mod.render(host, ctx);
    });
  } catch (e) {
    host.textContent = 'Something went wrong opening this screen: ' + (e && e.message ? e.message : e);
  }
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
  window.addEventListener('hashchange', route);
  try { await runStartHooks(ctx); } catch (e) { console.error('start hooks failed', e); }
  route();
}

boot();
