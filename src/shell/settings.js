import { getTheme, setTheme } from './theme.js';

const sections = [];

// Other modules/features add their own settings sections: fn(container, ctx) => void
export function registerSettingsSection(fn) {
  sections.push(fn);
}

export function renderSettings(root, ctx) {
  root.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'page';
  const h = document.createElement('h2');
  h.textContent = 'Settings';
  page.append(h);

  const theme = document.createElement('section');
  const th = document.createElement('h3');
  th.textContent = 'Theme';
  const sel = document.createElement('select');
  for (const [v, label] of [['system', 'Match Windows'], ['light', 'Light'], ['dark', 'Dark']]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    sel.append(o);
  }
  sel.value = getTheme();
  sel.addEventListener('change', () => setTheme(sel.value));
  theme.append(th, sel);
  page.append(theme);

  for (const fn of sections) {
    const s = document.createElement('section');
    page.append(s);
    fn(s, ctx);
  }
  root.append(page);
}
