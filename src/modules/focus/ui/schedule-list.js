// The Schedules section: one row per recurring schedule with Edit / Pause|Resume / Delete.
import { h } from './dom.js';
import { formatClock } from './util.js';
import { describeSchedule, nextOccurrence, isLockedActive } from '../schedule-logic.js';

const SOON = 'Coming in the next step';

function statusText(s, nowMs, tzOffsetAt, lockedActive) {
  const n = nextOccurrence(s, nowMs, tzOffsetAt);
  if (n.state === 'running') return `Blocking now until ${formatClock(n.ends, nowMs)}`;
  if (n.state === 'upcoming') return n.starts !== undefined ? `Next: ${formatClock(n.starts, nowMs)}` : 'Waiting for the next occurrence';
  if (n.state === 'paused') return 'Paused';
  // A locked schedule whose end date is still ahead but has no occurrence left is not "Ended" yet.
  return lockedActive ? 'No more occurrences' : 'Ended';
}

/**
 * @param {{lists: {id: number, name: string}[], schedules: object[]}} state
 * @param {{nowMs: number, tzOffsetAt: (ms: number) => number, openEditor?: (schedule?: object) => void,
 *   controller: object, confirm: (opts: object) => void, onResult?: (res: object) => void}} o
 */
export function renderSchedules(state, { nowMs, tzOffsetAt, openEditor, controller, confirm, onResult }) {
  const canEdit = typeof openEditor === 'function';
  const names = new Map(state.lists.map((l) => [l.id, l.name]));
  const report = (res) => { if (typeof onResult === 'function') onResult(res); };

  const row = (s) => {
    const lockedActive = isLockedActive(s, nowMs, tzOffsetAt);
    const why = lockedActive ? `This schedule is locked until ${s.endsOn}, so it can't be changed.` : null;
    const label = s.name || describeSchedule(s, []);
    const listNames = s.listIds.map((id) => names.get(id)).filter(Boolean);
    const note = s.lock === 'locked'
      ? `Locked, ends ${s.endsOn}`
      : (s.endsOn ? `Ends ${s.endsOn}` : null);
    return h('div', { class: 'fr-list fr-sched', 'data-fk': `sched-row-${s.id}` },
      h('div', { class: 'fr-list-main' },
        s.name ? h('strong', { class: 'fr-list-name', title: s.name }, s.name) : null,
        h('div', { class: s.name ? 'fr-muted fr-small fr-sched-when' : 'fr-sched-when' }, describeSchedule(s, listNames)),
        h('div', { class: 'fr-chips' },
          listNames.length ? listNames.map((n) => h('span', { class: 'fr-chip', title: n }, h('span', { class: 'fr-chip-text' }, n)))
            : h('span', { class: 'fr-muted fr-small' }, 'No lists')),
        h('p', { class: 'fr-muted fr-small fr-sched-status' },
          statusText(s, nowMs, tzOffsetAt, lockedActive),
          note ? h('span', {}, ' · ', s.lock === 'locked' ? h('span', { 'aria-hidden': 'true' }, '🔒 ') : null, note) : null)),
      h('div', { class: 'fr-actions' },
        h('button', {
          type: 'button', 'data-fk': `sched-edit-${s.id}`, 'aria-label': `Edit ${label}`,
          disabled: !canEdit || lockedActive, title: why || (canEdit ? null : SOON),
          onclick: () => openEditor(s),
        }, 'Edit'),
        h('button', {
          type: 'button', 'data-fk': `sched-toggle-${s.id}`, 'aria-label': `${s.enabled ? 'Pause' : 'Resume'} ${label}`,
          disabled: lockedActive, title: why,
          onclick: async () => report(await controller.setScheduleEnabled(s.id, !s.enabled)),
        }, s.enabled ? 'Pause' : 'Resume'),
        h('button', {
          type: 'button', class: 'danger', 'data-fk': `sched-delete-${s.id}`, 'aria-label': `Delete ${label}`,
          disabled: lockedActive, title: why,
          onclick: () => confirm({
            title: 'Delete this schedule?',
            message: `“${label}” will be removed.`,
            confirmLabel: 'Delete', danger: true,
            onConfirm: async () => report(await controller.deleteSchedule(s.id)),
          }),
        }, 'Delete')));
  };

  const newBtn = h('button', {
    type: 'button', 'data-fk': 'new-schedule',
    disabled: !canEdit || state.lists.length === 0,
    title: !canEdit ? SOON : (state.lists.length === 0 ? 'Create a list first' : null),
    onclick: () => openEditor(),
  }, 'New schedule');

  return h('div', { class: 'fr-scheds' },
    state.schedules.length === 0 ? h('p', { class: 'fr-muted' }, 'No schedules yet') : state.schedules.map(row),
    h('div', { class: 'fr-actions fr-lists-foot' }, newBtn));
}
