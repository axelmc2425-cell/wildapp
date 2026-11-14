// "Add limit" / "Edit limit" dialog: name, period, daily or weekly cap, apps and sites, and how strict.
import { h } from './dom.js';
import { openDialog, confirmDialog } from './dialog.js';
import { splitPaste, addEntries, removeLast } from './editor-logic.js';
import { limitBlock } from './limit-list.js';
import { validateLimit, capParts, partsToCap } from '../limit-logic.js';
import { UNLOCK_DELAY_PRESETS_H, resolveDelayHours, lockedWarning } from '../lock-logic.js';
import { hasNative, pickExeFiles } from '../../../shell/native.js';

const HOUR_MS = 3600000;
const DEFAULT_DELAY_H = 24;
const FIELDS = ['name', 'items', 'cap', 'delay', 'form'];
const NUMBERS = 'Enter whole numbers for hours and minutes.';
const FILE_DIALOG_ERROR = 'Could not open the file dialog. You can still type the program name.';
const PARTNER_NOTE = "A locked limit needs a partner who can end it early if you really must. Add your partner's key first.";
let seq = 0;

/**
 * Opens the editor for a new limit (limit null) or an existing one. `deps.onDone(res)` runs after a save or delete.
 * `deps.openUnlockDialog` is the existing unlock dialog; `deps.subscribe` is passed on to it.
 * @returns {{ close: () => void }}
 */
export function openLimitEditor(controller, limit, { onDone, openUnlockDialog, subscribe } = {}) {
  const uid = ++seq;
  const editing = !!limit && limit.id !== undefined && limit.id !== null;
  const src = limit || {};
  let items = { sites: [...(src.sites || [])], apps: [...(src.apps || [])], folders: [] };
  let busy = false;
  let dlg = null;
  const show = (el, msg) => { el.textContent = msg || ''; el.hidden = !msg; };
  const errEls = {};
  const err = (f) => (errEls[f] = h('p', { class: 'fr-err', id: `fr-lm-err-${f}-${uid}`, 'data-err': f, role: 'alert', hidden: true }));
  const showErrors = (errors) => {
    for (const f of FIELDS) if (f !== 'form') show(errEls[f], errors[f]);
    const other = Object.entries(errors).filter(([k]) => !FIELDS.includes(k) || k === 'form').map(([, v]) => v).join(' ');
    show(errEls.form, other);
  };

  // name
  const nameInput = h('input', { type: 'text', id: `fr-lm-name-${uid}`, maxlength: '64', autocomplete: 'off', autofocus: true, 'aria-describedby': `fr-lm-err-name-${uid}` });
  nameInput.value = String(src.name || '');
  nameInput.addEventListener('input', () => show(errEls.name, ''));

  // period
  const periodName = `fr-lm-period-${uid}`;
  const dailyRadio = h('input', { type: 'radio', name: periodName, value: 'daily' });
  const weeklyRadio = h('input', { type: 'radio', name: periodName, value: 'weekly' });
  dailyRadio.checked = src.period !== 'weekly'; weeklyRadio.checked = src.period === 'weekly';
  for (const r of [dailyRadio, weeklyRadio]) r.addEventListener('change', () => show(errEls.cap, ''));

  // cap
  const parts = capParts(Number.isFinite(src.capSecs) ? src.capSecs : 3600);
  const hoursInput = h('input', { type: 'text', inputmode: 'numeric', id: `fr-lm-hours-${uid}`, 'data-field': 'hours', class: 'fr-num', autocomplete: 'off', 'aria-describedby': `fr-lm-err-cap-${uid}` });
  const minutesInput = h('input', { type: 'text', inputmode: 'numeric', id: `fr-lm-minutes-${uid}`, 'data-field': 'minutes', class: 'fr-num', autocomplete: 'off', 'aria-describedby': `fr-lm-err-cap-${uid}` });
  hoursInput.value = String(parts.hours); minutesInput.value = String(parts.minutes);
  for (const i of [hoursInput, minutesInput]) i.addEventListener('input', () => show(errEls.cap, ''));

  // apps and sites
  function chipInput(kind, label, hint, placeholder, browse) {
    const key = kind === 'site' ? 'sites' : 'apps';
    const id = `fr-lm-${kind}-${uid}`;
    const input = h('input', { type: 'text', id, 'data-field': kind, autocomplete: 'off', spellcheck: 'false', placeholder, 'aria-describedby': `${id}-hint ${id}-msg` });
    const row = h('div', { class: 'fr-chiprow', role: 'list', 'aria-label': `${label} in this limit` });
    const note = h('span', { class: 'fr-ednote', role: 'status' });
    const errEl = h('p', { class: 'fr-err', role: 'alert', hidden: true });
    const msg = h('div', { id: `${id}-msg`, class: 'fr-msg' }, errEl, note);
    const clear = () => { show(errEl, ''); note.textContent = ''; };
    function renderChips() {
      row.replaceChildren(...items[key].map((value) => h('span', { class: `fr-chip fr-edchip${kind === 'app' ? ' fr-app' : ''}`, role: 'listitem', title: value },
        h('span', { class: 'fr-chip-text' }, value),
        h('button', { type: 'button', class: 'fr-chipx', 'aria-label': `Remove ${value}`, onclick: () => {
          items = { ...items, [key]: items[key].filter((v) => v !== value) };
          clear(); renderChips(); input.focus();
        } }, '×'))));
      row.hidden = items[key].length === 0;
    }
    function commit(pieces, keepInput) {
      const res = addEntries(items, kind, pieces);
      items = res.state;
      clear(); show(errEls.items, '');
      if (res.errors.length) {
        show(errEl, res.errors.map((e) => e.message).filter((m, i, a) => a.indexOf(m) === i).join(' '));
        const failed = res.errors.filter((e) => e.value).map((e) => e.value);
        if (!keepInput) input.value = failed.length === 1 ? failed[0] : failed.join(kind === 'site' ? ' ' : ', ');
      } else {
        if (!keepInput) input.value = '';
        note.textContent = res.notes.join(' · ');
      }
      renderChips();
      return res.errors.length === 0;
    }
    function addTyped() {
      const raw = input.value;
      if (raw.trim() === '') return true;
      return commit(/[\r\n,]/.test(raw) ? splitPaste(kind, raw) : [raw.trim()]);
    }
    input.addEventListener('input', clear);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTyped(); }
      else if (e.key === 'Backspace' && input.value === '' && items[key].length > 0) {
        e.preventDefault(); items = removeLast(items, kind); clear(); renderChips();
      }
    });
    let inputEl = input;
    if (browse) {
      const btn = h('button', { type: 'button', class: 'fr-browse', onclick: async () => {
        let paths;
        try { paths = await browse(); } catch { clear(); show(errEl, FILE_DIALOG_ERROR); return; }
        if (!paths || paths.length === 0) return;
        commit(paths, true);
      } }, 'Browse files…');
      inputEl = h('div', { class: 'fr-inputrow' }, input, btn);
    }
    const field = h('div', { class: 'fr-field' }, h('label', { for: id }, label), h('p', { class: 'fr-hint', id: `${id}-hint` }, hint), inputEl, msg, row);
    return { field, input, renderChips, addTyped };
  }
  const sites = chipInput('site', 'Websites', 'Add each address to limit. www. and m. are included.', 'reddit.com');
  const apps = chipInput('app', 'Apps', "Use the program's file name, like steam.exe.", 'steam.exe', hasNative() ? () => pickExeFiles('Choose programs to limit') : null);

  // strictness
  const modeName = `fr-lm-mode-${uid}`;
  const normalRadio = h('input', { type: 'radio', name: modeName, value: 'none' });
  const lockedRadio = h('input', { type: 'radio', name: modeName, value: 'locked' });
  normalRadio.checked = src.lock !== 'locked'; lockedRadio.checked = src.lock === 'locked';
  const hours0 = Number.isFinite(src.unlockDelayMs) ? src.unlockDelayMs / HOUR_MS : DEFAULT_DELAY_H;
  const isPreset = UNLOCK_DELAY_PRESETS_H.includes(hours0);
  let delayPreset = isPreset ? hours0 : DEFAULT_DELAY_H;
  const delayInput = h('input', { type: 'text', inputmode: 'numeric', id: `fr-lm-delay-${uid}`, 'data-field': 'delay', class: 'fr-num', autocomplete: 'off', 'aria-describedby': `fr-lm-err-delay-${uid}` });
  delayInput.value = !isPreset && Number.isInteger(hours0) && hours0 >= 1 ? String(hours0) : '';
  const delayChips = UNLOCK_DELAY_PRESETS_H.map((hrs) => h('button', {
    type: 'button', class: 'fr-delaychip', 'aria-pressed': 'false',
    onclick: () => { delayPreset = hrs; delayInput.value = ''; show(errEls.delay, ''); refresh(); },
  }, `${hrs} h`));
  delayInput.addEventListener('input', () => { show(errEls.delay, ''); refresh(); });
  const warnText = h('p', { class: 'fr-lockwarn-text fr-muted fr-small' });
  const partnerNote = h('p', { class: 'fr-st-lockmsg fr-muted', hidden: true }, PARTNER_NOTE);
  const lockedOpts = h('div', { class: 'fr-st-lockedopts', hidden: true },
    h('div', { class: 'fr-field' },
      h('span', { class: 'fr-fieldlabel', id: `fr-lm-wait-${uid}` }, 'Waiting period if you change your mind'),
      h('div', { class: 'fr-durrow', role: 'group', 'aria-labelledby': `fr-lm-wait-${uid}` }, delayChips,
        h('span', { class: 'fr-customgroup' }, h('label', { class: 'fr-customlabel', for: delayInput.id }, 'Custom'), delayInput, h('span', { class: 'fr-muted' }, 'hours'))),
      err('delay')),
    warnText, partnerNote);
  for (const r of [normalRadio, lockedRadio]) r.addEventListener('change', () => { if (r.checked) refresh(); });
  const isLocked = () => lockedRadio.checked;
  const delay = () => resolveDelayHours({ preset: delayPreset, custom: delayInput.value });

  const saveBtn = h('button', { type: 'button', class: 'primary' }, 'Save');
  const cancelBtn = h('button', { type: 'button' }, 'Cancel');
  const deleteBtn = editing ? h('button', { type: 'button', class: 'danger' }, 'Delete') : null;
  cancelBtn.addEventListener('click', () => { if (!busy) dlg.close(); });

  function refresh() {
    const lk = isLocked();
    lockedOpts.hidden = !lk;
    const hasCustom = delayInput.value.trim() !== '';
    delayChips.forEach((b, i) => b.setAttribute('aria-pressed', String(!hasCustom && delayPreset === UNLOCK_DELAY_PRESETS_H[i])));
    delayInput.setAttribute('aria-invalid', String(hasCustom && !delay().ok));
    const d = delay();
    warnText.textContent = lockedWarning(d.ok ? d.hours : delayPreset);
    const partnerSet = controller.state?.partner?.set;
    partnerNote.hidden = !(lk && partnerSet === false);
    saveBtn.disabled = busy; cancelBtn.disabled = busy;
    if (deleteBtn) deleteBtn.disabled = busy;
  }

  const unlockFor = (res) => {
    const row = (controller.state?.limitsState?.limits || []).find((l) => l.id === res.limitId) || limit;
    if (typeof openUnlockDialog !== 'function' || !row) {
      show(errEls.form, 'This limit is locked. Unlock it first, from the Time limits list.');
      return;
    }
    show(errEls.form, 'This limit is locked. Unlock it first to make it weaker or remove it. Nothing was changed.');
    openUnlockDialog({
      controller, block: limitBlock(row), subscribe,
      onDone: () => { dlg.close(); onDone?.({ ok: true, unlocked: true }); },
    });
  };

  async function save() {
    if (busy) return;
    const okA = sites.addTyped(); const okB = apps.addTyped();
    if (!okA || !okB) return;
    const errors = {};
    let cap = 0;
    const hs = hoursInput.value.trim(); const ms = minutesInput.value.trim();
    if (!/^\d*$/.test(hs) || !/^\d*$/.test(ms)) errors.cap = NUMBERS;
    else cap = partsToCap({ hours: hs, minutes: ms });
    const d = delay();
    const lk = isLocked();
    const input = {
      name: nameInput.value.trim(), period: weeklyRadio.checked ? 'weekly' : 'daily', capSecs: cap,
      lock: lk ? 'locked' : 'none', unlockDelayMs: lk && d.ok ? d.hours * HOUR_MS : null,
      apps: items.apps, sites: items.sites,
    };
    const v = validateLimit(input);
    if (!v.ok) Object.assign(errors, { ...v.errors }, errors.cap ? { cap: errors.cap } : {});
    if (lk && !d.ok) errors.delay = d.message;
    showErrors(errors);
    if (Object.keys(errors).length) {
      const first = FIELDS.find((f) => errors[f]);
      ({ name: nameInput, items: sites.input, cap: hoursInput, delay: delayInput }[first])?.focus();
      return;
    }
    if (editing) input.id = limit.id;
    busy = true; refresh();
    let res;
    try { res = await controller.saveLimit(input); }
    catch (e) { res = { ok: false, errors: { form: `Could not save: ${e?.message || e}` } }; }
    busy = false; refresh();
    if (res && res.ok) { dlg.close(); onDone?.(res); return; }
    if (res && res.needsUnlock) { unlockFor(res); return; }
    showErrors((res && res.errors) || { form: (res && res.message) || 'Could not save the limit.' });
    saveBtn.focus();
  }
  saveBtn.addEventListener('click', save);

  deleteBtn?.addEventListener('click', () => {
    if (busy) return;
    confirmDialog({
      title: 'Delete this limit?', message: `“${limit.name}” will be removed.`, confirmLabel: 'Delete', danger: true,
      onConfirm: async () => {
        busy = true; refresh();
        let res;
        try { res = await controller.deleteLimit(limit.id); }
        catch (e) { res = { ok: false, message: `Could not delete: ${e?.message || e}` }; }
        busy = false; refresh();
        if (res && res.ok) { dlg.close(); onDone?.(res); return; }
        if (res && res.needsUnlock) { unlockFor(res); return; }
        show(errEls.form, (res && res.message) || 'Could not delete the limit.');
      },
    });
  });

  const body = h('div', { class: 'fr-start fr-limit-editor' },
    h('div', { class: 'fr-field' }, h('label', { for: nameInput.id }, 'Name'), nameInput, err('name')),
    h('div', { class: 'fr-field' },
      h('span', { class: 'fr-fieldlabel', id: `fr-lm-per-${uid}` }, 'How often it resets'),
      h('div', { class: 'fr-modes', role: 'radiogroup', 'aria-labelledby': `fr-lm-per-${uid}` },
        h('label', { class: 'fr-moderow' }, dailyRadio, h('span', { class: 'fr-modetext' }, h('strong', {}, 'Daily'), h('small', { class: 'fr-muted' }, 'A fresh allowance every day.'))),
        h('label', { class: 'fr-moderow' }, weeklyRadio, h('span', { class: 'fr-modetext' }, h('strong', {}, 'Weekly'), h('small', { class: 'fr-muted' }, 'One allowance for the whole week.'))))),
    h('div', { class: 'fr-field' },
      h('span', { class: 'fr-fieldlabel', id: `fr-lm-cap-${uid}` }, 'Time allowed'),
      h('div', { class: 'fr-durrow', role: 'group', 'aria-labelledby': `fr-lm-cap-${uid}` },
        h('label', { class: 'fr-customlabel', for: hoursInput.id }, 'Hours'), hoursInput,
        h('label', { class: 'fr-customlabel', for: minutesInput.id }, 'Minutes'), minutesInput),
      err('cap')),
    sites.field, apps.field, err('items'),
    h('div', { class: 'fr-field' },
      h('span', { class: 'fr-fieldlabel', id: `fr-lm-strict-${uid}` }, 'How strict'),
      h('div', { class: 'fr-modes', role: 'radiogroup', 'aria-labelledby': `fr-lm-strict-${uid}` },
        h('label', { class: 'fr-moderow' }, normalRadio, h('span', { class: 'fr-modetext' }, h('strong', {}, 'Normal'), h('small', { class: 'fr-muted' }, 'You can pause or delete it any time.'))),
        h('label', { class: 'fr-moderow' }, lockedRadio, h('span', { class: 'fr-modetext' }, h('strong', {}, 'Locked'), h('small', { class: 'fr-muted' }, 'You cannot make it weaker or remove it without a partner or a wait.')))),
      lockedOpts),
    err('form'),
    h('div', { class: 'fr-dialog-actions' }, deleteBtn, cancelBtn, saveBtn));
  sites.renderChips(); apps.renderChips(); refresh();
  dlg = openDialog({ title: editing ? 'Edit limit' : 'Add limit', body, canClose: () => !busy });
  return { close: () => dlg.close() };
}
