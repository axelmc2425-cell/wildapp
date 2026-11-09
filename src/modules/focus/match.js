// Pure helpers for matching sites and apps against focus block lists.

export function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s || /[\s\ufeff\u0000-\u001f\u007f-\u009f]/.test(s)) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.replace(/^[^@]*@/, '');
  s = s.replace(/:\d*$/, '');
  s = s.replace(/\.+$/, '');
  s = s.replace(/^www\./, '');
  if (!s || !s.includes('.')) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  if (s.includes(':') || s.includes('\\')) return null;
  return s;
}

export function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

export function normalizeApp(name) {
  const base = String(name).trim().split(/[\\/]/).pop().toLowerCase();
  return base.endsWith('.exe') ? base : base + '.exe';
}

export function appMatches(processName, entry) {
  return normalizeApp(processName) === normalizeApp(entry);
}
