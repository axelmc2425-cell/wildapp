import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, findAll } from './helpers/fake-dom.js';
import { renderLimits } from '../src/modules/focus/ui/limit-list.js';
import { openLimitEditor } from '../src/modules/focus/ui/limit-editor.js';
import { mountHome } from '../src/modules/focus/ui/home.js';
import { openUnlockDialog } from '../src/modules/focus/ui/unlock-dialog.js';

const byFk = (root, fk) => findAll(root, (n) => n.getAttribute('data-fk') === fk)[0];
const btn = (root, t) => findAll(root, (n) => n.tag === 'button' && n.textContent === t)[0];
const text = (root) => root.textContent;
const visibleErrs = (root) => findAll(root, (n) => n.className.includes('fr-err') && !n.hidden).map((n) => n.textContent);
const fire = async (el, type, ev = {}) => { await Promise.all((el.listeners[type] || []).map((f) => f({ target: el, preventDefault() {}, ...ev }))); };
const flush = () => new Promise((r) => setImmediate(r));

const lim = (o = {}) => ({
  id: 1, name: 'Social', period: 'daily', capSecs: 7200, lock: 'none', unlockDelayMs: null, enabled: true,
  apps: ['steam.exe'], sites: ['reddit.com'], status: undefined, ...o,
});
const st = (used, cap, extra = {}) => ({ id: 'limit-1', used_secs: used, cap_secs: cap, blocked: used >= cap, ...extra });
const state = (limits, o = {}) => ({ limits, loaded: true, enforcement: true, helperKind: 'ok', pendingUnlocks: [], ...o });
const confirmNow = (calls) => (o) => { calls.push(o); return o.onConfirm(); };
const opts = (o = {}) => ({ controller: {}, confirm: () => {}, openEditor: () => {}, ...o });

// ---- list ----
test('loading and empty states', () => {
  const body = installDom();
  body.append(renderLimits(state([], { loaded: false }), opts()));
  assert.match(text(body), /Loading/);
  const b2 = installDom();
  b2.append(renderLimits(state([]), opts()));
  assert.match(text(b2), /No time limits yet/);
});

test('a row shows name, items, period, cap and the exact time left with a progressbar', () => {
  const body = installDom();
  body.append(renderLimits(state([lim({ status: st(2400, 7200) })]), opts()));
  const t = text(body);
  assert.match(t, /Social/);
  assert.match(t, /reddit\.com/);
  assert.match(t, /steam\.exe/);
  assert.match(t, /Daily/);
  assert.match(t, /2h 0m/);
  assert.match(t, /1h 20m left/);
  const bar = findAll(body, (n) => n.getAttribute('role') === 'progressbar')[0];
  assert.equal(bar.getAttribute('aria-valuemin'), '0');
  assert.equal(bar.getAttribute('aria-valuemax'), '7200');
  assert.equal(bar.getAttribute('aria-valuenow'), '2400');
  assert.match(bar.getAttribute('aria-valuetext'), /1h 20m left/);
  assert.ok(byFk(body, 'limit-row-1') && byFk(body, 'limit-edit-1') && byFk(body, 'limit-toggle-1') && byFk(body, 'limit-delete-1'));
});

test('with usage tracking off the row says not counting and draws no bar or time left', () => {
  const body = installDom();
  body.append(renderLimits(state([lim({ status: st(2400, 7200) })], { trackingOff: true }), opts()));
  assert.match(text(body), /Not counting right now/);
  assert.doesNotMatch(text(body), /left/);
  assert.equal(findAll(body, (n) => n.getAttribute('role') === 'progressbar').length, 0);
});

test('a used up limit shows the blocked badge and when it is back', () => {
  const body = installDom();
  body.append(renderLimits(state([lim({ status: st(7200, 7200, { period_ends_day: '2026-11-15' }) })]), opts()));
  assert.match(text(body), /Used up, back on 2026-11-15/);
  assert.ok(findAll(body, (n) => n.className.includes('fr-limit-blocked'))[0]);
});

test('a locked limit shows the lock badge', () => {
  const body = installDom();
  body.append(renderLimits(state([lim({ lock: 'locked', unlockDelayMs: 86400000, status: st(0, 7200) })]), opts()));
  assert.match(text(body), /Locked/);
});

test('helper down: enforcement message, no usage numbers and no bars', () => {
  const body = installDom();
  body.append(renderLimits(state([lim({ status: st(2400, 7200) })], { enforcement: false, helperKind: 'not-running' }), opts()));
  assert.match(text(body), /Enforcement is not running/);
  assert.doesNotMatch(text(body), /left|Used/);
  assert.equal(findAll(body, (n) => n.getAttribute('role') === 'progressbar').length, 0);
});

test('no status yet says waiting; paused says paused with Resume', () => {
  const body = installDom();
  body.append(renderLimits(state([lim({ id: 1 }), lim({ id: 2, name: 'Games', enabled: false, status: st(0, 7200) })]), opts()));
  assert.match(text(byFk(body, 'limit-row-1')), /Waiting for the helper/);
  assert.match(text(byFk(body, 'limit-row-2')), /Paused/);
  assert.equal(byFk(body, 'limit-toggle-2').textContent, 'Resume');
  assert.equal(byFk(body, 'limit-toggle-1').textContent, 'Pause');
  assert.equal(findAll(byFk(body, 'limit-row-2'), (n) => n.getAttribute('role') === 'progressbar').length, 0);
});

test('no NaN or undefined text even for odd status data', () => {
  const body = installDom();
  body.append(renderLimits(state([lim({ status: { used_secs: NaN, cap_secs: undefined, blocked: false } }), lim({ id: 2, status: st(0, 7200) })]), opts()));
  assert.doesNotMatch(text(body), /NaN|undefined|null/);
});

test('pause calls setLimitEnabled; a locked limit that needs unlock opens the unlock', async () => {
  const calls = [];
  const unlocks = [];
  const controller = { setLimitEnabled: async (id, en) => { calls.push([id, en]); return { ok: false, needsUnlock: true, limitId: id }; } };
  const body = installDom();
  const l = lim({ lock: 'locked', unlockDelayMs: 3600000 });
  body.append(renderLimits(state([l]), opts({ controller, openUnlock: (x) => unlocks.push(x) })));
  await byFk(body, 'limit-toggle-1').click();
  assert.deepEqual(calls, [[1, false]]);
  assert.equal(unlocks.length, 1);
  assert.equal(unlocks[0].id, 1);
});

test('delete asks for confirmation first', async () => {
  const deleted = [];
  const confirms = [];
  const controller = { deleteLimit: async (id) => { deleted.push(id); return { ok: true }; } };
  const body = installDom();
  body.append(renderLimits(state([lim()]), opts({ controller, confirm: (o) => confirms.push(o) })));
  await byFk(body, 'limit-delete-1').click();
  assert.equal(confirms.length, 1);
  assert.deepEqual(deleted, []);
  await confirms[0].onConfirm();
  assert.deepEqual(deleted, [1]);
});

test('delete of a locked limit that needs unlock opens the unlock', async () => {
  const unlocks = [];
  const confirms = [];
  const controller = { deleteLimit: async (id) => ({ ok: false, needsUnlock: true, limitId: id }) };
  const body = installDom();
  body.append(renderLimits(state([lim({ lock: 'locked', unlockDelayMs: 3600000 })]), opts({ controller, confirm: confirmNow(confirms), openUnlock: (x) => unlocks.push(x) })));
  await byFk(body, 'limit-delete-1').click();
  await flush();
  assert.equal(unlocks.length, 1);
});

// ---- editor ----
const nameIn = (b) => findAll(b, (n) => n.tag === 'input' && n.attrs.maxlength === '64')[0];
const field = (b, key) => findAll(b, (n) => n.tag === 'input' && n.getAttribute('data-field') === key)[0];
const radio = (b, v) => findAll(b, (n) => n.tag === 'input' && n.attrs.type === 'radio' && n.attrs.value === v)[0];
async function addChip(b, kind, value) {
  const i = field(b, kind);
  i.value = value;
  await fire(i, 'keydown', { key: 'Enter' });
}
const confirmEl = (b) => findAll(b, (n) => n.tag === 'input' && n.attrs.type === 'checkbox')[0];
async function tick(b) { const c = confirmEl(b); c.checked = true; await fire(c, 'change'); }
const okState = { partner: { set: true }, helper: { kind: 'ok' } };
async function fill(b, hours = '1') {
  nameIn(b).value = 'Social';
  await addChip(b, 'site', 'reddit.com');
  field(b, 'hours').value = hours; field(b, 'minutes').value = '0';
}
async function pick(b, r) { r.checked = true; await fire(r, 'change'); }

test('editor validation: no items, cap 0, daily over 24 h', async () => {
  const body = installDom();
  let saved = 0;
  openLimitEditor({ saveLimit: async () => { saved++; return { ok: true }; }, state: { partner: { set: true }, helper: { kind: 'ok' } } }, null, {});
  nameIn(body).value = 'Social';
  field(body, 'hours').value = '0';
  field(body, 'minutes').value = '0';
  await btn(body, 'Save').click();
  assert.ok(visibleErrs(body).includes('Add at least one app or site.'));
  assert.ok(visibleErrs(body).includes('Choose between 1 minute and 24 hours.'));
  await addChip(body, 'site', 'reddit.com');
  field(body, 'hours').value = '25';
  field(body, 'minutes').value = '0';
  await btn(body, 'Save').click();
  assert.deepEqual(visibleErrs(body), ['Choose between 1 minute and 24 hours.']);
  assert.equal(saved, 0);
  await pick(body, radio(body, 'weekly'));
  await btn(body, 'Save').click();
  assert.equal(saved, 1);
});

test('editor saves the expected object and closes', async () => {
  const body = installDom();
  let sent; let done = 0;
  openLimitEditor({ saveLimit: async (l) => { sent = l; return { ok: true }; }, state: { partner: { set: true }, helper: { kind: 'ok' } } }, null, { onDone: () => done++ });
  nameIn(body).value = ' Social ';
  await addChip(body, 'site', 'Reddit.com');
  await addChip(body, 'app', 'steam.exe');
  field(body, 'hours').value = '1';
  field(body, 'minutes').value = '30';
  await btn(body, 'Save').click();
  assert.deepEqual(sent, { name: 'Social', period: 'daily', capSecs: 5400, lock: 'none', unlockDelayMs: null, apps: ['steam.exe'], sites: ['reddit.com'] });
  assert.equal(done, 1);
  assert.equal(findAll(body, (n) => n.className === 'fr-overlay').length, 0);
});

test('locked choice shows the waiting period (default 24 h) only when locked', async () => {
  const body = installDom();
  let sent;
  openLimitEditor({ saveLimit: async (l) => { sent = l; return { ok: true }; }, state: { partner: { set: true }, helper: { kind: 'ok' } } }, null, {});
  const opts = findAll(body, (n) => n.className.includes('fr-st-lockedopts'))[0];
  assert.equal(opts.hidden, true);
  await pick(body, radio(body, 'locked'));
  assert.equal(opts.hidden, false);
  const pressed = findAll(opts, (n) => n.getAttribute('aria-pressed') === 'true').map((n) => n.textContent);
  assert.deepEqual(pressed, ['24 h']);
  nameIn(body).value = 'Social';
  await addChip(body, 'site', 'reddit.com');
  field(body, 'hours').value = '2'; field(body, 'minutes').value = '';
  await tick(body);
  await btn(body, 'Save').click();
  assert.equal(sent.lock, 'locked');
  assert.equal(sent.unlockDelayMs, 24 * 3600000);
});

test('a helper error is shown beside the field it names, and the editor stays open', async () => {
  const body = installDom();
  openLimitEditor({ saveLimit: async () => ({ ok: false, errors: { items: 'One of the apps or sites is not valid.' } }), state: { partner: { set: true }, helper: { kind: 'ok' } } }, null, {});
  nameIn(body).value = 'Social';
  await addChip(body, 'site', 'reddit.com');
  field(body, 'hours').value = '1';
  await btn(body, 'Save').click();
  const err = findAll(body, (n) => n.className.includes('fr-err') && !n.hidden)[0];
  assert.equal(err.textContent, 'One of the apps or sites is not valid.');
  assert.equal(err.getAttribute('data-err'), 'items');
  assert.equal(findAll(body, (n) => n.className === 'fr-overlay').length, 1);
});

test('an unconfirmed save shows the warning and does not hide it by closing silently', async () => {
  const body = installDom();
  let got;
  openLimitEditor({ saveLimit: async () => ({ ok: true, unconfirmed: true, message: 'Saved, but the helper could not be reached.', warning: 'Saved, but the helper could not be reached.' }), state: { partner: { set: true }, helper: { kind: 'ok' } } }, null, { onDone: (r) => { got = r; } });
  nameIn(body).value = 'Social';
  await addChip(body, 'site', 'reddit.com');
  field(body, 'hours').value = '1';
  await btn(body, 'Save').click();
  assert.equal(got.unconfirmed, true);
  assert.equal(got.warning, 'Saved, but the helper could not be reached.');
});

test('weakening a locked limit opens the unlock dialog for it and saves nothing else', async () => {
  const body = installDom();
  const unlocks = [];
  const l = lim({ lock: 'locked', unlockDelayMs: 3600000 });
  const controller = {
    saveLimit: async () => ({ ok: false, needsUnlock: true, limitId: 1 }),
    state: { partner: { set: true }, helper: { kind: 'ok' }, limitsState: { limits: [l] } },
  };
  let done = 0;
  openLimitEditor(controller, l, { onDone: () => done++, openUnlockDialog: (o) => unlocks.push(o) });
  assert.equal(nameIn(body).value, 'Social');
  field(body, 'hours').value = '5';
  await btn(body, 'Save').click();
  assert.equal(unlocks.length, 1);
  assert.equal(unlocks[0].block.key, 'limit-1');
  assert.equal(unlocks[0].block.lock, 'locked');
  assert.equal(done, 0);
  assert.equal(findAll(body, (n) => n.className === 'fr-overlay').length, 1);
});

test('editor delete asks for confirmation, then deletes', async () => {
  const body = installDom();
  const deleted = [];
  const controller = { deleteLimit: async (id) => { deleted.push(id); return { ok: true }; }, state: { partner: { set: true }, helper: { kind: 'ok' } } };
  openLimitEditor(controller, lim(), {});
  await btn(body, 'Delete').click();
  assert.deepEqual(deleted, []);
  const yes = findAll(body, (n) => n.tag === 'button' && n.textContent === 'Delete' && n.className.includes('primary'))[0];
  await yes.click();
  assert.deepEqual(deleted, [1]);
});

test('editor delete that needs an unlock says you can delete it now, not save again', async () => {
  const body = installDom();
  let unlockOpts;
  const controller = { deleteLimit: async (id) => ({ ok: false, needsUnlock: true, limitId: id }), state: { partner: { set: true }, helper: { kind: 'ok' }, limitsState: { limits: [lim({ lock: 'locked', unlockDelayMs: 3600000 })] } } };
  openLimitEditor(controller, lim({ lock: 'locked', unlockDelayMs: 3600000 }), { openUnlockDialog: (o) => { unlockOpts = o; } });
  await btn(body, 'Delete').click();
  const yes = findAll(body, (n) => n.tag === 'button' && n.textContent === 'Delete' && n.className.includes('primary'))[0];
  await yes.click();
  unlockOpts.onDone({ ok: true });
  assert.match(text(body), /Unlocked\. You can delete it now\./);
  assert.doesNotMatch(text(body), /Save again/);
});

test('editor for an existing limit fills the fields and keeps the id', async () => {
  const body = installDom();
  let sent;
  openLimitEditor({ saveLimit: async (l) => { sent = l; return { ok: true }; }, state: { partner: { set: true }, helper: { kind: 'ok' } } }, lim({ period: 'weekly', capSecs: 36000 }), {});
  assert.equal(field(body, 'hours').value, '10');
  assert.equal(field(body, 'minutes').value, '0');
  assert.equal(radio(body, 'weekly').checked, true);
  await btn(body, 'Save').click();
  assert.equal(sent.id, 1);
  assert.equal(sent.capSecs, 36000);
  assert.deepEqual(sent.sites, ['reddit.com']);
});

// ---- unlock dialog for a limit ----
test('the unlock dialog works for a limit block and stays open for it', async () => {
  const body = installDom();
  const calls = [];
  let sub;
  const controller = {
    state: { helper: { kind: 'ok', status: {} }, blocks: [], partner: { name: 'Sam' }, limitsState: { limits: [lim({ lock: 'locked' })], pendingUnlocks: [{ window_id: 'limit-1', unlock_at: Date.now() + 1000 }] } },
    requestPartnerChallenge: async (k) => { calls.push(k); return { ok: true, code: 'abc' }; },
  };
  openUnlockDialog({ controller, block: { key: 'limit-1', windowId: 'limit-1', lock: 'locked', limit: true, title: 'Social', unlockDelayMs: 86400000 }, subscribe: (f) => { sub = f; return () => {}; } });
  assert.match(text(body), /Unlocks at/);
  assert.match(text(body), /Social/);
  await byFk(body, 'un-getcode').click();
  assert.deepEqual(calls, ['limit-1']);
  sub();
  assert.equal(findAll(body, (n) => n.className === 'fr-overlay').length, 1);
  controller.state.limitsState.limits = [];
  sub();
  assert.equal(findAll(body, (n) => n.className === 'fr-overlay').length, 0);
});

// ---- home ----
function homeController(ls, over = {}) {
  return {
    state: { loaded: true, blocks: [], lists: [], schedules: [], helper: { kind: 'ok', status: { windows: [], now_ms: 0 } }, notice: null, syncPending: false, partner: { set: true }, limitsState: ls, ...over },
    refreshStatus() {}, resync() {}, refreshLimits() {},
  };
}

test('home mounts a Time limits section under Schedules with an Add limit button', async () => {
  const body = installDom();
  const opened = [];
  const stop = mountHome(body, homeController({ limits: [lim({ status: st(0, 7200) })], pendingUnlocks: [], loaded: true, enforcement: true }), {}, { openLimitEditor: (c, l) => { opened.push(l); } });
  try {
    const t = text(body);
    assert.ok(t.indexOf('Schedules') < t.indexOf('Time limits'));
    assert.match(t, /2h 0m left/);
    await byFk(body, 'limit-add').click();
    assert.equal(opened.length, 1);
    assert.equal(opened[0], null);
    await byFk(body, 'limit-edit-1').click();
    assert.equal(opened[1].id, 1);
  } finally { stop(); }
});

test('home shows the empty state and keeps focus on the same limit control across a re-render', async () => {
  const body = installDom();
  const ctl = homeController({ limits: [lim({ status: st(0, 7200) })], pendingUnlocks: [], loaded: true, enforcement: true });
  let sub;
  const stop = mountHome(body, ctl, {}, { subscribe: (f) => { sub = f; return () => {}; }, openLimitEditor() {} });
  try {
    byFk(body, 'limit-toggle-1').focus();
    ctl.state.limitsState = { ...ctl.state.limitsState, limits: [lim({ status: st(600, 7200) })] };
    sub();
    assert.match(text(body), /1h 50m left/);
    assert.equal(document.activeElement.getAttribute('data-fk'), 'limit-toggle-1');
  } finally { stop(); }
  const b2 = installDom();
  const stop2 = mountHome(b2, homeController({ limits: [], pendingUnlocks: [], loaded: true, enforcement: true }), {}, {});
  try { assert.match(text(b2), /No time limits yet/); } finally { stop2(); }
});

test('home without limit state still renders', () => {
  const body = installDom();
  const stop = mountHome(body, homeController(undefined), {}, {});
  try { assert.match(text(body), /Schedules/); } finally { stop(); }
});

// ---- review round 1 ----
test('locking needs the confirm box; changing the waiting period or the mode resets it', async () => {
  const body = installDom();
  let saves = 0;
  openLimitEditor({ saveLimit: async () => { saves++; return { ok: true }; }, state: okState }, null, {});
  await fill(body);
  await pick(body, radio(body, 'locked'));
  await btn(body, 'Save').click();
  assert.ok(visibleErrs(body).includes('Tick the box to confirm the lock.'));
  assert.equal(saves, 0);
  await tick(body);
  const chip6 = btn(body, '6 h');
  await chip6.click();
  assert.equal(confirmEl(body).checked, false);
  await btn(body, 'Save').click();
  assert.equal(saves, 0);
  await tick(body);
  field(body, 'delay').value = '12';
  await fire(field(body, 'delay'), 'input');
  assert.equal(confirmEl(body).checked, false);
  await tick(body);
  await pick(body, radio(body, 'none')); await pick(body, radio(body, 'locked'));
  assert.equal(confirmEl(body).checked, false);
  await tick(body);
  await btn(body, 'Save').click();
  assert.equal(saves, 1);
});

test('tightening an already locked limit needs no confirm box', async () => {
  const body = installDom();
  let sent;
  const l = lim({ lock: 'locked', unlockDelayMs: 3600000 });
  openLimitEditor({ saveLimit: async (x) => { sent = x; return { ok: true }; }, state: { ...okState, limitsState: { limits: [l] } } }, l, {});
  assert.match(text(body), /Making this weaker needs your partner or the wait/);
  field(body, 'hours').value = '1';
  await btn(body, 'Save').click();
  assert.equal(sent.capSecs, 3600);
});

test('Locked is disabled with a hint when the helper is down, and no helper kind counts as down', () => {
  for (const helper of [{ kind: 'not-running' }, undefined]) {
    const body = installDom();
    openLimitEditor({ saveLimit: async () => ({ ok: true }), state: { partner: { set: true }, helper } }, null, {});
    assert.equal(radio(body, 'locked').disabled, true);
    assert.match(text(body), /The helper must be running to lock a limit\./);
  }
});

async function unlockedEditor(helper = { kind: 'ok' }) {
  const body = installDom();
  const l = lim({ lock: 'locked', unlockDelayMs: 3600000 });
  let unlockOpts; const sent = []; let unlockCalls = 0;
  const controller = {
    state: { partner: { set: true }, helper, limitsState: { limits: [l] } },
    saveLimit: async (x) => {
      const cur = controller.state.limitsState.limits[0];
      if (cur.lock === 'locked') return { ok: false, needsUnlock: true, limitId: 1 };
      sent.push(x); return { ok: true };
    },
  };
  let done = 0;
  openLimitEditor(controller, l, { onDone: () => done++, openUnlockDialog: (o) => { unlockCalls++; unlockOpts = o; } });
  field(body, 'hours').value = '5';
  await addChip(body, 'site', 'x.com');
  await btn(body, 'Save').click();
  controller.state.limitsState.limits = [lim()];
  unlockOpts.onDone({ ok: true });
  return { body, controller, sent, calls: () => unlockCalls, done: () => done };
}

test('unlock then retry: the editor stays open with the edits; the lock must be confirmed again', async () => {
  const { body, sent, done } = await unlockedEditor();
  assert.match(text(body), /Unlocked\. Save again to apply your changes\./);
  assert.equal(findAll(body, (n) => n.className === 'fr-overlay').length, 1);
  assert.equal(field(body, 'hours').value, '5');
  assert.equal(confirmEl(body).checked, false);
  await btn(body, 'Save').click();
  assert.ok(visibleErrs(body).includes('Tick the box to confirm the lock.'));
  assert.equal(sent.length, 0);
  await tick(body);
  await btn(body, 'Save').click();
  assert.equal(done(), 1);
  assert.deepEqual(sent[0].sites, ['reddit.com', 'x.com']);
});

test('after an unlock, Locked -> Normal -> Locked still needs the tick', async () => {
  const { body, sent } = await unlockedEditor();
  await tick(body);
  await pick(body, radio(body, 'none')); await pick(body, radio(body, 'locked'));
  await btn(body, 'Save').click();
  assert.ok(visibleErrs(body).includes('Tick the box to confirm the lock.'));
  assert.equal(sent.length, 0);
});

test('after an unlock with the helper down, Locked is disabled and not saved', async () => {
  const { body, controller, sent } = await unlockedEditor();
  controller.state.helper = { kind: 'not-running' };
  await pick(body, radio(body, 'none')); // any change re-runs refresh
  assert.equal(radio(body, 'locked').disabled, true);
  assert.match(text(body), /The helper must be running to lock a limit\./);
  await btn(body, 'Save').click();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].lock, 'none');
});

test('a weakening save after the unlock does not open the unlock again', async () => {
  const { body, calls, sent } = await unlockedEditor();
  assert.equal(calls(), 1);
  await tick(body);
  field(body, 'hours').value = '10';
  await btn(body, 'Save').click();
  assert.equal(calls(), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].capSecs, 36000);
});

test('cap parsing: decimals, negatives, text, huge numbers, zero', async () => {
  for (const [h_, m_, msg] of [
    ['1.5', '0', 'Enter whole numbers for hours and minutes.'],
    ['-1', '0', 'Enter whole numbers for hours and minutes.'],
    ['abc', '', 'Enter whole numbers for hours and minutes.'],
    ['99999999999999999999', '0', 'Choose between 1 minute and 24 hours.'],
    ['0', '0', 'Choose between 1 minute and 24 hours.'],
  ]) {
    const body = installDom();
    let saved = 0;
    openLimitEditor({ saveLimit: async () => { saved++; return { ok: true }; }, state: okState }, null, {});
    await fill(body, h_); field(body, 'minutes').value = m_;
    await btn(body, 'Save').click();
    assert.deepEqual(visibleErrs(body), [msg], `${h_}:${m_}`);
    assert.equal(saved, 0);
  }
});

test('the delay error path: a bad custom wait is shown beside the delay field', async () => {
  const body = installDom();
  openLimitEditor({ saveLimit: async () => ({ ok: true }), state: okState }, null, {});
  await fill(body);
  await pick(body, radio(body, 'locked'));
  field(body, 'delay').value = '500';
  await fire(field(body, 'delay'), 'input');
  await tick(body);
  await btn(body, 'Save').click();
  const e = findAll(body, (n) => n.className.includes('fr-err') && !n.hidden)[0];
  assert.equal(e.getAttribute('data-err'), 'delay');
  assert.match(e.textContent, /1 to 168/);
});

test('used above the cap clamps the bar value', () => {
  const body = installDom();
  body.append(renderLimits(state([lim({ status: st(9000, 7200) })]), opts()));
  const bar = findAll(body, (n) => n.getAttribute('role') === 'progressbar')[0];
  assert.equal(bar.getAttribute('aria-valuenow'), '7200');
  assert.equal(bar.getAttribute('aria-valuemax'), '7200');
});

test('helper down is driven by helperKind even when enforcement is true; a missing kind counts as down', () => {
  for (const helperKind of ['not-running', undefined]) {
    const body = installDom();
    body.append(renderLimits(state([lim({ status: st(2400, 7200) })], { enforcement: true, helperKind }), opts()));
    assert.match(text(body), /Enforcement is not running/);
    assert.doesNotMatch(text(body), /left/);
    assert.equal(findAll(body, (n) => n.getAttribute('role') === 'progressbar').length, 0);
  }
});

test('home tracks dialogs opened from the editor and closes them on unmount', () => {
  const body = installDom();
  let closed = 0; let editorOpts; let unlockClosed = 0;
  const stop = mountHome(body, homeController({ limits: [lim()], pendingUnlocks: [], loaded: true, enforcement: true }), {}, {
    openLimitEditor: (c, l, o) => { editorOpts = o; return { close: () => { closed++; } }; },
    openUnlockDialog: () => ({ close: () => { unlockClosed++; } }),
  });
  byFk(body, 'limit-add').click();
  editorOpts.openUnlockDialog({ block: {} });
  stop();
  assert.equal(closed, 1);
  assert.equal(unlockClosed, 1);
});
