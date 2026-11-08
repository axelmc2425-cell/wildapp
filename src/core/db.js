import { migrate } from './schema.js';

export { migrate };

// In the app (Tauri) this opens the Rust-backed database; tests use openNodeDb directly.
export async function createDb() {
  const { openTauriDb } = await import('./db-tauri.js');
  const db = await openTauriDb();
  await migrate(db);
  return db;
}
