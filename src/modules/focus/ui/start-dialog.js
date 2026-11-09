// "Start a block" dialog: pick lists, a duration and a strictness (Normal or Locked).
import { h } from './dom.js';
import { openDialog } from './dialog.js';
import { canStart, resolveMinutes, listSummary, endsAtText } from './start-logic.js';
import {
  UNLOCK_DELAY_PRESETS_H, LOCKED_DURATION_PRESETS, resolveDelayHours, resolveLockedMinutes,
  lockedWarning, lockedSpanText, canStartLocked,
} from '../lock-logic.js';

const PRESETS = [[25, '25 min'], [60, '1 h'], [120, '2 h'], [240, '4 h']];
export const HELPER_REQUIRED = 'The helper must be running to lock a block.';
let seq = 0;

/**
 * Opens the dialog. `onDone(result)` runs after a block was started and the dialog closed; a result
 * message (e.g. "couldn't confirm the lock") is for the home view to show in its notes area.
 * `openPartnerSetup` and `subscribe` are optional wiring from home.
 */
export function openStartDialog({ controller, onDone, openPartnerSetup, subscribe } = {}) {
  const uid = ++seq;
  const lists = controller.state.lists;
  const selected = new Set();
  let preset = 60;
  let mode = 'normal';
  let delayPreset = 24;
  let busy = false;
  let dlg = null;
  let unsub = () => {};

  const customInput = h('input', { type: 'text', inputmode: 'numeric', id: `fr-st-custom-${uid}`, class: 'fr-num', autocomplete: 'off', 'aria-describedby': `fr-st-derr-${uid}` });
  const durErr = h('p', { class: 'fr-err', id: `fr-st-derr-${uid}`, role: 'alert', hidden: true });
  const summary = h('p', { class: 'fr-st-summary', role: 'status' });
  const startErr = h('p', { class: 'fr-err', role: 'alert', hidden: true });
  const startBtn = h('button', { type: 'button', class: 'primary' }, 'Start');
  const cancelBtn = h('button', { type: 'button' }, 'Cancel');
  const longChips = [];
  const chipBtns = LOCKED_DURATION_PRESETS.map(([m, label], i) => {
    const b = h('button', { type: 'button', class: 'fr-durchip', 'aria-pressed': 'false', onclick: () => {
      if (busy) return;
      preset = m; customInput.value = ''; refresh();
    } }, label);
    if (i >= PRESETS.length) longChips.push(b);
    return b;
  });
  const checks = [];

  // ---- strictness ----
  const modeName = `fr-st-mode-${uid}`;
  const normalRadio = h('input', { type: 'radio', name: modeName, value: 'normal', checked: true });
  const lockedRadio = h('input', { type: 'radio', name: modeName, value: 'locked', 'aria-describedby': `fr-st-lockmsg-${uid}` });
  const radios = [normalRadio, lockedRadio];
  for (const r of radios) r.addEventListener('change', () => { if (r.checked) { mode = r.value; confirmBox.checked = false; show(startErr, ''); refresh(); } });
  const lockMsg = h('p', { class: 'fr-st-lockmsg fr-muted', id: `fr-st-lockmsg-${uid}`, hidden: true });
  const setupBtn = h('button', { type: 'button', onclick: () => {
    if (busy || typeof openPartnerSetup !== 'function') return;
    openPartnerSetup({ controller, onDone: (res) => {
      refresh();
      // The setup dialog gave focus back to this (now hidden) button: move it to the first locked control.
      const next = !lockedOpts.hidden ? confirmBox : lockedRadio;
      if (next && !next.disabled) next.focus();
    } });
  } }, 'Set up your partner first');
  const partnerBox = h('div', { class: 'fr-st-partner', hidden: true },
    h('p', { class: 'fr-muted' }, "A locked block needs a partner who can end it early if you really must. Set one up first."), setupBtn);

  const delayChips = UNLOCK_DELAY_PRESETS_H.map((hrs) => h('button', { type: 'button', class: 'fr-delaychip', 'aria-pressed': 'false', onclick: () => {
    if (busy) return;
    delayPreset = hrs; delayInput.value = ''; onDelayChanged();
  } }, `${hrs} h`));
  const delayInput = h('input', { type: 'text', inputmode: 'numeric', id: `fr-st-delay-${uid}`, class: 'fr-num', autocomplete: 'off', 'aria-describedby': `fr-st-delayerr-${uid}` });
  delayInput.addEventListener('input', onDelayChanged);
  const delayErr = h('p', { class: 'fr-err', id: `fr-st-delayerr-${uid}`, role: 'alert', hidden: true });
  const warnText = h('span', { class: 'fr-lockwarn-text' });
  const confirmBox = h('input', { type: 'checkbox', id: `fr-st-confirm-${uid}`, onchange: () => { show(startErr, ''); refresh(); } });
  const lockedOpts = h('div', { class: 'fr-st-lockedopts', hidden: true },
    h('div', { class: 'fr-field' },
      h('span', { class: 'fr-fieldlabel', id: `fr-st-wait-${uid}` }, 'Waiting period if you change your mind'),
      h('div', { class: 'fr-durrow', role: 'group', 'aria-labelledby': `fr-st-wait-${uid}` }, delayChips,
        h('span', { class: 'fr-customgroup' }, h('label', { class: 'fr-customlabel', for: delayInput.id }, 'Custom'), delayInput, h('span', { class: 'fr-muted' }, 'hours'))),
      delayErr),
    h('label', { class: 'fr-lockwarn', for: confirmBox.id }, confirmBox, warnText));
  const strictBody = h('div', { class: 'fr-strict' },
    h('div', { class: 'fr-modes', role: 'radiogroup', 'aria-labelledby': `fr-st-strict-${uid}` },
      h('label', { class: 'fr-moderow' }, normalRadio,
        h('span', { class: 'fr-modetext' }, h('strong', {}, 'Normal'), h('small', { class: 'fr-muted' }, 'You can cancel any time.'))),
      h('label', { class: 'fr-moderow' }, lockedRadio,
        h('span', { class: 'fr-modetext' }, h('strong', {}, 'Locked'), h('small', { class: 'fr-muted' }, 'You cannot cancel it yourself.')))),
    lockMsg, partnerBox, lockedOpts);

  function locked() { return mode === 'locked'; }
  function helperOk() { return controller.state.helper?.kind === 'ok'; }
  function partnerSet() { return controller.state.partner?.set === true; }
  function delay() { return resolveDelayHours({ preset: delayPreset, custom: delayInput.value }); }
  function duration() {
    return locked() ? resolveLockedMinutes({ preset, custom: customInput.value }) : resolveMinutes({ preset, custom: customInput.value });
  }
  function show(el, msg) { el.textContent = msg || ''; el.hidden = !msg; }
  function ready() {
    if (locked()) {
      return helperOk() && partnerSet()
        && canStartLocked({ selectedIds: [...selected], duration: duration(), delay: delay(), confirmed: confirmBox.checked });
    }
    return canStart({ selectedIds: [...selected], duration: duration() });
  }
  function onDelayChanged() {
    confirmBox.checked = false; // the warning text names the period: confirm again after changing it
    show(startErr, ''); refresh();
  }
  function refresh() {
    // The helper can drop out while the dialog is open: fall back to Normal rather than leave Locked selected.
    const ok = helperOk();
    lockedRadio.disabled = busy || !ok;
    if (!ok && mode === 'locked') { mode = 'normal'; normalRadio.checked = true; confirmBox.checked = false; }
    lockedRadio.checked = locked();
    normalRadio.checked = !locked();
    const lk = locked();
    lockMsg.hidden = ok;
    lockMsg.textContent = ok ? '' : HELPER_REQUIRED;
    partnerBox.hidden = !(lk && ok && !partnerSet());
    setupBtn.hidden = typeof openPartnerSetup !== 'function';
    setupBtn.disabled = busy;
    lockedOpts.hidden = !(lk && ok && partnerSet());
    for (const b of longChips) b.hidden = !lk;
    if (!lk && preset > PRESETS[PRESETS.length - 1][0]) preset = 60;
    const d = duration();
    const hasCustom = customInput.value.trim() !== '';
    chipBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(!hasCustom && preset === LOCKED_DURATION_PRESETS[i][0])));
    show(durErr, hasCustom && !d.ok ? d.message : '');
    customInput.setAttribute('aria-invalid', String(hasCustom && !d.ok));
    const dl = delay();
    const hasDelay = delayInput.value.trim() !== '';
    delayChips.forEach((b, i) => b.setAttribute('aria-pressed', String(!hasDelay && delayPreset === UNLOCK_DELAY_PRESETS_H[i])));
    show(delayErr, hasDelay && !dl.ok ? dl.message : '');
    delayInput.setAttribute('aria-invalid', String(hasDelay && !dl.ok));
    warnText.textContent = lockedWarning(dl.ok ? dl.hours : delayPreset);
    summary.textContent = !d.ok ? '' : lk ? lockedSpanText(d.minutes) : endsAtText(Date.now(), d.minutes);
    startBtn.textContent = lk ? 'Lock it' : 'Start';
    startBtn.disabled = busy || !ready();
  }
  function setBusy(v) {
    busy = v;
    for (const el of [customInput, delayInput, confirmBox, cancelBtn, ...chipBtns, ...delayChips, ...checks, normalRadio]) el.disabled = v;
    refresh();
  }

  customInput.addEventListener('input', () => { refresh(); });
  const enter = (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!startBtn.disabled) go(); } };
  customInput.addEventListener('keydown', enter);
  delayInput.addEventListener('keydown', enter);
  cancelBtn.addEventListener('click', () => dlg.close());

  async function go() {
    if (busy) return;
    if (!ready()) return;
    const d = duration();
    const wasLocked = locked();
    const hrs = delay();
    setBusy(true); // synchronously, before the await: a double click cannot start two blocks
    show(startErr, '');
    let res;
    try {
      res = wasLocked
        ? await controller.startLockedBlock({ listIds: [...selected], minutes: d.minutes, delayHours: hrs.hours })
        : await controller.startBlock({ listIds: [...selected], minutes: d.minutes });
    } catch (e) { res = { ok: false, message: `Could not start the block: ${e?.message || e}` }; }
    if (res && res.ok) {
      dlg.close();
      onDone?.(res);
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
        h('span', { class: 'fr-customgroup' }, h('label', { class: 'fr-customlabel', for: customInput.id }, 'Custom'), customInput, h('span', { class: 'fr-muted' }, 'min'))),
      durErr),
    h('div', { class: 'fr-field' }, h('span', { class: 'fr-fieldlabel', id: `fr-st-strict-${uid}` }, 'How strict'), strictBody),
    summary, startErr,
    h('div', { class: 'fr-dialog-actions' }, cancelBtn, startBtn));
  refresh();
  dlg = openDialog({ title: 'Start a block', body, canClose: () => !busy, onClose: () => unsub() });
  // Helper and partner state change under an open dialog (status poll, partner setup).
  if (typeof subscribe === 'function') { try { unsub = subscribe(() => { if (!busy) refresh(); }) || (() => {}); } catch { /* ignore */ } }
}
