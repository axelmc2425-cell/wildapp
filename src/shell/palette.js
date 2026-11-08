// Ctrl+K palette. `search(query)` resolves to SearchHit[]; `open(moduleId, itemId)` navigates.
export function createPalette({ root, input, list, search, open }) {
  let hits = [];
  let sel = 0;
  let ticket = 0;
  let timer = null;

  function paint(emptyText) {
    list.innerHTML = '';
    if (!hits.length) {
      if (emptyText) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = emptyText;
        list.append(li);
      }
      return;
    }
    hits.forEach((h, i) => {
      const li = document.createElement('li');
      if (i === sel) li.className = 'sel';
      const mod = document.createElement('span');
      mod.className = 'mod';
      mod.textContent = h.module;
      const title = document.createElement('span');
      title.textContent = h.title;
      li.append(mod, title);
      if (h.snippet) {
        const s = document.createElement('span');
        s.className = 'snip';
        s.textContent = h.snippet;
        li.append(s);
      }
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      list.append(li);
    });
  }

  function choose(i) {
    const h = hits[i];
    if (!h) return;
    hide();
    open(h.module, h.id);
  }

  async function run() {
    const my = ++ticket;
    const q = input.value.trim();
    if (!q) { hits = []; paint(); return; }
    const found = await search(q);
    if (my !== ticket) return;
    hits = found;
    sel = 0;
    paint('No matches');
  }

  function show() {
    root.hidden = false;
    input.value = '';
    hits = [];
    paint();
    input.focus();
  }

  function hide() {
    root.hidden = true;
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 80); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, hits.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); hide(); }
  });
  root.addEventListener('mousedown', (e) => { if (e.target === root) hide(); });

  return { show, hide, isOpen: () => !root.hidden };
}
