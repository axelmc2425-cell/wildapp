// List editor dialog: name + website and app chip inputs. Validation lives in entry.js / editor-logic.js.
import { h } from './dom.js';
import { openDialog } from './dialog.js';
import { splitPaste, addEntries, canSave, removeLast } from './editor-logic.js';
import { formatClock } from './util.js';

let seq = 0;

/** Opens the editor for a new list (optionally from a preset) or an existing one. */
export function openListEditor({ controller, list, preset, onDone } = {}) {
  const src = list || preset || {};
  const uid = ++seq;
  let state = { sites: [...(src.sites || [])], apps: [...(src.apps || [])] };
  let saving = false;
  let dlg = null;

  const nameInput = h('input', { type: 'text', id: `fr-ed-name-${uid}`, maxlength: '60', autocomplete: 'off', autofocus: true, 'aria-describedby': `fr-ed-name-err-${uid}` });
  nameInput.value = String(src.name || '');
  const nameErr = h('p', { class: 'fr-err', id: `fr-ed-name-err-${uid}`, role: 'alert', hidden: true });
  const itemsErr = h('p', { class: 'fr-err', role: 'alert', hidden: true });
  const saveErrs = h('ul', { class: 'fr-err fr-errlist', role: 'alert', hidden: true });
  const saveBtn = h('button', { type: 'button', class: 'primary' }, 'Save');
  const cancelBtn = h('button', { type: 'button' }, 'Cancel');

  function show(el, msg) { el.textContent = msg || ''; el.hidden = !msg; }
  function refreshSave() { saveBtn.disabled = saving || !canSave({ name: nameInput.value, ...state }); }

  function chipInput(kind, label, hint, placeholder) {
    const key = kind === 'site' ? 'sites' : 'apps';
    const id = `fr-ed-${kind}-${uid}`;
    const input = h('input', { type: 'text', id, autocomplete: 'off', spellcheck: 'false', placeholder, 'aria-describedby': `${id}-hint ${id}-msg` });
    const row = h('div', { class: 'fr-chiprow', role: 'list', 'aria-label': `${label} in this list` });
    const note = h('span', { class: 'fr-ednote', role: 'status' });
    const err = h('p', { class: 'fr-err', role: 'alert', hidden: true });
    const msg = h('div', { id: `${id}-msg`, class: 'fr-msg' }, err, note);

    function renderChips() {
      row.replaceChildren(...state[key].map((value) => h('span', { class: `fr-chip fr-edchip${kind === 'app' ? ' fr-app' : ''}`, role: 'listitem', title: value },
        h('span', { class: 'fr-chip-text' }, value),
        h('button', { type: 'button', class: 'fr-chipx', 'aria-label': `Remove ${value}`, onclick: () => {
          state = { ...state, [key]: state[key].filter(v => v !== value) };
          clearMsgs(); renderAll(); input.focus();
        } }, '×'))));
      row.hidden = state[key].length === 0;
    }
    function clearMsgs() { show(err, ''); note.textContent = ''; }
    function commit(pieces) {
      const res = addEntries(state, kind, pieces);
      state = res.state;
      clearMsgs();
      show(itemsErr, ''); show(saveErrs, '');
      if (res.errors.length) {
        show(err, res.errors.map(e => e.message).filter((m, i, a) => a.indexOf(m) === i).join(' '));
        const failed = res.errors.filter(e => e.value).map(e => e.value);
        input.value = failed.length === 1 ? failed[0] : failed.join(kind === 'site' ? ' ' : ', ');
        // keep the failing text; chips for the good ones are already added
      } else {
        input.value = '';
        note.textContent = res.notes.join(' · ');
      }
      renderAll();
    }
    function addTyped() {
      const raw = input.value;
      if (raw.trim() === '') return;
      commit(/[\r\n,]/.test(raw) ? splitPaste(kind, raw) : [raw.trim()]);
    }
    input.addEventListener('input', clearMsgs);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); addTyped(); }
      else if (e.key === ',') { e.preventDefault(); addTyped(); }
      else if (e.key === 'Backspace' && input.value === '' && state[key].length > 0) {
        e.preventDefault(); state = removeLast(state, kind); clearMsgs(); renderAll();
      }
    });
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (!/[\s,]/.test(text.trim()) && kind === 'site') return; // a single token: let the browser paste it
      if (kind === 'app' && !/[\r\n,]/.test(text)) return;
      e.preventDefault();
      commit(splitPaste(kind, input.value + text));
    });
    const field = h('div', { class: 'fr-field' },
      h('label', { for: id }, label),
      h('p', { class: 'fr-hint', id: `${id}-hint` }, hint),
      input, msg, row);
    return { field, input, renderChips };
  }

  const sites = chipInput('site', 'Websites', 'Add each address you want blocked. www. and m. are included.', 'reddit.com');
  const apps = chipInput('app', 'Apps', "Use the program's file name, like steam.exe.", 'steam.exe');
  function renderAll() { sites.renderChips(); apps.renderChips(); refreshSave(); }

  nameInput.addEventListener('input', () => { show(nameErr, ''); refreshSave(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sites.input.focus(); } });
  cancelBtn.addEventListener('click', () => { if (!saving) dlg.close(); });
  saveBtn.addEventListener('click', async () => {
    if (saving || !canSave({ name: nameInput.value, ...state })) return;
    saving = true; refreshSave();
    show(nameErr, ''); show(itemsErr, ''); show(saveErrs, '');
    let res;
    try { res = await controller.saveList({ id: list?.id, name: nameInput.value, sites: state.sites, apps: state.apps }); }
    catch (e) { res = { ok: false, errors: { name: `Could not save: ${e?.message || e}` } }; }
    saving = false;
    if (res && res.ok) { dlg.close(); onDone?.(); return; }
    const errors = (res && res.errors) || {};
    show(nameErr, Number.isFinite(res?.lockedUntil) ? `That list is part of a locked block until ${formatClock(res.lockedUntil)}.` : errors.name);
    show(itemsErr, errors.items);
    const lines = [...(errors.sites || []), ...(errors.apps || [])].map(e => `${e.value}: ${e.message}`);
    saveErrs.replaceChildren(...lines.map(l => h('li', {}, l)));
    saveErrs.hidden = lines.length === 0;
    if (!res || (!errors.name && !errors.items && lines.length === 0)) show(itemsErr, 'Could not save this list.');
    refreshSave();
  });

  const body = h('div', { class: 'fr-editor' },
    h('div', { class: 'fr-field' }, h('label', { for: nameInput.id }, 'Name'), nameInput, nameErr),
    sites.field, apps.field, itemsErr, saveErrs,
    h('div', { class: 'fr-dialog-actions' }, cancelBtn, saveBtn));
  renderAll();
  dlg = openDialog({ title: list ? 'Edit list' : 'New list', body, canClose: () => !saving });
}
