import { createNote, findNoteByTitle } from './notes.js';

const FRONT = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

function unquote(v) {
  v = v.trim();
  if (v.startsWith('"')) { try { return JSON.parse(v); } catch { /* fall through */ } }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
  return v;
}

function parseFront(block) {
  const out = { title: null, tags: [] };
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(title|tags):\s*(.*)$/i);
    if (!m) continue;
    if (m[1].toLowerCase() === 'title') { out.title = unquote(m[2]); continue; }
    const rest = m[2].trim();
    if (rest) {
      out.tags.push(...rest.replace(/^\[|\]$/g, '').split(',').map(unquote));
    } else {
      for (let j = i + 1; j < lines.length; j++) {
        const li = lines[j].match(/^\s*-\s+(.*)$/);
        if (!li) break;
        out.tags.push(unquote(li[1]));
        i = j;
      }
    }
  }
  return out;
}

const cleanTag = (t) => String(t).trim().replace(/^#/, '').replace(/\s+/g, '-');

export function parseMarkdownFiles(files) {
  const notes = [];
  const skipped = [];
  const seen = new Map();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const f of files) {
    if (!/\.md$/i.test(f.path)) { skipped.push({ path: f.path, reason: 'not markdown' }); continue; }
    let text;
    try { text = decoder.decode(f.bytes); } catch { skipped.push({ path: f.path, reason: 'not UTF-8' }); continue; }
    text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    let title = null;
    let tags = [];
    const m = text.match(FRONT);
    if (m) {
      const fm = parseFront(m[1]);
      title = fm.title;
      tags = fm.tags.map(cleanTag).filter(t => /^[\p{L}\p{N}_\-/]+$/u.test(t));
      text = text.slice(m[0].length);
    }
    if (!title) title = f.path.split(/[\\/]/).pop().replace(/\.md$/i, '');
    title = title.trim() || 'Untitled';
    if (tags.length) text = text.replace(/\s*$/, '') + '\n\n' + tags.map(t => '#' + t).join(' ') + '\n';
    const key = title.toLowerCase();
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    notes.push({ title: n > 1 ? `${title} (${n})` : title, body: text, path: f.path });
  }
  return { notes, skipped };
}

export async function importNotes(db, files) {
  const { notes, skipped } = parseMarkdownFiles(files);
  let created = 0;
  for (const n of notes) {
    if (await findNoteByTitle(db, n.title)) { skipped.push({ path: n.path, reason: 'already exists' }); continue; }
    try {
      await createNote(db, { title: n.title, body: n.body });
      created++;
    } catch (e) {
      skipped.push({ path: n.path, reason: String(e.message || e) });
    }
  }
  return { created, skipped };
}

function fileName(title) {
  const base = String(title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/[ .]+$/, '').trim();
  return base || 'untitled';
}

export function exportNotes(notes) {
  const used = new Map();
  return notes.map(n => {
    const base = fileName(n.title);
    const key = base.toLowerCase();
    const count = (used.get(key) || 0) + 1;
    used.set(key, count);
    const name = count > 1 ? `${base} (${count})` : base;
    return { path: name + '.md', text: `---\ntitle: ${JSON.stringify(n.title)}\n---\n${n.body}` };
  });
}
