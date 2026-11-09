import { h } from './dom.js';
import { bannerFor, detailRows } from '../model.js';

/** 'Last sync: 3 windows sent, 1 skipped', or null when there has been no sync. */
export function describeLastSync(lastSync) {
  if (!lastSync || !Number.isFinite(lastSync.pushed)) return null;
  const skipped = Number.isFinite(lastSync.skipped) ? lastSync.skipped : 0;
  return `Last sync: ${lastSync.pushed} ${lastSync.pushed === 1 ? 'window' : 'windows'} sent, ${skipped} skipped`;
}

/** Everything the panel shows, as a string: equal signatures mean nothing needs repainting. */
export function detailsSignature(state) {
  const helper = state.helper || { kind: 'unknown' };
  const status = helper.kind === 'ok' ? helper.status : null;
  return JSON.stringify([
    helper.kind, helper.kind === 'ok' ? detailRows(status) : bannerFor(helper),
    describeLastSync(state.lastSync), !!state.syncPending,
  ]);
}

function rowsList(rows) {
  const dl = h('dl', { class: 'fr-dl' });
  for (const r of rows) {
    dl.append(h('dt', {}, r.label));
    dl.append(h('dd', {}, r.lines
      ? h('ul', { class: 'fr-warnlist' }, r.lines.map((l) => h('li', {}, l)))
      : r.value));
  }
  return dl;
}

/**
 * Fills `container` with the helper details. update() repaints from controller.state only when the
 * visible content changed; the container (and the <details> around it) is never replaced.
 */
export function mountHelperDetails(container, controller) {
  let sig = null;
  let alive = true;
  const content = h('div', { class: 'fr-details-body' });
  container.append(content);

  function update() {
    if (!alive) return;
    const state = controller.state;
    const next = detailsSignature(state);
    if (next === sig) return;
    sig = next;
    const helper = state.helper || { kind: 'unknown' };
    content.textContent = '';
    if (helper.kind === 'ok') {
      content.append(rowsList(detailRows(helper.status)));
    } else {
      const b = bannerFor(helper);
      content.append(
        h('p', { class: 'fr-det-title' }, b.title),
        b.detail ? h('p', { class: 'fr-det-detail' }, b.detail) : null);
    }
    const last = describeLastSync(state.lastSync);
    if (last) content.append(h('p', { class: 'fr-muted fr-small' }, last));
    if (state.syncPending) content.append(h('p', { class: 'fr-muted fr-small' }, 'Waiting to send changes to the helper'));
  }

  update();
  return {
    update,
    destroy() { alive = false; content.remove(); },
  };
}
