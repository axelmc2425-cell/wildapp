const KEY = 'theme';

function read() {
  try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
}

export function getTheme() {
  return read();
}

export function applyTheme(choice = read()) {
  const dark = choice === 'dark' || (choice === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function setTheme(choice) {
  try { localStorage.setItem(KEY, choice); } catch { /* storage unavailable: theme just won't persist */ }
  applyTheme(choice);
}
