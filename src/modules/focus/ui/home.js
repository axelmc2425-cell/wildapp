import { h } from './dom.js';
import { openDialog, confirmDialog } from './dialog.js';
import { chipSummary, formatClock, minutesLeft } from './util.js';
import { bannerFor, formatCountdown } from '../model.js';
import { STARTERS } from '../starters.js';

const SOON = 'Coming in the next step';
const RUNNING_MSG = 'This list is in a running block. Stop the block first.';
const FINISHED = 'That block has already finished.';

/**
 * Renders the Focus Room home view. Returns a cleanup that unsubscribes and stops every timer.
 * deps = { subscribe, openListEditor?, openStartDialog?, mountHelperDetails? }
 */
export function mountHome(root, controller, ctx, deps = {}) {
  const now = () => Date.now();
  let alive = true;
  let lastSig = '';
  let local = null;      // { text, retry } - a message from the last action
  let listMsg = null;    // message about a list action
  let live = [];         // per-card nodes updated by the 1 s timer
  const dialogs = new Set();

  const openD = (opts) => {
    const d = openDialog({ ...opts, onClose: () => { dialogs.delete(d); opts.onClose?.(); } });
    dialogs.add(d);
    return d;
  };
  const confirmD = (opts) => {
    const d = confirmDialog({ ...opts, onClose: () => { dialogs.delete(d); opts.onClose?.(); } });
    dialogs.add(d);
    return d;
  };

  // ---- static skeleton ----
  const bannerEl = h('div', { class: 'fr-banner', role: 'status' });
  const headEl = h('div', { class: 'fr-head' }, h('h2', {}, '🎯 Focus Room'), bannerEl);
  const notesEl = h('div', { class: 'fr-notes' });
  const cardsEl = h('div', { class: 'fr-cards' });
  const welcomeEl = h('div', {});
  const listsEl = h('section', { class: 'fr-lists', 'aria-labelledby': 'fr-lists-title' });
  const detailsEl = h('div', {});
  const page = h('div', { class: 'page fr-home' }, headEl, notesEl, cardsEl, welcomeEl, listsEl, detailsEl);
  root.innerHTML = '';
  root.append(page);

  let bannerSig = '';
  function renderBanner(state) {
    const b = bannerFor(state.helper);
    const sig = `${b.level}|${b.title}|${b.detail}`;
    if (sig === bannerSig) return;
    bannerSig = sig;
    bannerEl.className = `fr-banner fr-${b.level}`;
    bannerEl.textContent = '';
    bannerEl.append(
      h('span', { class: 'fr-banner-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'fr-banner-text' },
        h('strong', {}, b.title),
        b.detail ? h('span', { class: 'fr-banner-detail' }, b.detail) : null),
    );
    if (b.level === 'error' || b.level === 'warn') {
      bannerEl.append(h('button', { type: 'button', class: 'fr-retry', 'data-fk': 'banner-retry', onclick: retryNow }, 'Retry'));
    }
  }

  async function retryNow() {
    await controller.resync();
    await controller.refreshStatus();
    afterAction();
  }

  function afterAction() {
    if (!alive) return;
    if (local && local.retry && !controller.state.syncPending) local = null;
    lastSig = '';
    render();
  }

  function handleResult(res, ok) {
    if (res && res.ok === false) {
      local = res.message === FINISHED ? null : { text: res.message || 'That did not work.' };
    } else {
      local = ok ? ok(res) : null;
    }
    afterAction();
  }

  // ---- extend / cancel ----
  function extendDialog(block) {
    let dlg;
    const go = async (min) => {
      dlg.close();
      handleResult(await controller.extendBlock(block.key, min));
    };
    const input = h('input', { type: 'number', min: '1', max: '1440', step: '1', 'aria-label': 'Custom minutes', class: 'fr-num' });
    const err = h('p', { class: 'fr-err', role: 'alert', hidden: true });
    const custom = () => {
      const t = input.value.trim();
      if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 1440) {
        err.textContent = 'Enter a whole number of minutes from 1 to 1440.';
        err.hidden = false;
        input.focus();
        return;
      }
      go(Number(t));
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); custom(); } });
    const body = h('div', {},
      h('div', { class: 'fr-choices' },
        h('button', { type: 'button', onclick: () => go(15) }, '+15 min'),
        h('button', { type: 'button', onclick: () => go(60) }, '+1 hour')),
      h('div', { class: 'row fr-custom' },
        h('label', {}, 'Custom minutes ', input),
        h('button', { type: 'button', onclick: custom }, 'Extend')),
      err);
    dlg = openD({ title: 'Extend this block', body });
  }

  function cancelDialog(block) {
    confirmD({
      title: 'Stop blocking now?',
      message: 'Sites and apps in this block will be allowed again.',
      confirmLabel: 'Stop blocking',
      cancelLabel: 'Keep blocking',
      danger: true,
      onConfirm: async () => {
        const res = await controller.cancelBlock(block.key);
        handleResult(res, (r) => (r && r.helperStopped === false
          ? { text: `Couldn't tell the helper to stop. It will stop by ${formatClock(r.enforcedUntil)} at the latest.`, retry: true }
          : null));
      },
    });
  }

  // ---- cards ----
  function blockCard(state, block, idx) {
    const t = now();
    const names = block.listNames.join(' + ');
    const running = block.state === 'running';
    const cd = h('div', { class: 'fr-big', 'aria-hidden': 'true' });
    const sr = h('div', { class: 'fr-sr', 'aria-live': 'polite' });
    const bar = h('i', {});
    const card = h('div', { class: 'fr-card fr-block' },
      h('div', { class: 'fr-card-top' },
        h('h3', { class: 'fr-card-title' }, running ? 'Blocking now' : 'Starting soon'),
        h('span', { class: 'fr-pill' }, names)),
      cd, sr,
      h('div', { class: 'fr-bar', role: 'progressbar', 'aria-label': 'Block progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar),
      h('div', { class: 'fr-card-bottom' },
        h('span', { class: 'fr-muted' }, running ? `ends at ${formatClock(block.ends)}` : `starts at ${formatClock(block.starts)}, ends at ${formatClock(block.ends)}`),
        h('span', { class: 'fr-actions' },
          h('button', { type: 'button', 'data-fk': `extend-${idx}`, onclick: () => extendDialog(block) }, 'Extend'),
          h('button', { type: 'button', class: 'danger', 'data-fk': `cancel-${idx}`, onclick: () => cancelDialog(block) }, 'Cancel'))),
      state.syncPending && state.helper.kind !== 'ok' ? h('p', { class: 'fr-muted fr-small' }, 'Saved, not yet enforced.') : null);
    const entry = { block, state: block.state, cd, sr, bar, lastMin: -1 };
    live.push(entry);
    paintLive(entry, t);
    return card;
  }

  function paintLive(e, t) {
    const b = e.block;
    const left = b.ends - t;
    const running = t >= b.starts;
    e.cd.textContent = running ? formatCountdown(left) : formatCountdown(b.starts - t).replace('left', 'to start');
    const p = Math.min(1, Math.max(0, (t - b.starts) / (b.ends - b.starts)));
    e.bar.style.width = `${(p * 100).toFixed(1)}%`;
    e.bar.parentElement.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    const mins = minutesLeft(running ? left : b.starts - t);
    if (mins !== e.lastMin) {
      e.lastMin = mins;
      e.sr.textContent = running ? formatCountdown(left) : formatCountdown(b.starts - t).replace('left', 'to start');
    }
  }

  function tick() {
    if (!alive) return;
    const t = now();
    for (const e of live) {
      const st = t >= e.block.ends ? 'finished' : t >= e.block.starts ? 'running' : 'upcoming';
      if (st !== e.state) { lastSig = ''; render(); return; }
      paintLive(e, t);
    }
  }

  function startButton(state) {
    const can = typeof deps.openStartDialog === 'function' && state.lists.length > 0;
    const title = typeof deps.openStartDialog !== 'function' ? SOON : state.lists.length === 0 ? 'Create a list first' : null;
    return h('button', {
      type: 'button', class: 'primary', 'data-fk': 'start', disabled: !can, title,
      onclick: () => deps.openStartDialog({ controller, onDone: afterAction }),
    }, 'Start a block');
  }

  // ---- lists ----
  function chip(text, isApp) {
    return h('span', { class: `fr-chip${isApp ? ' fr-app' : ''}`, title: text },
      h('span', { class: 'fr-chip-text' }, text), isApp ? h('small', { class: 'fr-chip-mark' }, 'app') : null);
  }

  function listRow(state, list) {
    const locked = state.blocks.some(b => b.state === 'running' && b.listIds.includes(list.id));
    const items = [...list.sites.map(v => ({ v, app: false })), ...list.apps.map(v => ({ v, app: true }))];
    const { shown, more } = chipSummary(items, 6);
    const editOk = typeof deps.openListEditor === 'function';
    return h('div', { class: 'fr-list' },
      h('div', { class: 'fr-list-main' },
        h('strong', { class: 'fr-list-name', title: list.name }, list.name),
        h('div', { class: 'fr-chips' },
          shown.map(i => chip(i.v, i.app)),
          more > 0 ? h('span', { class: 'fr-chip fr-more' }, `+${more}`) : null,
          items.length === 0 ? h('span', { class: 'fr-muted fr-small' }, 'Empty list') : null)),
      h('div', { class: 'fr-actions' },
        h('button', {
          type: 'button', 'data-fk': `edit-${list.id}`, disabled: !editOk, title: editOk ? null : SOON,
          'aria-label': `Edit ${list.name}`,
          onclick: () => deps.openListEditor({ controller, list, onDone: afterAction }),
        }, 'Edit'),
        h('button', {
          type: 'button', class: 'danger', 'data-fk': `delete-${list.id}`, disabled: locked, title: locked ? RUNNING_MSG : null,
          'aria-label': `Delete ${list.name}`,
          onclick: () => confirmD({
            title: 'Delete this list?',
            message: `“${list.name}” will be removed.`,
            confirmLabel: 'Delete', danger: true,
            onConfirm: async () => {
              const res = await controller.deleteList(list.id);
              if (res && res.ok === false) listMsg = res.reason === 'running' ? RUNNING_MSG : (res.message || 'Could not delete that list.');
              else listMsg = null;
              afterAction();
            },
          }),
        }, 'Delete')));
  }

  function newListButton() {
    const ok = typeof deps.openListEditor === 'function';
    return h('button', {
      type: 'button', 'data-fk': 'new-list', disabled: !ok, title: ok ? null : SOON,
      onclick: () => deps.openListEditor({ controller, onDone: afterAction }),
    }, 'New list');
  }

  function welcome(state) {
    welcomeEl.textContent = '';
    if (state.lists.length > 0) return;
    const ok = typeof deps.openListEditor === 'function';
    welcomeEl.append(h('div', { class: 'fr-card fr-welcome' },
      h('h3', { class: 'fr-card-title' }, 'Create your first list'),
      h('p', { class: 'fr-muted' }, 'A list is a set of websites and apps to block. Start from an example or build your own.'),
      h('div', { class: 'fr-actions fr-wrap' },
        STARTERS.map(s => h('button', {
          type: 'button', 'data-fk': `starter-${s.name}`, disabled: !ok, title: ok ? null : SOON,
          onclick: () => deps.openListEditor({ controller, preset: s, onDone: afterAction }),
        }, s.name)),
        h('button', { type: 'button', 'data-fk': 'blank', disabled: !ok, title: ok ? null : SOON,
          onclick: () => deps.openListEditor({ controller, onDone: afterAction }) }, 'Blank list'))));
  }

  // ---- main render ----
  function render() {
    if (!alive) return;
    const state = controller.state;
    const t = now();
    // Capture the focused control BEFORE any re-render step, restore after all of them.
    const active = document.activeElement;
    const fk = active && root.contains(active) ? active.getAttribute('data-fk') : null;
    const restore = () => {
      if (!fk) return;
      const again = [...root.querySelectorAll('[data-fk]')].find(el => el.getAttribute('data-fk') === fk && !el.disabled);
      if (again && again !== document.activeElement) again.focus();
    };
    const blocks = state.blocks.filter(b => b.state !== 'finished' && b.ends > t);
    const sig = JSON.stringify([
      bannerFor(state.helper), state.syncPending, state.notice, local, listMsg,
      state.loaded, state.lists, blocks.map(b => [b.key, b.state, b.listNames]),
      typeof deps.openListEditor, typeof deps.openStartDialog,
    ]);
    renderBanner(state);
    if (sig === lastSig) { restore(); return; }
    lastSig = sig;

    live = [];
    notesEl.textContent = '';
    if (state.notice) notesEl.append(h('p', { class: 'fr-note' }, state.notice));
    if (local) {
      notesEl.append(h('p', { class: 'fr-note', role: 'status' }, local.text,
        local.retry ? h('button', { type: 'button', class: 'fr-retry', 'data-fk': 'note-retry', onclick: retryNow }, 'Retry') : null));
    }

    cardsEl.textContent = '';
    if (!state.loaded) {
      cardsEl.append(h('p', { class: 'fr-muted fr-loading' }, 'Loading…'));
    } else if (blocks.length === 0) {
      cardsEl.append(h('div', { class: 'fr-card' },
        h('h3', { class: 'fr-card-title' }, 'No block running'),
        h('p', { class: 'fr-muted' }, 'Start a block to keep your lists blocked for a while.'),
        h('div', { class: 'fr-actions' }, startButton(state))));
    } else {
      blocks.forEach((b, i) => cardsEl.append(blockCard(state, b, i)));
      if (state.lists.length > 0 && typeof deps.openStartDialog === 'function') {
        cardsEl.append(h('div', { class: 'fr-actions' }, startButton(state)));
      }
    }

    if (state.loaded) welcome(state); else welcomeEl.textContent = '';

    listsEl.textContent = '';
    listsEl.append(h('h3', { id: 'fr-lists-title' }, 'Block lists'));
    if (listMsg) listsEl.append(h('p', { class: 'fr-note', role: 'alert' }, listMsg));
    if (state.loaded) {
      for (const l of state.lists) listsEl.append(listRow(state, l));
      listsEl.append(h('div', { class: 'fr-actions fr-lists-foot' }, newListButton()));
    }

    if (typeof deps.mountHelperDetails === 'function' && !detailsEl.firstChild) {
      const body = h('div', {});
      detailsEl.append(h('details', { class: 'fr-details' }, h('summary', {}, 'Helper details'), body));
      deps.mountHelperDetails(body, controller);
    }

    restore();
  }

  // ---- wiring ----
  const unsubscribe = deps.subscribe ? deps.subscribe(() => render()) : () => {};
  const timers = [
    setInterval(tick, 1000),
    setInterval(() => { controller.refreshStatus(); }, 5000),
    setInterval(() => { if (controller.state.syncPending) controller.resync(); }, 30000),
  ];
  render();

  return () => {
    alive = false;
    try { unsubscribe(); } catch { /* ignore */ }
    for (const id of timers) clearInterval(id);
    for (const d of [...dialogs]) d.close();
    dialogs.clear();
    root.innerHTML = '';
  };
}
