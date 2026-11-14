// The Uninstall protection section: status, waiting period, partner code and the wait setting.
import { h } from './dom.js';
import { uninstallStatusText, isWaitWeakening } from '../uninstall-logic.js';

const HOUR = 3600000;
const PRESETS = [[HOUR, '1 h'], [6 * HOUR, '6 h'], [24 * HOUR, '24 h'], [48 * HOUR, '48 h'], [7 * 24 * HOUR, '7 days']];
export const UNINSTALL_ACCEPTED = "Your partner's code was accepted. You can uninstall for the next 30 minutes.";
const SHORTEN_MSG = 'Shortening the waiting period needs a permit. Ask your partner for a code or wait it out, then pick the shorter period again.';
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** The block object the unlock dialog takes for the uninstall target. */
export function uninstallBlock(waitMs) {
  return { key: 'uninstall', uninstall: true, title: 'Uninstall protection', unlockDelayMs: finite(waitMs) ? waitMs : null, listIds: [] };
}

function hoursText(ms) {
  return `${Math.round((ms / HOUR) * 10) / 10} h`;
}

/**
 * Renders into `root` and keeps itself current. Returns a cleanup that unsubscribes and stops the timer.
 * deps = { subscribe?, openUnlockDialog?, tzOffsetAt?, now? }
 */
export function mountUninstallSection(root, controller, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  let alive = true;
  let busy = false;
  let msg = null; // { kind: 'err' | 'ok' | 'note', text }
  let lastSig = '';
  let timer = null;
  let detailEl = null;
  let dialog = null;

  const sec = h('section', { class: 'fr-lists fr-uninstall-sec', 'aria-labelledby': 'fr-uninstall-title' });
  root.append(sec);

  function snapshot() {
    const st = controller.state || {};
    return {
      u: st.uninstall || { known: false },
      partner: !!(st.partner && st.partner.set),
      partnerName: st.partner && st.partner.name ? st.partner.name : null,
      kind: st.helper && st.helper.kind,
    };
  }
  function statusFor(s, t) {
    const permitAt = s.u && finite(s.u.permitUntil) ? s.u.permitUntil : t;
    let off;
    try { off = typeof deps.tzOffsetAt === 'function' ? deps.tzOffsetAt(permitAt) : undefined; } catch { off = undefined; }
    return uninstallStatusText(s.u, t, s.kind, s.partner, finite(off) ? off : undefined);
  }

  function stopTimer() { if (timer != null) { clearInterval(timer); timer = null; } }
  function tick() {
    if (!alive) return;
    const s = snapshot();
    const t = now();
    const st = statusFor(s, t);
    const sig = sigOf(s, st);
    if (sig !== lastSig) { render(); return; }
    if (detailEl) detailEl.textContent = st.detail;
  }
  const sigOf = (s, st) => JSON.stringify([s.u, s.partner, s.partnerName, s.kind, st.headline, busy, msg]);

  async function act(call, { done } = {}) {
    if (busy) return;
    busy = true; msg = null;
    render();
    let res;
    try { res = await call(); } catch (e) { res = { ok: false, message: (e && e.message) || 'That did not work.' }; }
    busy = false;
    if (!alive) return;
    if (!res || res.ok !== true) msg = { kind: 'err', text: (res && res.message) || 'That did not work. Try again.' };
    else if (done) msg = done(res);
    render();
  }

  function openFlow(s, note) {
    if (typeof deps.openUnlockDialog !== 'function') { msg = { kind: 'err', text: 'The partner code window is not available here.' }; render(); return; }
    msg = note ? { kind: 'note', text: note } : null;
    let d = null;
    d = deps.openUnlockDialog({
      controller, block: uninstallBlock(s.u.waitMs), subscribe: deps.subscribe,
      onDone: () => { msg = { kind: 'ok', text: UNINSTALL_ACCEPTED }; if (alive) render(); },
      onClose: () => { if (dialog === d) dialog = null; },
    });
    dialog = d;
    render();
  }

  function changeWait(sel, s) {
    const ms = Number(sel.value);
    if (!Number.isFinite(ms)) { render(); return; }
    const permitLive = finite(s.u.permitUntil) && s.u.permitUntil > now();
    if (isWaitWeakening(s.u.waitMs, ms) && !permitLive) {
      lastSig = '';
      openFlow(s, SHORTEN_MSG);
      return;
    }
    act(() => controller.uninstallSetWait(ms));
  }

  function render() {
    if (!alive) return;
    const s = snapshot();
    const t = now();
    const st = statusFor(s, t);
    const sig = sigOf(s, st);
    if (sig === lastSig) return;
    lastSig = sig;
    const active = document.activeElement;
    const fk = active && sec.contains(active) ? active.getAttribute('data-fk') : null;

    const known = s.kind === 'ok' && s.u && s.u.known === true;
    const permitLive = known && finite(s.u.permitUntil) && s.u.permitUntil > t;
    const pending = known && !permitLive && finite(s.u.pendingAt);
    const counting = pending && s.u.pendingAt > t;

    sec.textContent = '';
    detailEl = h('p', { class: 'fr-muted fr-un-detail' }, st.detail);
    sec.append(
      h('h3', { id: 'fr-uninstall-title' }, 'Uninstall protection'),
      h('div', { class: `fr-un-status fr-un-${st.tone}`, role: 'status' }, h('strong', {}, st.headline), detailEl));
    if (msg) sec.append(h('p', { class: msg.kind === 'err' ? 'fr-err' : 'fr-note', role: msg.kind === 'err' ? 'alert' : 'status' }, msg.text));

    const actions = h('div', { class: 'fr-actions' });
    const startLabel = known && finite(s.u.waitMs) ? `Start the waiting period (${hoursText(s.u.waitMs)})` : 'Start the waiting period';
    if (!permitLive) {
      actions.append(h('button', {
        type: 'button', 'data-fk': 'un-wait', disabled: !known || busy || pending,
        title: known ? null : 'Enforcement is not running',
        onclick: () => act(() => controller.uninstallRequestDelay()),
      }, startLabel));
    }
    if (pending) {
      actions.append(h('button', { type: 'button', 'data-fk': 'un-cancel', disabled: busy, onclick: () => act(() => controller.uninstallCancelDelay()) }, 'Cancel the waiting period'));
    }
    if (known && s.partner && !permitLive) {
      actions.append(h('button', { type: 'button', 'data-fk': 'un-partner', disabled: busy, onclick: () => openFlow(s, null) }, 'Ask for a partner code'));
    }
    sec.append(actions);
    if (known && !s.partner) {
      sec.append(h('p', { class: 'fr-muted fr-small' }, 'Add a partner so someone else can approve uninstalling with a code, without the wait.'));
    }

    // Wait setting: presets, plus the current value when it is not one of them.
    const cur = finite(s.u.waitMs) ? s.u.waitMs : null;
    const options = PRESETS.map(([ms, label]) => [ms, label]);
    if (cur != null && !options.some(([ms]) => ms === cur)) {
      options.push([cur, hoursText(cur)]);
      options.sort((a, b) => a[0] - b[0]);
    }
    const sel = h('select', { id: 'fr-un-wait-sel', 'data-fk': 'un-setwait', disabled: !known || busy },
      ...options.map(([ms, label]) => h('option', { value: String(ms), selected: ms === cur }, label)));
    sel.value = cur != null ? String(cur) : String(PRESETS[2][0]);
    sel.addEventListener('change', () => changeWait(sel, s));
    sec.append(h('div', { class: 'fr-field fr-un-waitset' },
      h('label', { class: 'fr-fieldlabel', for: 'fr-un-wait-sel' }, 'Waiting period'),
      sel,
      h('p', { class: 'fr-muted fr-small' }, 'Making it longer takes effect at once. Making it shorter needs a permit from your partner or the wait.')));

    if (fk) {
      const again = [...sec.querySelectorAll('[data-fk]')].find((el) => el.getAttribute('data-fk') === fk && !el.disabled);
      if (again && again !== document.activeElement) again.focus();
    }
    stopTimer();
    if (counting) timer = setInterval(tick, 1000);
  }

  const unsubscribe = typeof deps.subscribe === 'function' ? deps.subscribe(() => render()) : () => {};
  render();

  return () => {
    alive = false;
    stopTimer();
    try { unsubscribe && unsubscribe(); } catch { /* ignore */ }
    try { dialog && dialog.close && dialog.close(); } catch { /* ignore */ }
    dialog = null;
    sec.remove();
  };
}
