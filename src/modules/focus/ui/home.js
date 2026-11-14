import { h } from './dom.js';
import { openDialog, confirmDialog } from './dialog.js';
import { folderLabel } from './editor-logic.js';
import { chipSummary, formatClock, minutesLeft } from './util.js';
import { bannerFor, formatCountdown } from '../model.js';
import { STARTERS } from '../starters.js';
import { windowIdForBlock, pendingUnlockFor, lockedBlockHolding } from '../lock-logic.js';
import { renderSchedules } from './schedule-list.js';
import { renderLimits, limitBlock, LOCKED_MSG } from './limit-list.js';
import { nextOccurrence, isLockedActive } from '../schedule-logic.js';
import { makeTzOffsetAt } from '../tz.js';
import { mountUninstallSection } from './uninstall-section.js';

const SOON = 'Coming in the next step';
const RUNNING_MSG = 'This list is in a running block. Stop the block first.';

function deleteListMsg(res) {
  if (res.reason === 'running') return RUNNING_MSG;
  if (res.reason === 'locked-schedule') {
    return Number.isFinite(res.lockedUntil)
      ? `This list is part of a locked schedule until ${new Date(res.lockedUntil).toLocaleDateString([], { month: 'short', day: 'numeric' })}.`
      : 'This list is part of a locked schedule.';
  }
  return res.message || 'Could not delete that list.';
}

function scheduleResultMsg(res, schedule) {
  if (res.reason === 'locked') return `This schedule is locked until ${schedule?.endsOn ?? 'its end date'}.`;
  if (res.reason === 'missing') return 'That schedule no longer exists.';
  return res.message || 'That did not work.';
}
const FINISHED = 'That block has already finished.';

/**
 * Renders the Focus Room home view. Returns a cleanup that unsubscribes and stops every timer.
 * deps = { subscribe, openListEditor?, openScheduleEditor?, openLimitEditor?, openStartDialog?, openPartnerSetup?, openUnlockDialog?, mountHelperDetails?, openStats?, tzOffsetAt? }
 */
export function mountHome(root, controller, ctx, deps = {}) {
  const now = () => Date.now();
  const tzOffsetAt = deps.tzOffsetAt || makeTzOffsetAt();
  let schedMsg = null;   // message about a schedule action
  let limitMsg = null;   // message about a time limit action
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
  const statsBtn = typeof deps.openStats === 'function'
    ? h('button', { type: 'button', class: 'fr-statsbtn', 'data-fk': 'open-stats', onclick: () => deps.openStats() }, 'Stats')
    : null;
  const headEl = h('div', { class: 'fr-head' }, h('h2', {}, '🎯 Focus Room'), statsBtn, bannerEl);
  const notesEl = h('div', { class: 'fr-notes' });
  const cardsEl = h('div', { class: 'fr-cards' });
  const welcomeEl = h('div', {});
  const listsEl = h('section', { class: 'fr-lists', 'aria-labelledby': 'fr-lists-title' });
  const schedsEl = h('section', { class: 'fr-lists fr-schedules', 'aria-labelledby': 'fr-scheds-title' });
  const limitsEl = h('section', { class: 'fr-lists fr-limits-sec', 'aria-labelledby': 'fr-limits-title' });
  const uninstallEl = h('div', { class: 'fr-uninstall-host' });
  const detailsEl = h('div', {});
  const page = h('div', { class: 'page fr-home' }, headEl, notesEl, cardsEl, welcomeEl, listsEl, schedsEl, limitsEl, uninstallEl, detailsEl);
  root.innerHTML = '';
  root.append(page);

  // The details panel is built once and patched in place, so an open panel survives every re-render.
  let details = null;
  function mountDetails() {
    if (typeof deps.mountHelperDetails !== 'function') return;
    if (!details) {
      const body = h('div', {});
      detailsEl.append(h('details', { class: 'fr-details' }, h('summary', {}, 'Helper details'), body));
      details = deps.mountHelperDetails(body, controller);
    } else {
      details.update();
    }
  }

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

  // A started block's own message (e.g. "couldn't confirm the lock") shows in the notes area.
  function afterStarted(res) {
    if (res && typeof res.message === 'string' && res.message) local = { text: res.message };
    afterAction();
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
      block.lock === 'locked' ? h('p', { class: 'fr-muted fr-dialog-text' }, 'This block is locked, so extending can only make the lock longer.') : null,
      h('div', { class: 'fr-choices' },
        h('button', { type: 'button', onclick: () => go(15) }, '+15 min'),
        h('button', { type: 'button', onclick: () => go(60) }, '+1 hour')),
      h('div', { class: 'row fr-custom' },
        h('label', {}, 'Custom minutes ', input),
        h('button', { type: 'button', onclick: custom }, 'Extend')),
      err);
    dlg = openD({ title: 'Extend this block', body });
  }

  function unlockDialog(block) {
    if (typeof deps.openUnlockDialog !== 'function') return;
    let d = null;
    d = deps.openUnlockDialog({
      controller, block, subscribe: deps.subscribe,
      onDone: (res) => {
        afterAction();
        if (alive && (document.activeElement === document.body || !document.activeElement)) {
          root.querySelector('[data-fk="start"]:not([disabled])')?.focus();
        }
        return res;
      },
      onClose: () => { if (d) dialogs.delete(d); },
    });
    dialogs.add(d);
  }

  function limitUnlock(limit) {
    if (typeof deps.openUnlockDialog !== 'function') { limitMsg = LOCKED_MSG; afterAction(); return; }
    let d = null;
    d = deps.openUnlockDialog({
      controller, block: limitBlock(limit), subscribe: deps.subscribe,
      onDone: () => { limitMsg = null; afterAction(); },
      onClose: () => { if (d) dialogs.delete(d); },
    });
    dialogs.add(d);
  }

  function openLimit(limit) {
    if (typeof deps.openLimitEditor !== 'function') return;
    let d = null;
    const track = (x) => { if (x && typeof x.close === 'function') dialogs.add(x); return x; };
    d = deps.openLimitEditor(controller, limit || null, {
      subscribe: deps.subscribe,
      openUnlockDialog: typeof deps.openUnlockDialog === 'function'
        ? (o) => { let u = null; u = track(deps.openUnlockDialog({ ...o, onClose: () => { if (u) dialogs.delete(u); o.onClose?.(); } })); return u; }
        : undefined,
      onClose: () => { if (d) dialogs.delete(d); },
      onDone: (res) => { limitMsg = res && typeof res.warning === 'string' && res.warning ? res.warning : null; afterAction(); },
    });
    track(d);
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

  // Display only: a running schedule occurrence the helper no longer holds (unlocked early) stops looking
  // Locked. Never while a change is unsent or the helper's answer is unknown; nothing is written to the DB.
  function scheduleBlockReleased(state, b) {
    if (b.scheduleId === undefined || state.syncPending) return false;
    const helper = state.helper;
    if (!helper || helper.kind !== 'ok' || !helper.status || !Array.isArray(helper.status.windows)) return false;
    const helperNow = Number.isFinite(helper.status.now_ms) ? helper.status.now_ms : null;
    const held = helper.status.windows.some(w => w && w.id === b.windowId && !(helperNow !== null && Number.isFinite(w.ends) && w.ends <= helperNow));
    return !held;
  }

  // ---- cards ----
  function blockCard(state, block, idx) {
    const t = now();
    const names = block.listNames.join(' + ');
    const running = block.state === 'running';
    const isLocked = block.lock === 'locked';
    const helper = state.helper;
    const pendingAt = isLocked && helper && helper.kind === 'ok' ? pendingUnlockFor(helper.status, windowIdForBlock(block)) : null;
    const cd = h('div', { class: 'fr-big', 'aria-hidden': 'true' });
    const sr = h('div', { class: 'fr-sr', 'aria-live': 'polite' });
    const bar = h('i', {});
    const card = h('div', { class: 'fr-card fr-block' },
      h('div', { class: 'fr-card-top' },
        h('span', { class: 'fr-card-heading' },
          h('h3', { class: 'fr-card-title' }, running ? 'Blocking now' : 'Starting soon'),
          isLocked ? h('span', { class: 'fr-lock' }, h('span', { 'aria-hidden': 'true' }, '🔒 '), 'Locked') : null),
        h('span', { class: 'fr-pill' }, names)),
      cd, sr,
      h('div', { class: 'fr-bar', role: 'progressbar', 'aria-label': 'Block progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar),
      h('div', { class: 'fr-card-bottom' },
        h('span', { class: 'fr-muted fr-card-when' }, isLocked
          ? (running ? `Locked until ${formatClock(block.ends)}` : `starts at ${formatClock(block.starts)}, locked until ${formatClock(block.ends)}`)
          : (running ? `ends at ${formatClock(block.ends)}` : `starts at ${formatClock(block.starts)}, ends at ${formatClock(block.ends)}`)),
        h('span', { class: 'fr-actions' },
          isLocked && typeof deps.openUnlockDialog === 'function'
            ? h('button', { type: 'button', 'data-fk': `unlock-${idx}`, onclick: () => unlockDialog(block) }, 'Unlock early') : null,
          // A schedule occurrence ends with its schedule; extending or cancelling it is not offered.
          block.scheduleId !== undefined ? null : h('button', { type: 'button', 'data-fk': `extend-${idx}`, onclick: () => extendDialog(block) }, 'Extend'),
          isLocked || block.scheduleId !== undefined ? null : h('button', { type: 'button', class: 'danger', 'data-fk': `cancel-${idx}`, onclick: () => cancelDialog(block) }, 'Cancel'))),
      pendingAt != null ? h('p', { class: 'fr-pending', role: 'status' }, `Unlocks at ${formatClock(pendingAt)} unless you cancel`) : null,
      state.syncPending && state.helper.kind !== 'ok' && state.helper.kind !== 'persist-failed' ? h('p', { class: 'fr-muted fr-small' }, 'Saved, not yet enforced.') : null);
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

  function partnerSetupDep() {
    return typeof deps.openPartnerSetup === 'function'
      ? (o) => deps.openPartnerSetup({ ...o, onDone: (res) => { o.onDone?.(res); afterStarted(res); } })
      : undefined;
  }

  function startButton(state) {
    const can = typeof deps.openStartDialog === 'function' && state.lists.length > 0;
    const title = typeof deps.openStartDialog !== 'function' ? SOON : state.lists.length === 0 ? 'Create a list first' : null;
    return h('button', {
      type: 'button', class: 'primary', 'data-fk': 'start', disabled: !can, title,
      onclick: () => deps.openStartDialog({
        controller, onDone: afterStarted, subscribe: deps.subscribe,
        openPartnerSetup: partnerSetupDep(),
      }),
    }, 'Start a block');
  }

  // ---- lists ----
  function chip(text, isApp, title) {
    return h('span', { class: `fr-chip${isApp ? ' fr-app' : ''}`, title: title || text },
      h('span', { class: 'fr-chip-text' }, text), isApp ? h('small', { class: 'fr-chip-mark' }, 'app') : null);
  }

  function listRow(state, list) {
    const locked = state.blocks.some(b => b.state === 'running' && b.listIds.includes(list.id));
    const lockedBlock = lockedBlockHolding(state.blocks, list.id);
    const lockMsg = lockedBlock ? `In a locked block until ${formatClock(lockedBlock.ends)}` : null;
    const items = [...list.sites.map(v => ({ v, app: false })), ...list.apps.map(v => ({ v, app: true })), ...(list.folders || []).map(v => ({ v, app: false, folder: true }))];
    const { shown, more } = chipSummary(items, 6);
    const editOk = typeof deps.openListEditor === 'function';
    return h('div', { class: 'fr-list' },
      h('div', { class: 'fr-list-main' },
        h('strong', { class: 'fr-list-name', title: list.name }, list.name),
        h('div', { class: 'fr-chips' },
          shown.map(i => i.folder ? chip(folderLabel(i.v), false, i.v) : chip(i.v, i.app)),
          more > 0 ? h('span', { class: 'fr-chip fr-more' }, `+${more}`) : null,
          items.length === 0 ? h('span', { class: 'fr-muted fr-small' }, 'Empty list') : null),
        lockMsg ? h('p', { class: 'fr-muted fr-small fr-list-lock' }, h('span', { 'aria-hidden': 'true' }, '🔒 '), lockMsg) : null),
      h('div', { class: 'fr-actions' },
        h('button', {
          type: 'button', 'data-fk': `edit-${list.id}`, disabled: !editOk || !!lockedBlock, title: lockMsg || (editOk ? null : SOON),
          'aria-label': `Edit ${list.name}`,
          onclick: () => deps.openListEditor({ controller, list, onDone: afterAction }),
        }, 'Edit'),
        h('button', {
          type: 'button', class: 'danger', 'data-fk': `delete-${list.id}`, disabled: locked, title: lockMsg || (locked ? RUNNING_MSG : null),
          'aria-label': `Delete ${list.name}`,
          onclick: () => confirmD({
            title: 'Delete this list?',
            message: `“${list.name}” will be removed.`,
            confirmLabel: 'Delete', danger: true,
            onConfirm: async () => {
              const res = await controller.deleteList(list.id);
              if (res && res.ok === false) listMsg = deleteListMsg(res);
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
    const blocks = state.blocks.filter(b => b.state !== 'finished' && b.ends > t && !scheduleBlockReleased(state, b));
    const schedules = state.schedules || [];
    const sig = JSON.stringify([
      bannerFor(state.helper), state.syncPending, state.notice, local, listMsg,
      state.loaded, state.lists, blocks.map(b => [b.key, b.state, b.listNames, b.lock, b.lock === 'locked' && state.helper?.kind === 'ok' ? pendingUnlockFor(state.helper.status, windowIdForBlock(b)) : null]),
      limitMsg, state.limitsState || null, typeof deps.openLimitEditor,
      schedMsg, schedules, schedules.map(sc => [nextOccurrence(sc, t, tzOffsetAt), isLockedActive(sc, t, tzOffsetAt)]),
      typeof deps.openScheduleEditor,
      typeof deps.openListEditor, typeof deps.openStartDialog, typeof deps.openPartnerSetup, typeof deps.openUnlockDialog,
    ]);
    renderBanner(state);
    mountDetails();
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

    schedsEl.textContent = '';
    schedsEl.append(h('h3', { id: 'fr-scheds-title' }, 'Schedules'));
    if (schedMsg) schedsEl.append(h('p', { class: 'fr-note', role: 'alert' }, schedMsg));
    if (state.loaded) {
      schedsEl.append(renderSchedules({ lists: state.lists, schedules }, {
        nowMs: t, tzOffsetAt, controller, confirm: confirmD,
        openEditor: typeof deps.openScheduleEditor === 'function'
          ? (schedule) => deps.openScheduleEditor({
            controller, schedule, subscribe: deps.subscribe, openPartnerSetup: partnerSetupDep(),
            onDone: (res) => { schedMsg = res && typeof res.message === 'string' && res.message ? res.message : null; afterAction(); },
          })
          : undefined,
        onResult: (res, schedule) => {
          schedMsg = res && res.ok === false ? scheduleResultMsg(res, schedule) : null;
          afterAction();
        },
      }));
    }

    renderLimitSection(state);
    restore();
  }

  function renderLimitSection(state) {
    const ls = state.limitsState;
    limitsEl.textContent = '';
    const canEdit = typeof deps.openLimitEditor === 'function';
    limitsEl.append(h('div', { class: 'fr-sec-head' },
      h('h3', { id: 'fr-limits-title' }, 'Time limits'),
      ls && ls.loaded ? h('button', {
        type: 'button', 'data-fk': 'limit-add', disabled: !canEdit, title: canEdit ? null : SOON,
        onclick: () => openLimit(null),
      }, 'Add limit') : null));
    if (!ls) return;
    if (limitMsg) limitsEl.append(h('p', { class: 'fr-note', role: 'alert' }, limitMsg));
    limitsEl.append(renderLimits({ ...ls, helperKind: state.helper?.kind, trackingOff: state.helper?.kind === 'ok' && state.helper.status?.usage_tracking === false }, {
      controller, confirm: confirmD, openEditor: canEdit ? openLimit : undefined, openUnlock: limitUnlock,
      onResult: (res) => {
        limitMsg = res && res.ok === false ? (res.message || 'That did not work.') : (res && res.warning) || null;
        afterAction();
      },
    }));
  }

  // ---- wiring ----
  const sectionListeners = new Set(); // one controller subscription serves home and the uninstall section
  const unsubscribe = deps.subscribe ? deps.subscribe(() => { render(); for (const f of [...sectionListeners]) f(); }) : () => {};
  const timers = [
    setInterval(tick, 1000),
    setInterval(() => { lastSig = ''; render(); }, 60000), // schedule rows show times that move on
    setInterval(() => { controller.refreshStatus(); if (typeof controller.refreshLimits === 'function') controller.refreshLimits(); }, 5000),
    setInterval(() => { if (controller.state.syncPending) controller.resync(); }, 30000),
  ];
  // Mounted once: it keeps itself current (subscription and its own countdown timer).
  const stopUninstall = mountUninstallSection(uninstallEl, controller, { subscribe: (f) => { sectionListeners.add(f); return () => sectionListeners.delete(f); }, openUnlockDialog: deps.openUnlockDialog, tzOffsetAt, now });
  render();

  return () => {
    alive = false;
    try { stopUninstall(); } catch { /* ignore */ }
    try { unsubscribe(); } catch { /* ignore */ }
    for (const id of timers) clearInterval(id);
    try { details?.destroy(); } catch { /* ignore */ }
    for (const d of [...dialogs]) d.close();
    dialogs.clear();
    root.innerHTML = '';
  };
}
