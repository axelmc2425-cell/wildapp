// Db adapter over the Rust commands db_all, db_run and db_batch.
export async function openTauriDb() {
  const invoke = window.__TAURI__.core.invoke;
  return {
    all: (sql, params = []) => invoke('db_all', { sql, params }),
    run: (sql, params = []) => invoke('db_run', { sql, params }),
    batch: (stmts) => invoke('db_batch', { stmts: stmts.map(s => ({ sql: s.sql, params: s.params || [] })) }),
  };
}
