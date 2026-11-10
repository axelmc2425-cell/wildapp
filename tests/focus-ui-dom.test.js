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
