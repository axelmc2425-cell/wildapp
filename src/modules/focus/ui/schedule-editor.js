// "New schedule" / "Edit schedule" dialog.
import { h } from './dom.js';
import { openDialog } from './dialog.js';
import { HELPER_REQUIRED } from './start-dialog.js';
import { makeTzOffsetAt } from '../tz.js';
import { UNLOCK_DELAY_PRESETS_H, resolveDelayHours } from '../lock-logic.js';
import {
  initialDraft, toggleWeekday, applyPreset, toggleList, setLock, draftToInput, lockNote,
} from './schedule-editor-logic.js';

const DAYS = [[1, 'Mon', 'Monday'], [2, 'Tue', 'Tuesday'], [3, 'Wed', 'Wednesday'], [4, 'Thu', 'Thursday'], [5, 'Fri', 'Friday'], [6, 'Sat', 'Saturday'], [0, 'Sun', 'Sunday']];
const FIELDS = ['name', 'listIds', 'weekdays', 'times', 'unlock', 'endsOn'];
let seq = 0;

/** Opens the dialog; `onDone(res)` runs after a successful save. Returns { close() }. */
export function openScheduleEditor({ controller, schedule, onDone, now = () => Date.now(), tzOffsetAt = makeTzOffsetAt() } = {}) {
  const uid = ++seq;
  const lists = controller.state.lists;
  let draft = initialDraft(schedule, lists);
  let confirmed = false;
  let busy = false;
  let dlg = null;
  const helperOk = () => controller.state.helper?.kind === 'ok';
  const show = (el, msg) => { el.textContent = msg || ''; el.hidden = !msg; };
  const errEls = {};
  const err = (field) => (errEls[field] = h('p', { class: 'fr-err', id: `fr-sc-err-${field}-${uid}`, role: 'alert', hidden: true }));
  const showErrors = (errors) => {
    for (const f of FIELDS) show(errEls[f], errors[f]);
    const other = Object.entries(errors).filter(([k]) => !FIELDS.includes(k)).map(([, v]) => v).join(' ');
    show(formErr, other);
  };
  const formErr = h('p', { class: 'fr-err', role: 'alert', hidden: true });

  // name
  const nameInput = h('input', { type: 'text', id: `fr-sc-name-${uid}`, maxlength: '60', autocomplete: 'off', 'aria-describedby': `fr-sc-err-name-${uid}` });
  nameInput.value = draft.name;
  nameInput.addEventListener('input', () => { draft = { ...draft, name: nameInput.value }; });

  // lists
  const listBoxes = lists.map((l) => {
    const box = h('input', { type: 'checkbox', 'data-list': String(l.id) });
    box.checked = draft.listIds.includes(l.id);
    box.addEventListener('change', () => { draft = { ...draft, listIds: box.checked ? [...new Set([...draft.listIds, l.id])].sort((a, b) => a - b) : draft.listIds.filter((x) => x !== l.id) }; });
    return h('label', { class: 'fr-checkrow' }, box, h('span', { class: 'fr-checktext' }, h('span', { class: 'fr-checkname' }, l.name)));
  });

  // weekdays
  const dayBtns = DAYS.map(([d, short, long]) => h('button', {
    type: 'button', class: 'fr-day', 'data-day': String(d), 'aria-label': long, 'aria-pressed': 'false',
    onclick: () => { draft = toggleWeekday(draft, d); refresh(); },
  }, short));
  const weekdaysBtn = h('button', { type: 'button', onclick: () => { draft = applyPreset(draft, 'weekdays'); refresh(); } }, 'Weekdays');
  const everyDayBtn = h('button', { type: 'button', onclick: () => { draft = applyPreset(draft, 'every-day'); refresh(); } }, 'Every day');

  // times
  const startInput = h('input', { type: 'time', id: `fr-sc-start-${uid}`, 'aria-describedby': `fr-sc-err-times-${uid}` });
  const endInput = h('input', { type: 'time', id: `fr-sc-end-${uid}`, 'aria-describedby': `fr-sc-err-times-${uid}` });
  startInput.value = draft.start; endInput.value = draft.end;
  startInput.addEventListener('input', () => { draft = { ...draft, start: startInput.value }; });
  endInput.addEventListener('input', () => { draft = { ...draft, end: endInput.value }; });

  // strictness
  const modeName = `fr-sc-mode-${uid}`;
  const normalRadio = h('input', { type: 'radio', name: modeName, value: 'none' });
  const lockedRadio = h('input', { type: 'radio', name: modeName, value: 'locked', 'aria-describedby': `fr-sc-helper-${uid}` });
  normalRadio.checked = draft.lock === 'none'; lockedRadio.checked = draft.lock === 'locked';
  for (const r of [normalRadio, lockedRadio]) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      draft = setLock(draft, r === lockedRadio ? 'locked' : 'none', now(), tzOffsetAt);
      confirmed = false;
      endsInput.value = draft.endsOn;
      refresh();
    });
  }
  const helperMsg = h('p', { class: 'fr-st-lockmsg fr-muted', id: `fr-sc-helper-${uid}`, hidden: true });
  const delayChips = UNLOCK_DELAY_PRESETS_H.map((hrs) => h('button', {
    type: 'button', class: 'fr-delaychip', 'aria-pressed': 'false',
    onclick: () => { draft = { ...draft, delayPreset: hrs, delayCustom: '' }; delayInput.value = ''; confirmed = false; refresh(); },
  }, `${hrs} h`));
  const delayInput = h('input', { type: 'text', inputmode: 'numeric', id: `fr-sc-delay-${uid}`, class: 'fr-num', autocomplete: 'off', 'aria-describedby': `fr-sc-err-unlock-${uid}` });
  delayInput.value = draft.delayCustom;
  delayInput.addEventListener('input', () => { draft = { ...draft, delayCustom: delayInput.value }; confirmed = false; refresh(); });
  const confirmBox = h('input', { type: 'checkbox', id: `fr-sc-confirm-${uid}` });
  confirmBox.addEventListener('change', () => { confirmed = confirmBox.checked; });
  const warnText = h('span', { class: 'fr-lockwarn-text' });
  const lockedOpts = h('div', { class: 'fr-st-lockedopts', hidden: true },
    h('div', { class: 'fr-field' },
      h('span', { class: 'fr-fieldlabel', id: `fr-sc-wait-${uid}` }, 'Waiting period if you change your mind'),
      h('div', { class: 'fr-durrow', role: 'group', 'aria-labelledby': `fr-sc-wait-${uid}` }, delayChips,
        h('span', { class: 'fr-customgroup' }, h('label', { class: 'fr-customlabel', for: delayInput.id }, 'Custom'), delayInput, h('span', { class: 'fr-muted' }, 'hours')))),
    h('label', { class: 'fr-lockwarn', for: confirmBox.id }, confirmBox, warnText));

  // end date
  const endsInput = h('input', { type: 'date', id: `fr-sc-ends-${uid}`, 'aria-describedby': `fr-sc-err-endsOn-${uid}` });
  endsInput.value = draft.endsOn;
  endsInput.addEventListener('input', () => { draft = { ...draft, endsOn: endsInput.value }; });
  endsInput.addEventListener('change', () => { draft = { ...draft, endsOn: endsInput.value }; });
  const endsLabel = h('label', { for: endsInput.id }, 'Ends on');

  const saveBtn = h('button', { type: 'button', class: 'primary' }, 'Save');
  const cancelBtn = h('button', { type: 'button' }, 'Cancel');
  cancelBtn.addEventListener('click', () => dlg.close());

  function refresh() {
    const ok = helperOk();
    const lk = draft.lock === 'locked';
    lockedRadio.disabled = busy || !ok;
    normalRadio.disabled = busy;
    lockedRadio.checked = lk; normalRadio.checked = !lk;
    show(helperMsg, ok ? '' : HELPER_REQUIRED);
    lockedOpts.hidden = !lk;
    endsLabel.textContent = lk ? 'Ends on (required)' : 'Ends on (optional)';
    const hasCustom = draft.delayCustom.trim() !== '';
    delayChips.forEach((b, i) => b.setAttribute('aria-pressed', String(!hasCustom && draft.delayPreset === UNLOCK_DELAY_PRESETS_H[i])));
    delayInput.setAttribute('aria-invalid', String(hasCustom && !resolveDelayHours({ preset: draft.delayPreset, custom: draft.delayCustom }).ok));
    warnText.textContent = lockNote(draft);
    confirmBox.checked = confirmed;
    dayBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(draft.weekdays.includes(DAYS[i][0]))));
    saveBtn.disabled = busy;
  }

  async function save() {
    if (busy) return;
    const r = draftToInput(draft, now(), tzOffsetAt);
    const errors = r.ok ? {} : { ...r.errors };
    if (draft.lock === 'locked') {
      if (!helperOk()) errors.unlock = HELPER_REQUIRED;
      else if (r.ok && !confirmed) errors.unlock = 'Tick the box to confirm the lock.';
    }
    showErrors(errors);
    if (Object.keys(errors).length) {
      const first = FIELDS.find((f) => errors[f]);
      if (first === 'name') nameInput.focus();
      return;
    }
    busy = true; refresh();
    let res;
    try { res = await controller.saveSchedule(r.value); }
    catch (e) { res = { ok: false, errors: { name: `Could not save: ${e?.message || e}` } }; }
    busy = false;
    if (res && res.ok) {
      dlg.close();
      onDone?.(res);
      return;
    }
    refresh();
    showErrors((res && res.errors) || { form: (res && res.message) || 'Could not save the schedule.' });
    saveBtn.focus();
  }
  saveBtn.addEventListener('click', save);

  const body = h('div', { class: 'fr-start fr-sched-editor' },
    h('div', { class: 'fr-field' }, h('label', { for: nameInput.id }, 'Name (optional)'), nameInput, err('name')),
    h('div', { class: 'fr-field' },
      h('span', { class: 'fr-fieldlabel', id: `fr-sc-what-${uid}` }, 'What to block'),
      lists.length === 0 ? h('p', { class: 'fr-muted' }, 'Create a list first.')
        : h('div', { class: 'fr-checks', role: 'group', 'aria-labelledby': `fr-sc-what-${uid}` }, listBoxes),
      err('listIds')),
    h('div', { class: 'fr-field' },
      h('span', { class: 'fr-fieldlabel', id: `fr-sc-days-${uid}` }, 'Days'),
      h('div', { class: 'fr-days', role: 'group', 'aria-labelledby': `fr-sc-days-${uid}` }, dayBtns),
      h('div', { class: 'fr-durrow' }, weekdaysBtn, everyDayBtn),
      err('weekdays')),
    h('div', { class: 'fr-field' },
      h('div', { class: 'fr-timerow' },
        h('label', { class: 'fr-timefield', for: startInput.id }, 'From', startInput),
        h('label', { class: 'fr-timefield', for: endInput.id }, 'To', endInput)),
      err('times')),
    h('div', { class: 'fr-field' },
      h('span', { class: 'fr-fieldlabel', id: `fr-sc-strict-${uid}` }, 'How strict'),
      h('div', { class: 'fr-modes', role: 'radiogroup', 'aria-labelledby': `fr-sc-strict-${uid}` },
        h('label', { class: 'fr-moderow' }, normalRadio,
          h('span', { class: 'fr-modetext' }, h('strong', {}, 'Normal'), h('small', { class: 'fr-muted' }, 'You can pause or delete it any time.'))),
        h('label', { class: 'fr-moderow' }, lockedRadio,
          h('span', { class: 'fr-modetext' }, h('strong', {}, 'Locked'), h('small', { class: 'fr-muted' }, 'You cannot change it until the end date.')))),
      helperMsg, lockedOpts, err('unlock')),
    h('div', { class: 'fr-field' }, endsLabel, endsInput, err('endsOn')),
    formErr,
    h('div', { class: 'fr-dialog-actions' }, cancelBtn, saveBtn));
  refresh();
  dlg = openDialog({ title: schedule ? 'Edit schedule' : 'New schedule', body, canClose: () => !busy });
  return { close: () => dlg.close() };
}
