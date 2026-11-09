// "Unlock early" dialog for a locked block: ask the partner for a signed token, or wait out the delay.
import { h } from './dom.js';
import { openDialog } from './dialog.js';
import { formatClock } from './util.js';
import { describeUnlockError, pendingUnlockFor, windowIdForBlock, waitLengthText } from '../lock-logic.js';

let seq = 0;

/**
 * Opens the dialog. `onDone(result)` runs after the partner's token ended the lock and the dialog closed.
 * `subscribe` (optional) keeps the dialog in step with the helper status; `onClose` runs on every close.
 * @returns {{ close: () => void }}
 */
export function openUnlockDialog({ controller, block, onDone, subscribe, onClose } = {}) {
  const uid = ++seq;
  const windowId = windowIdForBlock(block);
  let busy = false;
  let dlg = null;
  let unsub = () => {};
  let code = null;
  let pendingAt = pendingFromState();

  function pendingFromState() {
    const helper = controller.state.helper;
    return helper && helper.kind === 'ok' ? pendingUnlockFor(helper.status, windowId) : null;
  }
  const partnerName = controller.state.partner?.name || null;

  // ---- ask my partner ----
  const getBtn = h('button', { type: 'button', 'data-fk': 'un-getcode' }, 'Get a code');
  const codeBox = h('textarea', { readonly: true, rows: '3', id: `fr-un-code-${uid}`, class: 'fr-un-code', spellcheck: 'false', autocomplete: 'off' });
  const copyBtn = h('button', { type: 'button', 'data-fk': 'un-copy' }, 'Copy');
  const copyMsg = h('span', { class: 'fr-muted fr-small fr-un-copymsg', role: 'status' });
  const tokenInput = h('input', { type: 'text', id: `fr-un-token-${uid}`, class: 'fr-un-token', spellcheck: 'false', autocomplete: 'off', 'aria-describedby': `fr-un-err-${uid}` });
  const submitBtn = h('button', { type: 'button', class: 'primary', 'data-fk': 'un-submit' }, 'Submit');
  const askErr = h('p', { class: 'fr-err', id: `fr-un-err-${uid}`, role: 'alert', hidden: true });
  const codeArea = h('div', { class: 'fr-un-codearea', hidden: true },
    h('label', { class: 'fr-fieldlabel', for: codeBox.id }, partnerName ? `Send this code to ${partnerName}` : 'Send this code to your partner'),
    h('div', { class: 'fr-un-coderow' }, codeBox, copyBtn),
    copyMsg,
    h('div', { class: 'fr-field' },
      h('label', { class: 'fr-fieldlabel', for: tokenInput.id }, "Partner's signed token"),
      tokenInput),
    h('div', { class: 'fr-actions' }, submitBtn));

  // ---- wait it out ----
  const startWaitBtn = h('button', { type: 'button', 'data-fk': 'un-startwait' }, 'Start waiting');
  const cancelWaitBtn = h('button', { type: 'button', 'data-fk': 'un-cancelwait' }, 'Cancel request');
  const waitStatus = h('p', { class: 'fr-un-waitat', role: 'status' });
  const waitErr = h('p', { class: 'fr-err', role: 'alert', hidden: true });
  const closeBtn = h('button', { type: 'button', 'data-fk': 'un-close' }, 'Close');

  function show(el, msg) { el.textContent = msg || ''; el.hidden = !msg; }

  function refresh() {
    codeArea.hidden = !code;
    getBtn.textContent = code ? 'Get a new code' : 'Get a code';
    getBtn.disabled = busy;
    copyBtn.disabled = busy;
    tokenInput.disabled = busy;
    submitBtn.disabled = busy || tokenInput.value.trim() === '';
    const waiting = pendingAt != null;
    startWaitBtn.hidden = waiting;
    cancelWaitBtn.hidden = !waiting;
    startWaitBtn.disabled = busy;
    cancelWaitBtn.disabled = busy;
    waitStatus.hidden = !waiting;
    waitStatus.textContent = waiting ? `Unlocks at ${formatClock(pendingAt)}` : '';
    closeBtn.disabled = busy;
  }

  // Marks the request pending synchronously (a double click cannot send two), runs it, settles.
  async function run(call, errEl) {
    if (busy) return null;
    busy = true;
    refresh();
    show(askErr, ''); show(waitErr, '');
    let res;
    try { res = await call(); } catch (e) { res = { ok: false, message: describeUnlockError(e) }; }
    busy = false;
    if (!res || res.ok !== true) show(errEl, (res && res.message) || describeUnlockError(res));
    refresh();
    return res;
  }

  getBtn.addEventListener('click', async () => {
    const res = await run(() => controller.requestPartnerChallenge(block.key), askErr);
    if (res && res.ok) {
      code = res.code;
      codeBox.value = code;
      copyMsg.textContent = '';
      refresh();
      tokenInput.focus();
    }
  });
  copyBtn.addEventListener('click', async () => {
    let done = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(codeBox.value);
        done = true;
      }
    } catch { /* fall back to selecting the text */ }
    if (done) { copyMsg.textContent = 'Copied.'; return; }
    try { codeBox.focus(); codeBox.select(); } catch { /* ignore */ }
    copyMsg.textContent = "Couldn't copy automatically. The code is selected: copy it yourself.";
  });
  tokenInput.addEventListener('input', () => { show(askErr, ''); refresh(); });
  const submit = async () => {
    if (busy || submitBtn.disabled) return;
    const res = await run(() => controller.submitPartnerToken(block.key, tokenInput.value), askErr);
    if (res && res.ok) {
      dlg.close();
      onDone?.(res);
      return;
    }
    if (tokenInput.isConnected) tokenInput.focus();
  };
  submitBtn.addEventListener('click', submit);
  tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

  startWaitBtn.addEventListener('click', async () => {
    const res = await run(() => controller.startDelayedUnlock(block.key), waitErr);
    if (res && res.ok) { pendingAt = res.unlockAt; refresh(); cancelWaitBtn.focus(); }
  });
  cancelWaitBtn.addEventListener('click', async () => {
    const res = await run(() => controller.cancelDelayedUnlock(block.key), waitErr);
    if (res && res.ok) { pendingAt = null; refresh(); startWaitBtn.focus(); }
  });
  closeBtn.addEventListener('click', () => { if (!busy) dlg.close(); });

  const intro = partnerName
    ? `Ask ${partnerName} to sign a code, or wait out the waiting period.`
    : 'Ask your partner to sign a code, or wait out the waiting period.';
  const body = h('div', { class: 'fr-un' },
    h('p', { class: 'fr-muted fr-un-intro' }, intro),
    h('section', { class: 'fr-un-opt', 'aria-labelledby': `fr-un-h1-${uid}` },
      h('h4', { class: 'fr-un-title', id: `fr-un-h1-${uid}` }, 'Ask my partner'),
      h('p', { class: 'fr-un-text' }, 'Get a code, send it to your partner, and paste back the signed token they send you.'),
      h('div', { class: 'fr-actions' }, getBtn),
      codeArea,
      askErr),
    h('section', { class: 'fr-un-opt', 'aria-labelledby': `fr-un-h2-${uid}` },
      h('h4', { class: 'fr-un-title', id: `fr-un-h2-${uid}` }, 'Wait it out'),
      h('p', { class: 'fr-un-text' }, `The lock ends by itself ${waitLengthText(block.unlockDelayMs)} after you start waiting, unless you cancel the request.`),
      waitStatus,
      h('div', { class: 'fr-actions' }, startWaitBtn, cancelWaitBtn),
      waitErr),
    h('div', { class: 'fr-dialog-actions' }, closeBtn));
  refresh();

  dlg = openDialog({
    title: 'Unlock early',
    body,
    canClose: () => !busy,
    onClose: () => { unsub(); try { onClose?.(); } catch { /* ignore */ } },
  });
  // The helper's pending list changes under an open dialog; a block that ended makes it pointless.
  if (typeof subscribe === 'function') {
    try {
      unsub = subscribe(() => {
        if (busy) return;
        const st = controller.state;
        if (!st.blocks.some((b) => b.key === block.key && b.lock === 'locked')) { dlg.close(); return; }
        if (st.helper && st.helper.kind === 'ok') { pendingAt = pendingFromState(); refresh(); }
      }) || (() => {});
    } catch { /* ignore */ }
  }
  return { close: () => dlg.close() };
}
