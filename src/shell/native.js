// Thin wrappers over the Tauri globals (window.__TAURI__). Only available in the desktop app.
const T = () => window.__TAURI__;

export const hasNative = () => !!(T() && T().dialog && T().core);
export const invoke = (cmd, args) => T().core.invoke(cmd, args);

export async function pickFolder(title) {
  const r = await T().dialog.open({ directory: true, multiple: false, title });
  return r || null;
}

export async function pickZip() {
  const r = await T().dialog.open({ multiple: false, filters: [{ name: 'MyBrain backup', extensions: ['zip'] }] });
  return r || null;
}

export async function pickZipSavePath(defaultPath) {
  const r = await T().dialog.save({ defaultPath, filters: [{ name: 'MyBrain backup', extensions: ['zip'] }] });
  return r || null;
}
