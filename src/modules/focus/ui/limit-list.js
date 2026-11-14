// The Time limits section: one row per limit with its usage bar and Edit / Pause|Resume / Delete.
import { h } from './dom.js';
import { chipSummary } from './util.js';
import { statusText } from '../limit-logic.js';
import { formatDuration } from '../stats.js';

const SOON = 'Coming in the next step';
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** The block object the unlock dialog takes for a limit (its key is the helper window id). */
export function limitBlock(limit) {
  const key = `limit-${limit.id}`;
  return { key, windowId: key, lock: 'locked', limit: true, title: limit.name, unlockDelayMs: finite(limit.unlockDelayMs) ? limit.unlockDelayMs : null, listIds: [] };
}

/** Status with finite numbers only; anything else counts as "no status yet". */
function cleanStatus(s) {
  return s && typeof s === 'object' && finite(s.used_secs) && finite(s.cap_secs) && s.cap_secs > 0 ? s : undefined;
}

const chip = (text, isApp) => h('span', { class: `fr-chip${isApp ? ' fr-app' : ''}`, title: text },
  h('span', { class: 'fr-chip-text' }, text), isApp ? h('small', { class: 'fr-chip-mark' }, 'app') : null);

/**
 * @param {{limits: object[], loaded: boolean, enforcement?: boolean, helperKind?: string}} state
 * @param {{controller: object, confirm: (opts: object) => void, openEditor?: (limit?: object) => void,
 *   openUnlock?: (limit: object) => void, onResult?: (res: object, limit: object) => void}} o
 */
export function renderLimits(state, { controller, confirm, openEditor, openUnlock, onResult } = {}) {
  const canEdit = typeof openEditor === 'function';
  const down = state.enforcement === false || (state.helperKind != null && state.helperKind !== 'ok');
  const helperKind = down ? (state.helperKind && state.helperKind !== 'ok' ? state.helperKind : 'unreachable') : 'ok';
  const report = (res, l) => {
    if (res && res.needsUnlock && typeof openUnlock === 'function') { openUnlock(l); return; }
    if (typeof onResult === 'function') onResult(res, l);
  };

  const row = (l) => {
    const status = cleanStatus(l.status);
    const s = statusText(l, status, helperKind);
    const items = [...(l.sites || []).map((v) => ({ v, app: false })), ...(l.apps || []).map((v) => ({ v, app: true }))];
    const { shown, more } = chipSummary(items, 6);
    const showBar = status && helperKind === 'ok' && l.enabled !== false;
    const used = showBar ? Math.min(status.used_secs, status.cap_secs) : 0;
    const fill = h('i', {});
    if (showBar) fill.style.width = `${Math.round((used / status.cap_secs) * 100)}%`;
    const bar = showBar ? h('div', {
      class: `fr-bar fr-limit-bar fr-limit-bar-${s.tone}`, role: 'progressbar', 'aria-label': `Time used for ${l.name}`,
      'aria-valuemin': '0', 'aria-valuemax': String(status.cap_secs), 'aria-valuenow': String(used),
      'aria-valuetext': `Used ${formatDuration(used)} of ${formatDuration(status.cap_secs)}. ${s.text}`,
    }, fill) : null;
    return h('div', { class: 'fr-list fr-limit', 'data-fk': `limit-row-${l.id}` },
      h('div', { class: 'fr-list-main' },
        h('div', { class: 'fr-limit-head' },
          h('strong', { class: 'fr-list-name', title: l.name }, l.name),
          l.lock === 'locked' ? h('span', { class: 'fr-lock' }, h('span', { 'aria-hidden': 'true' }, '🔒 '), 'Locked') : null,
          showBar && s.tone === 'blocked' ? h('span', { class: 'fr-limit-blocked' }, 'Blocked') : null),
        h('div', { class: 'fr-muted fr-small fr-limit-cap' }, `${l.period === 'weekly' ? 'Weekly' : 'Daily'} · ${formatDuration(l.capSecs)}`),
        h('div', { class: 'fr-chips' },
          shown.map((i) => chip(i.v, i.app)),
          more > 0 ? h('span', { class: 'fr-chip fr-more' }, `+${more}`) : null,
          items.length === 0 ? h('span', { class: 'fr-muted fr-small' }, 'Nothing to block') : null),
        bar,
        h('p', { class: `fr-small fr-limit-status fr-limit-text-${s.tone}` }, s.text,
          showBar && s.tone === 'ok' ? h('span', { class: 'fr-muted' }, ` · used ${formatDuration(used)} of ${formatDuration(status.cap_secs)}`) : null)),
      h('div', { class: 'fr-actions' },
        h('button', {
          type: 'button', 'data-fk': `limit-edit-${l.id}`, 'aria-label': `Edit ${l.name}`,
          disabled: !canEdit, title: canEdit ? null : SOON, onclick: () => openEditor(l),
        }, 'Edit'),
        h('button', {
          type: 'button', 'data-fk': `limit-toggle-${l.id}`, 'aria-label': `${l.enabled === false ? 'Resume' : 'Pause'} ${l.name}`,
          onclick: async () => report(await controller.setLimitEnabled(l.id, l.enabled === false), l),
        }, l.enabled === false ? 'Resume' : 'Pause'),
        h('button', {
          type: 'button', class: 'danger', 'data-fk': `limit-delete-${l.id}`, 'aria-label': `Delete ${l.name}`,
          onclick: () => confirm({
            title: 'Delete this limit?', message: `“${l.name}” will be removed.`, confirmLabel: 'Delete', danger: true,
            onConfirm: async () => report(await controller.deleteLimit(l.id), l),
          }),
        }, 'Delete')));
  };

  const limits = Array.isArray(state.limits) ? state.limits : [];
  return h('div', { class: 'fr-limits' },
    !state.loaded ? h('p', { class: 'fr-muted fr-loading' }, 'Loading…')
      : limits.length === 0 ? h('p', { class: 'fr-muted' }, 'No time limits yet')
        : limits.map(row));
}
