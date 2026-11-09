const FENCE = /```[\s\S]*?```/g;

function stripCode(text) {
  return String(text || '').replace(FENCE, '');
}

// The note a [[...]] link points at. Understands [[Title|alias]], [[Title#Heading]], [[Title^block]]
// and [[folder/Title]] (Obsidian style); returns '' when there is no note target (e.g. [[#Heading]]).
export function linkTarget(inner) {
  let t = String(inner).split('|')[0];
  t = t.split('#')[0].split('^')[0];
  if (t.includes('/')) t = t.slice(t.lastIndexOf('/') + 1);
  return t.trim();
}

export function extractLinks(body) {
  const seen = new Set();
  const out = [];
  // ![[file]] is an embed, not a link.
  for (const m of stripCode(body).matchAll(/(?<!!)\[\[([^\[\]]*)\]\]/g)) {
    const title = linkTarget(m[1]);
    const key = title.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    out.push(title);
  }
  return out;
}

export function extractTags(body) {
  const text = stripCode(body).replace(/https?:\/\/\S+/g, '');
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(/(^|[\s(])#([\p{L}\p{N}_\-/]+)/gu)) {
    const tag = m[2].toLowerCase();
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}
