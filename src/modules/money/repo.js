export async function saveScenario(db, scenario) {
  const { id, name, ...rest } = scenario;
  const json = JSON.stringify(rest);
  const n = String(name || '').trim() || 'Untitled scenario';
  if (id) {
    await db.run('UPDATE scenarios SET name = ?, json = ?, updated = ? WHERE id = ?', [n, json, Date.now(), id]);
    return getScenario(db, id);
  }
  const r = await db.run('INSERT INTO scenarios(name, json, updated) VALUES (?, ?, ?)', [n, json, Date.now()]);
  return getScenario(db, r.lastInsertId);
}

const parse = (r) => ({ id: r.id, name: r.name, ...JSON.parse(r.json) });

export async function getScenario(db, id) {
  const [r] = await db.all('SELECT * FROM scenarios WHERE id = ?', [id]);
  return r ? parse(r) : null;
}

export async function listScenarios(db) {
  return (await db.all('SELECT * FROM scenarios ORDER BY id')).map(parse);
}

export async function deleteScenario(db, id) {
  await db.run('DELETE FROM scenarios WHERE id = ?', [id]);
}

export async function moneySearch(db, q) {
  const needle = q.toLowerCase();
  return (await listScenarios(db)).filter(s => s.name.toLowerCase().includes(needle)).slice(0, 15)
    .map(s => ({ module: 'money', id: s.id, title: s.name, snippet: `Goal ${s.goal} in ${s.horizonYears} years` }));
}
