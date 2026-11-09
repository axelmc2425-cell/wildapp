// Partner setup dialog: save the offline partner page, then paste the partner's name and public key.
import { h } from './dom.js';
import { openDialog } from './dialog.js';
import { buildPartnerPage } from '../partner-page.js';

let seq = 0;

function downloadPartnerPage() {
  const blob = new Blob([buildPartnerPage()], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: 'partner-unlock.html' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Opens the dialog. `onDone` runs after the partner was saved and the dialog closed. */
export function openPartnerSetup({ controller, onDone } = {}) {
  const uid = ++seq;
  let saving = false;
  let dlg = null;

  const nameInput = h('input', { type: 'text', id: `fr-ps-name-${uid}`, maxlength: '60', autocomplete: 'off' });
  const keyInput = h('textarea', { id: `fr-ps-key-${uid}`, rows: '3', spellcheck: 'false', autocomplete: 'off', class: 'fr-ps-key' });
  const err = h('p', { class: 'fr-err', role: 'alert', hidden: true });
  const saveBtn = h('button', { type: 'button', class: 'primary' }, 'Save partner');
  const cancelBtn = h('button', { type: 'button' }, 'Cancel');
  const pageBtn = h('button', { type: 'button', onclick: () => { downloadPartnerPage(); } }, 'Save the partner page');
  const saved = controller.state.partner?.set ? controller.state.partner.name : null;

  function show(msg) { err.textContent = msg || ''; err.hidden = !msg; }
  function refresh() { saveBtn.disabled = saving || nameInput.value.trim() === '' || keyInput.value.trim() === ''; }
  for (const el of [nameInput, keyInput]) el.addEventListener('input', () => { show(''); refresh(); });

  async function go() {
    if (saving || saveBtn.disabled) return;
    saving = true;
    for (const el of [nameInput, keyInput, cancelBtn, pageBtn]) el.disabled = true;
    saveBtn.disabled = true;
    show('');
    let res;
    try { res = await controller.setPartner({ publicKey: keyInput.value.trim(), name: nameInput.value.trim() }); }
    catch (e) { res = { ok: false, message: `Could not save the partner: ${e?.message || e}` }; }
    saving = false;
    if (res && res.ok) {
      dlg.close();
      onDone?.(res);
      return;
    }
    for (const el of [nameInput, keyInput, cancelBtn, pageBtn]) el.disabled = false;
    show((res && res.message) || 'Could not save the partner.');
    refresh();
    keyInput.focus();
  }
  saveBtn.addEventListener('click', go);
  cancelBtn.addEventListener('click', () => dlg.close());

  const body = h('div', { class: 'fr-start fr-ps' },
    saved ? h('p', { class: 'fr-muted' }, `Current partner: ${saved}. Saving replaces them.`) : null,
    h('ol', { class: 'fr-steps' },
      h('li', {},
        h('div', { class: 'fr-step-title' }, 'Get the partner page'),
        h('p', { class: 'fr-muted' }, 'Save this page and send it to your partner. It works offline.'),
        pageBtn),
      h('li', {},
        h('div', { class: 'fr-step-title' }, 'Your partner creates a key'),
        h('p', { class: 'fr-muted' }, 'Ask your partner to open the page, create a key there, and send you the public key. They keep the private key.')),
      h('li', {},
        h('div', { class: 'fr-step-title' }, 'Paste what they sent'),
        h('div', { class: 'fr-field' }, h('label', { class: 'fr-fieldlabel', for: nameInput.id }, "Partner's name"), nameInput),
        h('div', { class: 'fr-field' }, h('label', { class: 'fr-fieldlabel', for: keyInput.id }, "Partner's public key"), keyInput))),
    err,
    h('div', { class: 'fr-dialog-actions' }, cancelBtn, saveBtn));
  refresh();
  dlg = openDialog({ title: 'Set up your partner', body, canClose: () => !saving });
  nameInput.focus();
  return { close: () => dlg.close() };
}
