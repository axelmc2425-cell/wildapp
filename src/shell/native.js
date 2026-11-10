// Thin wrappers over the Tauri globals (window.__TAURI__). Only available in the desktop app.
const T = () => window.__TAURI__;

export const hasNative = () => !!(T() && T().dialog && T().core);
export const invoke = (cmd, args) => T().core.invoke(cmd, args);

export async function pickFolder(title) {
  const r = await T().dialog.open({ directory: true, multiple: false, title });
  return r || null;
}

export async function pickExeFiles(title) {
  const r = await T().dialog.open({ multiple: true, title, filters: [{ name: 'Programs', extensions: ['exe'] }] });
  if (!r) return null;
  return Array.isArray(r) ? r : [r];
}

export async function pickZip() {
  const r = await T().dialog.open({ multiple: false, filters: [{ name: 'MyBrain backup', extensions: ['zip'] }] });
  return r || null;
}

export async function pickZipSavePath(defaultPath) {
  const r = await T().dialog.save({ defaultPath, filters: [{ name: 'MyBrain backup', extensions: ['zip'] }] });
  return r || null;
}

/** Save dialog; resolves to the chosen full path, or null when cancelled. */
export async function pickSavePath(defaultName, ext) {
  const r = await T().dialog.save({ defaultPath: defaultName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  return r || null;
}

/** Opens the file manager with the file selected (Windows only; rejects elsewhere). */
export async function revealInFolder(path) {
  await invoke('reveal_in_folder', { path });
}
