export async function graphData(db, { tag } = {}) {
  const noteRows = tag
    ? await db.all('SELECT n.id, n.title FROM notes n JOIN tags t ON t.note_id = n.id WHERE t.tag = ? ORDER BY n.id', [String(tag).toLowerCase()])
    : await db.all('SELECT id, title FROM notes ORDER BY id');
  const ids = new Set(noteRows.map(n => n.id));
  const tagRows = await db.all('SELECT note_id, tag FROM tags ORDER BY tag');
  const tagsById = new Map();
  for (const t of tagRows) {
    if (!ids.has(t.note_id)) continue;
    (tagsById.get(t.note_id) || tagsById.set(t.note_id, []).get(t.note_id)).push(t.tag);
  }
  const nodes = noteRows.map(n => ({ id: n.id, title: n.title, tags: tagsById.get(n.id) || [] }));
  const linkRows = await db.all(
    "SELECT from_id, to_id FROM links WHERE from_type = 'note' AND to_type = 'note' AND from_id != to_id ORDER BY from_id, to_id");
  const edges = linkRows.filter(l => ids.has(l.from_id) && ids.has(l.to_id)).map(l => ({ from: l.from_id, to: l.to_id }));
  return { nodes, edges };
}

// Deterministic Fruchterman-Reingold layout; every point stays inside the box.
export function layoutGraph(nodes, edges, { width, height, iterations = 200, margin: wantedMargin = 20 }) {
  const out = new Map();
  if (!nodes.length) return out;
  if (nodes.length === 1) {
    out.set(nodes[0].id, { x: width / 2, y: height / 2 });
    return out;
  }
  const margin = Math.min(wantedMargin, width / 4, height / 4);
  const pos = nodes.map((n, i) => {
    const a = (2 * Math.PI * i) / nodes.length;
    return { id: n.id, x: width / 2 + Math.cos(a) * width * 0.3, y: height / 2 + Math.sin(a) * height * 0.3, dx: 0, dy: 0 };
  });
  const index = new Map(pos.map((p, i) => [p.id, i]));
  const k = Math.sqrt((width * height) / nodes.length) * 0.6;
  let temp = Math.min(width, height) / 8;
  for (let it = 0; it < iterations; it++) {
    for (const p of pos) { p.dx = 0; p.dy = 0; }
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        let ddx = pos[i].x - pos[j].x, ddy = pos[i].y - pos[j].y;
        let d = Math.hypot(ddx, ddy);
        if (d < 0.01) { ddx = 0.01 * (i + 1); ddy = 0.01 * (j + 1); d = Math.hypot(ddx, ddy); }
        const f = (k * k) / d;
        pos[i].dx += (ddx / d) * f; pos[i].dy += (ddy / d) * f;
        pos[j].dx -= (ddx / d) * f; pos[j].dy -= (ddy / d) * f;
      }
    }
    for (const e of edges) {
      const a = pos[index.get(e.from)], b = pos[index.get(e.to)];
      if (!a || !b) continue;
      const ddx = a.x - b.x, ddy = a.y - b.y;
      const d = Math.max(Math.hypot(ddx, ddy), 0.01);
      const f = (d * d) / k;
      a.dx -= (ddx / d) * f; a.dy -= (ddy / d) * f;
      b.dx += (ddx / d) * f; b.dy += (ddy / d) * f;
    }
    for (const p of pos) {
      p.dx += (width / 2 - p.x) * 0.05; p.dy += (height / 2 - p.y) * 0.05; // gentle pull to centre
      const d = Math.max(Math.hypot(p.dx, p.dy), 0.01);
      const step = Math.min(d, temp);
      p.x = Math.min(width - margin, Math.max(margin, p.x + (p.dx / d) * step));
      p.y = Math.min(height - margin, Math.max(margin, p.y + (p.dy / d) * step));
    }
    temp *= 0.97;
  }
  for (const p of pos) out.set(p.id, { x: p.x, y: p.y });
  return out;
}
