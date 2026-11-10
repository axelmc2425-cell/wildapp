import test from 'node:test';
import assert from 'node:assert/strict';
import { describeLastSync, detailsSignature } from '../src/modules/focus/ui/helper-details.js';
import { installDom, findAll } from './helpers/fake-dom.js';
import { openListEditor } from '../src/modules/focus/ui/list-editor.js';
import { chipSummary, formatClock, minutesLeft } from '../src/modules/focus/ui/util.js';

test('chipSummary caps and counts the rest', () => {
  assert.deepEqual(chipSummary(['a', 'b', 'c'], 2), { shown: ['a', 'b'], more: 1 });
  assert.deepEqual(chipSummary(['a'], 6), { shown: ['a'], more: 0 });
  assert.deepEqual(chipSummary([], 6), { shown: [], more: 0 });
  assert.deepEqual(chipSummary(null, 6), { shown: [], more: 0 });
  assert.deepEqual(chipSummary([1, 2, 3, 4, 5, 6, 7, 8], 6).more, 2);
});

test('formatClock never throws on absurd times', () => {
  for (const v of [NaN, Infinity, -Infinity, 8.64e15 + 1, 'x', null, undefined]) assert.equal(formatClock(v), 'later');
  assert.match(formatClock(Date.UTC(2026, 0, 1, 12, 0)), /\d{1,2}:\d{2}/);
});

test('formatClock adds a weekday or date when not today', () => {
  const now = new Date(2026, 10, 9, 15, 15).getTime();
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  assert.equal(formatClock(new Date(2026, 10, 9, 18, 0).getTime(), now), clock(new Date(2026, 10, 9, 18, 0).getTime()));
  const tomorrow = new Date(2026, 10, 10, 15, 15).getTime();
  assert.equal(formatClock(tomorrow, now), `${new Date(tomorrow).toLocaleDateString([], { weekday: 'short' })} ${clock(tomorrow)}`);
  const later = new Date(2026, 10, 20, 9, 0).getTime();
  assert.equal(formatClock(later, now), `${new Date(later).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(later)}`);
});

test('minutesLeft rounds up and clamps', () => {
  assert.equal(minutesLeft(1), 1);
  assert.equal(minutesLeft(60000), 1);
  assert.equal(minutesLeft(60001), 2);
  assert.equal(minutesLeft(-5), 0);
  assert.equal(minutesLeft(NaN), 0);
});

test('describeLastSync', () => {
  assert.equal(describeLastSync(null), null);
  assert.equal(describeLastSync(undefined), null);
  assert.equal(describeLastSync({ pushed: 3, skipped: 1 }), 'Last sync: 3 windows sent, 1 skipped');
  assert.equal(describeLastSync({ pushed: 1, skipped: 0 }), 'Last sync: 1 window sent, 0 skipped');
});

test('detailsSignature changes only with visible content', () => {
  const ok = { helper: { kind: 'ok', status: { decision: {}, windows: [], partner_set: false, now_ms: 0, warnings: [] } }, syncPending: false, lastSync: null };
  assert.equal(detailsSignature(ok), detailsSignature(JSON.parse(JSON.stringify(ok))));
  const later = JSON.parse(JSON.stringify(ok));
  if (later.helper.status) later.helper.status.now_ms = (later.helper.status.now_ms || 0) + 5000;
  assert.equal(detailsSignature(ok), detailsSignature(later));
  assert.notEqual(detailsSignature(ok), detailsSignature({ ...ok, syncPending: true }));
  assert.notEqual(detailsSignature(ok), detailsSignature({ ...ok, lastSync: { pushed: 1, skipped: 0 } }));
  assert.notEqual(detailsSignature(ok), detailsSignature({ ...ok, helper: { kind: 'not-running' } }));
});

// --- list editor browse buttons ---
const btnByText = (root, t) => findAll(root, n => n.tag === 'button' && n.textContent === t)[0];
const chips = (root) => findAll(root, n => n.className.includes('fr-edchip'));
const chipTexts = (root) => chips(root).map(c => c.children[0].textContent);
const errTexts = (root) => findAll(root, n => n.tag === 'p' && n.className.includes('fr-err') && !n.hidden).map(n => n.textContent);
const tauri = (open) => ({ core: { invoke() {} }, dialog: { open } });
const noController = { saveList: async () => ({ ok: true }) };

test('editor shows both browse buttons in the desktop app', () => {
  const body = installDom(tauri(async () => null));
  openListEditor({ controller: noController });
  assert.ok(btnByText(body, 'Browse files…'));
  assert.ok(btnByText(body, 'Browse folder…'));
});

test('editor has no browse buttons or Folders field without the desktop app', () => {
  const body = installDom(undefined);
  openListEditor({ controller: noController });
  assert.equal(btnByText(body, 'Browse files…'), undefined);
  assert.equal(btnByText(body, 'Browse folder…'), undefined);
  assert.equal(findAll(body, n => n.tag === 'label' && n.textContent === 'Folders').length, 0);
});

test('picking two .exe files adds two app chips by file name', async () => {
  let opts;
  const body = installDom(tauri(async (o) => { opts = o; return ['C:\\Games\\Steam\\steam.exe', 'D:\\x\\Epic.EXE']; }));
  openListEditor({ controller: noController });
  await btnByText(body, 'Browse files…').click();
  assert.deepEqual(chipTexts(body), ['steam.exe', 'epic.exe']);
  assert.equal(opts.multiple, true);
  assert.deepEqual(opts.filters[0].extensions, ['exe']);
});

test('a cancelled dialog changes nothing and shows nothing', async () => {
  const body = installDom(tauri(async () => null));
  openListEditor({ controller: noController });
  await btnByText(body, 'Browse files…').click();
  await btnByText(body, 'Browse folder…').click();
  assert.deepEqual(chipTexts(body), []);
  assert.deepEqual(errTexts(body), []);
});

test('a dialog exception shows a plain message', async () => {
  const body = installDom(tauri(async () => { throw new Error('boom'); }));
  openListEditor({ controller: noController });
  await btnByText(body, 'Browse files…').click();
  assert.deepEqual(errTexts(body), ['Could not open the file dialog. You can still type the program name.']);
});

test('a picked folder becomes a chip with the name as text and the path as title', async () => {
  const body = installDom(tauri(async () => 'C:\\Games\\Foo'));
  openListEditor({ controller: noController });
  await btnByText(body, 'Browse folder…').click();
  assert.deepEqual(chipTexts(body), ['Foo']);
  assert.equal(chips(body)[0].title, 'C:\\Games\\Foo');
  const name = findAll(body, n => n.tag === 'input' && n.attrs.maxlength === '60')[0];
  name.value = 'Games';
  await Promise.all(name.listeners.input.map(f => f()));
  assert.equal(btnByText(body, 'Save').disabled, false);
});

test('a forbidden folder shows its message and adds no chip', async () => {
  const body = installDom(tauri(async () => 'C:\\Windows'));
  openListEditor({ controller: noController });
  await btnByText(body, 'Browse folder…').click();
  assert.deepEqual(chipTexts(body), []);
  assert.deepEqual(errTexts(body), ["That folder is part of Windows and can't be blocked."]);
});

test('save sends folders and shows folder errors', async () => {
  let sent;
  const controller = { saveList: async (a) => { sent = a; return { ok: false, errors: { folders: [{ value: 'C:\\Games\\Foo', message: 'nope' }] } }; } };
  const body = installDom(tauri(async () => 'C:\\Games\\Foo'));
  openListEditor({ controller });
  await btnByText(body, 'Browse folder…').click();
  const name = findAll(body, n => n.tag === 'input' && n.attrs.maxlength === '60')[0];
  name.value = 'Games';
  await btnByText(body, 'Save').click();
  assert.deepEqual(sent.folders, ['C:\\Games\\Foo']);
  assert.ok(findAll(body, n => n.tag === 'li').some(n => n.textContent === 'C:\\Games\\Foo: nope'));
});

test('a duplicate file or folder pick shows Already in this list.', async () => {
  const body = installDom(tauri(async (o) => (o.directory ? 'C:\\Games\\Foo' : ['C:\\a\\steam.exe'])));
  openListEditor({ controller: noController });
  await btnByText(body, 'Browse files…').click();
  await btnByText(body, 'Browse folder…').click();
  assert.deepEqual(errTexts(body), []);
  await btnByText(body, 'Browse files…').click();
  assert.deepEqual(errTexts(body), ['Already in this list.']);
  await btnByText(body, 'Browse folder…').click();
  assert.deepEqual(errTexts(body), ['Already in this list.', 'Already in this list.']); // one per field
  assert.deepEqual(chipTexts(body), ['steam.exe', 'Foo']);
});

test('a folder-only list row on the home screen shows a folder chip, not Empty list', async () => {
  const { mountHome } = await import('../src/modules/focus/ui/home.js');
  const body = installDom(undefined);
  const state = { loaded: true, blocks: [], lists: [{ id: 'l1', name: 'Games', sites: [], apps: [], folders: ['C:\\Games\\Foo'] }], helper: null, notice: null, syncPending: false };
  const controller = { state, refreshStatus() {}, resync() {} };
  const stop = mountHome(body, controller, {}, {});
  try {
    const chipEls = findAll(body, n => n.className === 'fr-chip');
    assert.deepEqual(chipEls.map(c => c.children[0].textContent), ['Foo']);
    assert.equal(chipEls[0].title, 'C:\\Games\\Foo');
    assert.equal(findAll(body, n => n.textContent === 'Empty list').length, 0);
  } finally { stop(); }
});

// --- schedules ---
const NOWMS = Date.UTC(2026, 10, 10, 12, 0); // Tue 12:00 UTC
const isDisabled = (n) => !!n.disabled || n.getAttribute('disabled') !== null;
const byFk = (root, fk) => findAll(root, n => n.getAttribute('data-fk') === fk)[0];
const lists2 = [{ id: 1, name: 'Social', sites: ['x.com'], apps: [], folders: [] }, { id: 2, name: 'Games', sites: [], apps: [], folders: [] }];
const sched = (o) => ({ id: 1, name: '', listIds: [1], weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', lock: 'none', unlockDelayMs: null, endsOn: null, enabled: true, ...o });
const utcTz = () => 0;

test('renderSchedules shows rows, status and disabled controls for a locked schedule', async () => {
  const { renderSchedules } = await import('../src/modules/focus/ui/schedule-list.js');
  const body = installDom(undefined);
  const state = { lists: lists2, schedules: [
    sched({ id: 1, name: 'Work', start: '13:00' }),
    sched({ id: 2, enabled: false, weekdays: [0, 6] }),
    sched({ id: 3, lock: 'locked', unlockDelayMs: 3600000, endsOn: '2026-12-01', start: '11:00', end: '17:00' }),
    sched({ id: 4, lock: 'locked', unlockDelayMs: 3600000, weekdays: [1], endsOn: '2026-11-10', start: '09:00', end: '10:00' }),
  ] };
  const opened = [];
  const el = renderSchedules(state, { nowMs: NOWMS, tzOffsetAt: utcTz, openEditor: (s) => opened.push(s), controller: {}, confirm() {} });
  body.append(el);
  const text = (id) => findAll(el, n => n.getAttribute('data-fk') === `sched-row-${id}`)[0].textContent;
  assert.match(text(1), /Work/);
  assert.match(text(1), /Weekdays, 1:00 PM to 5:00 PM/);
  assert.match(text(1), /Social/);
  assert.match(text(1), /Next: /);
  assert.match(text(2), /Paused/);
  assert.match(text(3), /Blocking now until/);
  assert.match(text(3), /Locked/);
  assert.match(text(3), /2026-12-01/);
  assert.match(text(4), /No more occurrences/);
  for (const k of ['edit', 'toggle', 'delete']) {
    assert.equal(isDisabled(byFk(el, `sched-${k}-3`)), true, k);
    assert.ok(byFk(el, `sched-${k}-3`).title.length > 0, k);
    assert.equal(isDisabled(byFk(el, `sched-${k}-1`)), false, k);
  }
  assert.equal(byFk(el, 'sched-toggle-1').textContent, 'Pause');
  assert.equal(byFk(el, 'sched-toggle-2').textContent, 'Resume');
  await byFk(el, 'sched-edit-1').click();
  assert.equal(opened[0].id, 1);
});

test('renderSchedules empty state and New schedule gating', async () => {
  const { renderSchedules } = await import('../src/modules/focus/ui/schedule-list.js');
  installDom(undefined);
  let opened = 0;
  const mk = (ls) => renderSchedules({ lists: ls, schedules: [] }, { nowMs: NOWMS, tzOffsetAt: utcTz, openEditor: () => { opened++; }, controller: {}, confirm() {} });
  const el = mk(lists2);
  assert.match(el.textContent, /No schedules yet/);
  await byFk(el, 'new-schedule').click();
  assert.equal(opened, 1);
  assert.equal(isDisabled(byFk(mk([]), 'new-schedule')), true);
});

test('pause calls setScheduleEnabled and delete confirms first', async () => {
  const { renderSchedules } = await import('../src/modules/focus/ui/schedule-list.js');
  installDom(undefined);
  const calls = [];
  const controller = { setScheduleEnabled: async (id, en) => { calls.push(['en', id, en]); return { ok: true }; }, deleteSchedule: async (id) => { calls.push(['del', id]); return { ok: true }; } };
  let confirmOpts;
  const results = [];
  const el = renderSchedules({ lists: lists2, schedules: [sched({ id: 1 })] }, { nowMs: NOWMS, tzOffsetAt: utcTz, openEditor() {}, controller, confirm: (o) => { confirmOpts = o; }, onResult: (r) => results.push(r) });
  await byFk(el, 'sched-toggle-1').click();
  assert.deepEqual(calls, [['en', 1, false]]);
  assert.equal(results.length, 1);
  await byFk(el, 'sched-delete-1').click();
  assert.equal(calls.length, 1);
  await confirmOpts.onConfirm();
  assert.deepEqual(calls[1], ['del', 1]);
});

function homeState(extra) {
  return { loaded: true, blocks: [], lists: lists2, schedules: [], helper: null, notice: null, syncPending: false, ...extra };
}

test('home renders the Schedules section and New schedule opens the editor', async () => {
  const { mountHome } = await import('../src/modules/focus/ui/home.js');
  const body = installDom(undefined);
  const opened = [];
  const controller = { state: homeState({ schedules: [sched({ id: 1, name: 'Work' })] }), refreshStatus() {}, resync() {} };
  const stop = mountHome(body, controller, {}, { openScheduleEditor: (o) => opened.push(o) });
  try {
    assert.ok(findAll(body, n => n.getAttribute('data-fk') === 'sched-row-1').length === 1);
    await byFk(body, 'new-schedule').click();
    assert.equal(opened.length, 1);
    assert.equal(opened[0].controller, controller);
    assert.equal(opened[0].schedule, undefined);
    await byFk(body, 'sched-edit-1').click();
    assert.equal(opened[1].schedule.id, 1);
  } finally { stop(); }
});

const schedBlock = (o) => ({ key: 'c1@1', windowId: 'c1@1', lock: 'locked', unlockDelayMs: 3600000, ids: [], listIds: [1], listNames: ['Social'], starts: Date.now() - 1000, ends: Date.now() + 3600000, state: 'running', progress: 0, scheduleId: 1, ...o });

test('schedule block cards keep Unlock early but have no Extend or Cancel', async () => {
  const { mountHome } = await import('../src/modules/focus/ui/home.js');
  const body = installDom(undefined);
  const controller = { state: homeState({ blocks: [schedBlock()] }), refreshStatus() {}, resync() {} };
  const stop = mountHome(body, controller, {}, { openUnlockDialog() {} });
  try {
    assert.ok(byFk(body, 'unlock-0'));
    assert.equal(byFk(body, 'extend-0'), undefined);
    assert.equal(byFk(body, 'cancel-0'), undefined);
  } finally { stop(); }
});

test('a session block still has Extend', async () => {
  const { mountHome } = await import('../src/modules/focus/ui/home.js');
  const body = installDom(undefined);
  const { scheduleId, ...session } = schedBlock({ key: 's1', windowId: undefined, ids: [1] });
  const controller = { state: homeState({ blocks: [session] }), refreshStatus() {}, resync() {} };
  const stop = mountHome(body, controller, {}, {});
  try { assert.ok(byFk(body, 'extend-0')); } finally { stop(); }
});

test('a schedule block the helper no longer holds is not shown (display only)', async () => {
  const { mountHome } = await import('../src/modules/focus/ui/home.js');
  const mk = (helper, syncPending = false) => ({ state: homeState({ blocks: [schedBlock()], helper, syncPending }), refreshStatus() {}, resync() {} });
  const status = (windows) => ({ kind: 'ok', status: { decision: {}, windows, partner_set: true, now_ms: 1000, warnings: [] } });
  const cards = (c) => { const body = installDom(undefined); const stop = mountHome(body, c, {}, {}); const n = findAll(body, x => x.className.includes('fr-block')).length; stop(); return n; };
  assert.equal(cards(mk(status([]))), 0);
  assert.equal(cards(mk(status([{ id: 'c1@1', ends: 500 }]))), 0); // pulled back to now: not held
  assert.equal(cards(mk(status([{ id: 'c1@1', ends: 5000 }]))), 1);
  assert.equal(cards(mk(status([]), true)), 1); // unsent change: keep showing
  assert.equal(cards(mk({ kind: 'not-running' })), 1);
});

const edState = (extra) => ({ state: { lists: lists2, schedules: [], helper: { kind: 'ok', status: {} }, partner: { set: true }, ...extra } });
const inputs = (root, pred) => findAll(root, n => n.tag === 'input' && pred(n));
const typeBtn = (root, t) => findAll(root, n => n.tag === 'button' && n.textContent === t)[0];

test('editor shows controls, and Save with no list shows a listIds error without calling the controller', async () => {
  const { openScheduleEditor } = await import('../src/modules/focus/ui/schedule-editor.js');
  const body = installDom(undefined);
  let saved = 0;
  const controller = { ...edState(), saveSchedule: async () => { saved++; return { ok: true, id: 1 }; } };
  openScheduleEditor({ controller, now: () => NOWMS, tzOffsetAt: utcTz });
  assert.equal(inputs(body, n => n.attrs.type === 'time').length, 2);
  assert.equal(findAll(body, n => n.tag === 'button' && n.attrs['aria-pressed'] !== undefined && n.attrs['data-day'] !== undefined).length, 7);
  assert.ok(typeBtn(body, 'Weekdays'));
  assert.ok(typeBtn(body, 'Every day'));
  await typeBtn(body, 'Save').click();
  assert.equal(saved, 0);
  assert.ok(errTexts(body).includes('Choose at least one list.'));
});

test('Save with valid input calls saveSchedule once with the payload and closes', async () => {
  const { openScheduleEditor } = await import('../src/modules/focus/ui/schedule-editor.js');
  const body = installDom(undefined);
  const sent = [];
  let done = 0;
  const controller = { ...edState(), saveSchedule: async (i) => { sent.push(i); return { ok: true, id: 9 }; } };
  openScheduleEditor({ controller, now: () => NOWMS, tzOffsetAt: utcTz, onDone: () => { done++; } });
  const box = inputs(body, n => n.attrs.type === 'checkbox' && n.attrs['data-list'] === '2')[0];
  box.checked = true;
  await Promise.all(box.listeners.change.map(f => f()));
  const save = typeBtn(body, 'Save');
  await Promise.all([save.click(), save.click()]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { name: '', listIds: [2], weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', lock: 'none', unlockDelayMs: null, endsOn: null });
  assert.equal(done, 1);
  assert.equal(findAll(body, n => n.className.includes('fr-dialog')).length, 0);
});

test('Locked with an empty end date shows the endsOn error; Locked needs the helper', async () => {
  const { openScheduleEditor } = await import('../src/modules/focus/ui/schedule-editor.js');
  const body = installDom(undefined);
  let saved = 0;
  const controller = { ...edState(), saveSchedule: async () => { saved++; return { ok: true, id: 1 }; } };
  openScheduleEditor({ controller, now: () => NOWMS, tzOffsetAt: utcTz });
  const box = inputs(body, n => n.attrs['data-list'] === '1')[0];
  box.checked = true;
  await Promise.all(box.listeners.change.map(f => f()));
  const locked = inputs(body, n => n.attrs.type === 'radio' && n.attrs.value === 'locked')[0];
  locked.checked = true;
  await Promise.all(locked.listeners.change.map(f => f()));
  const endsOn = inputs(body, n => n.attrs.type === 'date')[0];
  assert.equal(endsOn.value, '2026-12-08');
  endsOn.value = '';
  await Promise.all((endsOn.listeners.input || []).map(f => f()));
  await typeBtn(body, 'Save').click();
  assert.equal(saved, 0);
  assert.ok(errTexts(body).includes('A locked schedule needs an end date.'));

  const body2 = installDom(undefined);
  openScheduleEditor({ controller: { ...edState({ helper: null }), saveSchedule() {} }, now: () => NOWMS, tzOffsetAt: utcTz });
  const l2 = inputs(body2, n => n.attrs.type === 'radio' && n.attrs.value === 'locked')[0];
  assert.equal(isDisabled(l2), true);
  assert.ok(findAll(body2, n => n.textContent === 'The helper must be running to lock a schedule.').length > 0);
});

test('server errors from saveSchedule are shown beside the field', async () => {
  const { openScheduleEditor } = await import('../src/modules/focus/ui/schedule-editor.js');
  const body = installDom(undefined);
  const controller = { ...edState(), saveSchedule: async () => ({ ok: false, errors: { name: 'That schedule is locked until 2026-12-01.' } }) };
  openScheduleEditor({ controller, schedule: sched({ id: 3 }), now: () => NOWMS, tzOffsetAt: utcTz });
  await typeBtn(body, 'Save').click();
  assert.ok(errTexts(body).includes('That schedule is locked until 2026-12-01.'));
});

test('a schedule whose lists are all gone says so instead of "Next:"', async () => {
  const { renderSchedules } = await import('../src/modules/focus/ui/schedule-list.js');
  const body = installDom(undefined);
  const el = renderSchedules({ lists: lists2, schedules: [sched({ id: 5, listIds: [99] })] }, { nowMs: NOWMS, tzOffsetAt: utcTz, openEditor() {}, controller: {}, confirm() {} });
  body.append(el);
  const t = findAll(el, n => n.getAttribute('data-fk') === 'sched-row-5')[0].textContent;
  assert.match(t, /Its list was deleted\. It is not blocking\./);
  assert.doesNotMatch(t, /Next:/);
});

test('home maps schedule pause/delete refusals and a locked-schedule list delete to plain text', async () => {
  const { mountHome } = await import('../src/modules/focus/ui/home.js');
  const body = installDom(undefined);
  const s = sched({ id: 1, name: 'Work' });
  const controller = {
    state: homeState({ schedules: [s] }), refreshStatus() {}, resync() {},
    setScheduleEnabled: async () => ({ ok: false, reason: 'locked' }),
    deleteSchedule: async () => ({ ok: false, reason: 'missing' }),
    deleteList: async () => ({ ok: false, reason: 'locked-schedule', lockedUntil: Date.UTC(2026, 11, 1, 12) }),
  };
  const stop = mountHome(body, controller, {}, { openScheduleEditor() {}, openListEditor() {} });
  try {
    await byFk(body, 'sched-toggle-1').click();
    assert.match(body.textContent, /This schedule is locked until \d{4}-|This schedule is locked until its end date\./);
    controller.setScheduleEnabled = async () => ({ ok: false, reason: 'missing' });
    await byFk(body, 'sched-toggle-1').click();
    assert.match(body.textContent, /That schedule no longer exists\./);
    assert.doesNotMatch(body.textContent, /That did not work/);
  } finally { stop(); }
});

test('editor: Locked without a partner shows the partner guidance and blocks Save; Cancel is disabled while busy', async () => {
  const { openScheduleEditor } = await import('../src/modules/focus/ui/schedule-editor.js');
  const body = installDom(undefined);
  let saved = 0; let setups = 0; let notify = () => {}; let unsubbed = 0;
  const controller = { ...edState({ partner: { set: false } }), saveSchedule: async () => { saved++; return { ok: true, id: 1 }; } };
  openScheduleEditor({
    controller, now: () => NOWMS, tzOffsetAt: utcTz,
    openPartnerSetup: () => { setups++; },
    subscribe: (fn) => { notify = fn; return () => { unsubbed++; }; },
  });
  const box = inputs(body, n => n.attrs['data-list'] === '1')[0];
  box.checked = true;
  await Promise.all(box.listeners.change.map(f => f()));
  const locked = inputs(body, n => n.attrs.type === 'radio' && n.attrs.value === 'locked')[0];
  locked.checked = true;
  await Promise.all(locked.listeners.change.map(f => f()));
  assert.ok(findAll(body, n => n.textContent === 'Set up your partner first').length > 0);
  await typeBtn(body, 'Set up your partner first').click();
  assert.equal(setups, 1);
  await Promise.all(inputs(body, n => n.attrs.id?.startsWith('fr-sc-confirm-')).map(c => { c.checked = true; return Promise.all(c.listeners.change.map(f => f())); }));
  await typeBtn(body, 'Save').click();
  assert.equal(saved, 0);
  assert.ok(errTexts(body).some(t => /partner/.test(t)));
  // The partner gets set while the dialog is open: Save goes through.
  controller.state.partner = { set: true };
  notify();
  await typeBtn(body, 'Save').click();
  assert.equal(saved, 1);
  assert.equal(unsubbed, 1);
});

test('editor: Cancel is disabled while a save is pending', async () => {
  const { openScheduleEditor } = await import('../src/modules/focus/ui/schedule-editor.js');
  const body = installDom(undefined);
  let release;
  const controller = { ...edState(), saveSchedule: () => new Promise((r) => { release = r; }) };
  openScheduleEditor({ controller, now: () => NOWMS, tzOffsetAt: utcTz });
  const box = inputs(body, n => n.attrs['data-list'] === '1')[0];
  box.checked = true;
  await Promise.all(box.listeners.change.map(f => f()));
  const p = typeBtn(body, 'Save').click();
  assert.equal(isDisabled(typeBtn(body, 'Cancel')), true);
  release({ ok: false, message: 'Nothing was saved. x' });
  await p;
  assert.equal(isDisabled(typeBtn(body, 'Cancel')), false);
});

test('list editor picks "schedule" or "block" wording from the refusal kind', async () => {
  for (const kind of ['schedule', 'block']) {
    const controller = { saveList: async () => ({ ok: false, errors: { name: 'x' }, kind, lockedUntil: Date.UTC(2026, 11, 1, 12) }) };
    const body = installDom(undefined);
    openListEditor({ controller, list: { id: 1, name: 'L', sites: ['a.com'], apps: [], folders: [] } });
    await btnByText(body, 'Save').click();
    assert.ok(findAll(body, n => /^That list is part of a locked /.test(n.textContent || '') && n.textContent.length < 80).some(n => n.textContent.includes(`locked ${kind} until`)), kind);
  }
});
