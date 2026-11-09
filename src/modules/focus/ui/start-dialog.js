// "Start a block" dialog: pick lists and a duration. Only Normal strictness exists today.
import { h } from './dom.js';
import { openDialog } from './dialog.js';
import { canStart, resolveMinutes, listSummary, endsAtText } from './start-logic.js';

const PRESETS = [[25, '25 min'], [60, '1 h'], [120, '2 h'], [240, '4 h']];
let seq = 0;

/** Opens the dialog. `onDone` runs after a block was started and the dialog closed. */
export function openStartDialog({ controller, onDone } = {}) {
  const uid = ++seq;
  const lists = controller.state.lists;
  const selected = new Set();
  let preset = 60;
  let busy = false;
  let dlg = null;

  const customInput = h('input', { type: 'text', inputmode: 'numeric', id: `fr-st-custom-${uid}`, class: 'fr-num', autocomplete: 'off', 'aria-describedby': `fr-st-derr-${uid}` });
  const durErr = h('p', { class: 'fr-err', id: `fr-st-derr-${uid}`, role: 'alert', hidden: true });
  const summary = h('p', { class: 'fr-st-summary', role: 'status' });
  const startErr = h('p', { class: 'fr-err', role: 'alert', hidden: true });
  const startBtn = h('button', { type: 'button', class: 'primary' }, 'Start');
  const cancelBtn = h('button', { type: 'button' }, 'Cancel');
  const chipBtns = PRESETS.map(([m, label]) => h('button', { type: 'button', class: 'fr-durchip', 'aria-pressed': 'false', onclick: () => {
    if (busy) return;
    preset = m; customInput.value = ''; refresh();
  } }, label));
  const checks = [];

  function duration() { return resolveMinutes({ preset, custom: customInput.value }); }
  function show(el, msg) { el.textContent = msg || ''; el.hidden = !msg; }
  function refresh() {
    const d = duration();
    const hasCustom = customInput.value.trim() !== '';
    chipBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(!hasCustom && preset === PRESETS[i][0])));
    show(durErr, hasCustom && !d.ok ? d.message : '');
    customInput.setAttribute('aria-invalid', String(hasCustom && !d.ok));
    summary.textContent = d.ok ? endsAtText(Date.now(), d.minutes) : '';
    startBtn.disabled = busy || !canStart({ selectedIds: [...selected], duration: d });
  }
  function setBusy(v) {
    busy = v;
    for (const el of [customInput, cancelBtn, ...chipBtns, ...checks]) el.disabled = v;
    refresh();
  }

  customInput.addEventListener('input', () => { refresh(); });
  customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!startBtn.disabled) go(); } });
  cancelBtn.addEventListener('click', () => dlg.close());

  async function go() {
    if (busy) return;
    const d = duration();
    if (!canStart({ selectedIds: [...selected], duration: d })) return;
    setBusy(true); // synchronously, before the await: a double click cannot start two blocks
    show(startErr, '');
    let res;
    try { res = await controller.startBlock({ listIds: [...selected], minutes: d.minutes }); }
    catch (e) { res = { ok: false, message: `Could not start the block: ${e?.message || e}` }; }
    if (res && res.ok) {
      dlg.close();
      onDone?.();
      // Home re-rendered while the dialog was open, so the opener may be gone: refocus the new Start button.
      if (document.activeElement === document.body || !document.activeElement) {
        document.querySelector('[data-fk="start"]:not([disabled])')?.focus();
      }
      return;
    }
    setBusy(false);
    show(startErr, (res && res.message) || 'Could not start the block.');
    startBtn.focus();
  }
  startBtn.addEventListener('click', go);

  const listsBody = lists.length === 0
    ? h('p', { class: 'fr-muted' }, 'Create a list first.')
    : h('div', { class: 'fr-checks', role: 'group', 'aria-labelledby': `fr-st-what-${uid}` }, lists.map((l) => {
      const box = h('input', { type: 'checkbox', onchange: () => { if (box.checked) selected.add(l.id); else selected.delete(l.id); show(startErr, ''); refresh(); } });
      checks.push(box);
      return h('label', { class: 'fr-checkrow' }, box,
        h('span', { class: 'fr-checktext' }, h('span', { class: 'fr-checkname' }, l.name), h('small', { class: 'fr-muted' }, listSummary(l))));
    }));

  const body = h('div', { class: 'fr-start' },
    h('div', { class: 'fr-field' }, h('span', { class: 'fr-fieldlabel', id: `fr-st-what-${uid}` }, 'What to block'), listsBody),
    h('div', { class: 'fr-field' },
      h('span', { class: 'fr-fieldlabel', id: `fr-st-how-${uid}` }, 'For how long'),
      h('div', { class: 'fr-durrow', role: 'group', 'aria-labelledby': `fr-st-how-${uid}` }, chipBtns,
        h('label', { class: 'fr-customlabel', for: customInput.id }, 'Custom'), customInput, h('span', { class: 'fr-muted' }, 'min')),
      durErr),
    h('div', { class: 'fr-strict' },
      h('div', { class: 'fr-strictopt fr-on' }, 'Normal: you can cancel any time.'),
      h('div', { class: 'fr-strictopt fr-locked', 'aria-disabled': 'true' }, h('strong', {}, '🔒 Locked, coming soon'))),
    summary, startErr,
    h('div', { class: 'fr-dialog-actions' }, cancelBtn, startBtn));
  refresh();
  dlg = openDialog({ title: 'Start a block', body, canClose: () => !busy });
}
