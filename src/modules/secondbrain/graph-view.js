import { graphData, layoutGraph } from './graph.js';

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

// Draws the note graph on a canvas. onOpen(id) is called when a node is clicked.
export function mountGraph(host, { db, onOpen }) {
  host.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'sg-bar';
  const tagSelect = document.createElement('select');
  tagSelect.setAttribute('aria-label', 'Filter graph by tag');
  const hint = document.createElement('span');
  hint.className = 'muted';
  bar.append(tagSelect, hint);
  const wrap = document.createElement('div');
  wrap.className = 'sg-wrap';
  const canvas = document.createElement('canvas');
  const tip = document.createElement('div');
  tip.className = 'sg-tip';
  tip.hidden = true;
  const empty = document.createElement('div');
  empty.className = 'sg-empty muted';
  empty.textContent = 'No notes yet';
  empty.hidden = true;
  wrap.append(canvas, tip, empty);
  host.append(bar, wrap);

  let data = { nodes: [], edges: [] };
  let pos = new Map();
  let degree = new Map();
  let hover = null;
  let tag = '';
  let size = { w: 0, h: 0 };
  let disposed = false;

  const radius = (id) => 5 + Math.min(degree.get(id) || 0, 8) * 1.2;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = size.w + 'px';
    canvas.style.height = size.h + 'px';
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);
    g.strokeStyle = css('--border');
    g.lineWidth = 1.2;
    for (const e of data.edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    g.font = '12px "Segoe UI", sans-serif';
    g.textAlign = 'center';
    for (const n of data.nodes) {
      const p = pos.get(n.id);
      g.beginPath();
      g.arc(p.x, p.y, radius(n.id), 0, Math.PI * 2);
      g.fillStyle = n.id === hover ? css('--danger') : css('--accent');
      g.fill();
      g.fillStyle = css('--text');
      g.fillText(n.title.length > 22 ? n.title.slice(0, 21) + '…' : n.title, p.x, p.y + radius(n.id) + 13);
    }
  }

  function relayout() {
    pos = layoutGraph(data.nodes, data.edges, { width: Math.max(size.w, 100), height: Math.max(size.h, 100), margin: 70 });
    draw();
  }

  async function load() {
    data = await graphData(db, { tag });
    if (disposed) return;
    degree = new Map();
    for (const e of data.edges) {
      degree.set(e.from, (degree.get(e.from) || 0) + 1);
      degree.set(e.to, (degree.get(e.to) || 0) + 1);
    }
    empty.hidden = data.nodes.length > 0 || !!tag;
    hint.textContent = data.nodes.length ? `${data.nodes.length} notes, ${data.edges.length} links` : '';
    relayout();
  }

  async function loadTags() {
    const all = await graphData(db, {});
    const tags = [...new Set(all.nodes.flatMap(n => n.tags))].sort();
    tagSelect.innerHTML = '';
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'All tags';
    tagSelect.append(o);
    for (const t of tags) {
      const op = document.createElement('option');
      op.value = t;
      op.textContent = '#' + t;
      tagSelect.append(op);
    }
    tagSelect.value = tag;
  }

  function nodeAt(x, y) {
    let best = null;
    for (const n of data.nodes) {
      const p = pos.get(n.id);
      if (Math.hypot(p.x - x, p.y - y) <= radius(n.id) + 3) best = n;
    }
    return best;
  }

  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    const n = nodeAt(e.clientX - r.left, e.clientY - r.top);
    const id = n ? n.id : null;
    canvas.style.cursor = n ? 'pointer' : 'default';
    if (id !== hover) { hover = id; draw(); }
    tip.hidden = !n;
    if (n) {
      tip.textContent = n.title;
      tip.style.left = e.clientX - r.left + 12 + 'px';
      tip.style.top = e.clientY - r.top + 12 + 'px';
    }
  });
  canvas.addEventListener('mouseleave', () => { hover = null; tip.hidden = true; draw(); });
  canvas.addEventListener('click', (e) => {
    const r = canvas.getBoundingClientRect();
    const n = nodeAt(e.clientX - r.left, e.clientY - r.top);
    if (n) onOpen(n.id);
  });
  tagSelect.addEventListener('change', () => { tag = tagSelect.value; load(); });

  const ro = new ResizeObserver(() => {
    const r = wrap.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    size = { w: Math.floor(r.width), h: Math.floor(r.height) };
    relayout();
  });
  ro.observe(wrap);

  loadTags().then(load);

  return {
    refresh() { loadTags().then(load); },
    dispose() { disposed = true; ro.disconnect(); },
  };
}
