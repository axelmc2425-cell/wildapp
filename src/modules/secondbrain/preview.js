import { Marked } from '../../vendor/marked.esm.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const SAFE_URL = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;

let resolved = new Set();

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html(h) { return esc(typeof h === 'string' ? h : h.text); },
    link(href, title, text) {
      if (!SAFE_URL.test(href || '')) return text;
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image(href, title, text) {
      if (!/^https?:/i.test(href || '')) return esc(text || '');
      return `<img src="${esc(href)}" alt="${esc(text || '')}"${title ? ` title="${esc(title)}"` : ''}>`;
    },
  },
  extensions: [{
    name: 'wikilink',
    level: 'inline',
    start(src) { return src.indexOf('[['); },
    tokenizer(src) {
      const m = /^\[\[([^\[\]\n]+)\]\]/.exec(src);
      if (!m) return undefined;
      const [title, alias] = m[1].split('|');
      if (!title.trim()) return undefined;
      return { type: 'wikilink', raw: m[0], title: title.trim(), text: (alias || title).trim() };
    },
    renderer(tok) {
      const cls = resolved.has(tok.title.toLowerCase()) ? 'wikilink' : 'wikilink missing';
      return `<a class="${cls}" data-title="${esc(tok.title)}" href="#">${esc(tok.text)}</a>`;
    },
  }],
});

// resolvedTitles: Set of lowercase note titles that exist.
export function renderPreview(body, resolvedTitles) {
  resolved = resolvedTitles || new Set();
  return marked.parse(String(body || ''));
}
