// Minimal DOM stand-in for the Focus UI tests (the project has no jsdom). Supports just what ui/dom.js, dialog.js and list-editor.js use.
class Node_ {
  constructor() { this.children = []; this.parent = null; }
}
class Text_ extends Node_ {
  constructor(t) { super(); this.data = String(t); }
  get textContent() { return this.data; }
}
export class El extends Node_ {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.listeners = {}; this.className = ''; this.value = ''; this.disabled = false; this.style = {}; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  get hidden() { return 'hidden' in this.attrs; }
  set hidden(v) { if (v) this.attrs.hidden = ''; else delete this.attrs.hidden; }
  get parentElement() { return this.parent; }
  get title() { return this.attrs.title ?? ''; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n === document.body; }
  get offsetParent() { return this.isConnected ? document.body : null; }
  append(...kids) { for (const k of kids) { const n = k instanceof Node_ ? k : new Text_(k); if (n.parent) n.parent.children = n.parent.children.filter(c => c !== n); n.parent = this; this.children.push(n); } }
  replaceChildren(...kids) { for (const c of this.children) c.parent = null; this.children = []; this.append(...kids); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  get textContent() { return this.children.map(c => c.textContent).join(''); }
  set textContent(t) { this.replaceChildren(...(t === '' || t == null ? [] : [String(t)])); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter(f => f !== fn); }
  async click() { await Promise.all((this.listeners.click || []).map(f => f({ target: this }))); await new Promise(r => setImmediate(r)); }
  focus() { document.activeElement = this; }
  contains(n) { for (; n; n = n.parent) if (n === this) return true; return false; }
  matches(sel) {
    return sel.split(',').map(s => s.trim()).some(s => (s[0] === '[' ? this.getAttribute(s.slice(1, -1)) !== null : s === this.tag));
  }
  querySelectorAll(sel) { const out = []; walk(this, (n) => { if (n !== this && n.matches(sel)) out.push(n); }); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
export function walk(node, fn) { if (node instanceof El) fn(node); for (const c of node.children) walk(c, fn); }
export const findAll = (root, pred) => { const out = []; walk(root, (n) => { if (pred(n)) out.push(n); }); return out; };

/** Installs globalThis.document (and optionally window.__TAURI__); returns the body. */
export function installDom(tauri) {
  const listeners = {};
  globalThis.document = {
    createElement: (t) => new El(t),
    body: new El('body'),
    activeElement: null,
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter(f => f !== fn); },
  };
  globalThis.window = { __TAURI__: tauri };
  return globalThis.document.body;
}
