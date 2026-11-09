import { Marked } from '../../vendor/marked.esm.js';
import { linkTarget } from './parse.js';
import { titleKey } from '../../core/titlekey.js';

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
      const [shown, alias] = m[1].split('|');
      const title = linkTarget(m[1]);
      if (!title) return undefined;
      return { type: 'wikilink', raw: m[0], title, text: (alias || shown).trim() };
    },
    renderer(tok) {
      const cls = resolved.has(titleKey(tok.title)) ? 'wikilink' : 'wikilink missing';
      return `<a class="${cls}" data-title="${esc(tok.title)}" href="#">${esc(tok.text)}</a>`;
    },
  }],
});

// resolvedTitles: Set of lowercase note titles that exist.
// ![[file]] is an Obsidian embed, not a link: escape it (outside code blocks) so it shows as plain text.
function escapeEmbeds(body) {
  return body.split(/(```[\s\S]*?```)/g).map((part, i) => (i % 2 ? part : part.replace(/!\[\[/g, '!\\[\\['))).join('');
}

export function renderPreview(body, resolvedTitles) {
  resolved = resolvedTitles || new Set();
  return marked.parse(escapeEmbeds(String(body || '')));
}
