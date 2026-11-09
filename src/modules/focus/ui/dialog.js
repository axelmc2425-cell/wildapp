import { h } from './dom.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let seq = 0;

/** Modal dialog. Focus moves in and is trapped; Esc and overlay click close (unless `canClose()` is false); the returned close() always works. */
export function openDialog({ title, body, onClose, canClose } = {}) {
  const opener = document.activeElement;
  const titleId = `fr-dlg-title-${++seq}`;
  const box = h('div', { class: 'fr-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h('h3', { id: titleId, class: 'fr-dialog-title' }, String(title ?? '')), body);
  const overlay = h('div', { class: 'fr-overlay' }, box);
  let closed = false;

  const allowed = () => { try { return canClose ? canClose() !== false : true; } catch { return true; } };
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    try { if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus(); } catch { /* ignore */ }
    try { onClose?.(); } catch { /* ignore */ }
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (allowed()) close(); return; }
    if (e.key !== 'Tab') return;
    const items = [...box.querySelectorAll(FOCUSABLE)].filter(el => !el.hidden && el.offsetParent !== null);
    if (items.length === 0) { e.preventDefault(); box.focus(); return; }
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    if (!box.contains(active)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && (active === first || active === box)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && allowed()) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  const first = box.querySelector('[autofocus], input, select, textarea, button');
  (first || box).focus();
  return { close };
}

/** Yes/no dialog. `onConfirm` runs after the dialog closes. */
export function confirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, onConfirm, onClose }) {
  let dlg;
  const cancel = h('button', { type: 'button', onclick: () => dlg.close() }, cancelLabel);
  const ok = h('button', { type: 'button', class: danger ? 'primary danger' : 'primary', onclick: () => { dlg.close(); onConfirm?.(); } }, confirmLabel);
  const body = h('div', {}, message ? h('p', { class: 'fr-dialog-text' }, message) : null, h('div', { class: 'fr-dialog-actions' }, cancel, ok));
  dlg = openDialog({ title, body, onClose });
  cancel.focus();
  return dlg;
}
