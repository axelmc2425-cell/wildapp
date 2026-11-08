// totals: Map skillId -> practice minutes. Returns root nodes with children, depth, own and total minutes.
export function buildTree(skills, totals) {
  const nodes = new Map(skills.map(s => [s.id, { ...s, children: [], minutes: totals.get(s.id) || 0, totalMinutes: 0, depth: 0 }]));
  const roots = [];
  for (const n of nodes.values()) {
    const parent = n.parent_id == null ? null : nodes.get(n.parent_id);
    (parent ? parent.children : roots).push(n);
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const fill = (n, depth) => {
    n.depth = depth;
    n.children.sort(byName);
    n.totalMinutes = n.minutes + n.children.reduce((sum, c) => sum + fill(c, depth + 1), 0);
    return n.totalMinutes;
  };
  roots.sort(byName);
  for (const r of roots) fill(r, 0);
  return roots;
}

export function canMove(skills, id, newParentId) {
  if (newParentId == null) return true;
  if (id === newParentId) return false;
  const parentOf = new Map(skills.map(s => [s.id, s.parent_id]));
  for (let p = newParentId, steps = 0; p != null && steps <= skills.length; p = parentOf.get(p), steps++) {
    if (p === id) return false;
  }
  return true;
}
