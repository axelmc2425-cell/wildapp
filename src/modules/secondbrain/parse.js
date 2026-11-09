const FENCE = /```[\s\S]*?```/g;

function stripCode(text) {
  return String(text || '').replace(FENCE, '');
}

export function extractLinks(body) {
  const seen = new Set();
  const out = [];
  for (const m of stripCode(body).matchAll(/\[\[([^\[\]]*)\]\]/g)) {
    const title = m[1].split('|')[0].trim();
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
