import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, findAll } from './helpers/fake-dom.js';
import { mountUninstallSection } from '../src/modules/focus/ui/uninstall-section.js';
import { openUnlockDialog } from '../src/modules/focus/ui/unlock-dialog.js';
import { mountHome } from '../src/modules/focus/ui/home.js';

const H = 3600000;
const byFk = (root, fk) => findAll(root, (n) => n.getAttribute('data-fk') === fk)[0];
const dis = (el) => el.disabled === true || el.getAttribute('disabled') !== null;
const text = (root) => root.textContent;
const flush = () => new Promise((r) => setImmediate(r));
const fire = async (el, type, ev = {}) => { await Promise.all((el.listeners[type] || []).map((f) => f({ target: el, preventDefault() {}, ...ev }))); await flush(); };
const alerts = (root) => findAll(root, (n) => n.getAttribute('role') === 'alert' && !n.hidden && n.textContent !== '').map((n) => n.textContent);

function fake(o = {}) {
  const calls = [];
  const ctl = {
    calls,
    state: {
      helper: { kind: 'ok', status: {} },
      partner: { set: true, name: 'Sam' },
      uninstall: { waitMs: 24 * H, pendingAt: null, permitUntil: null, known: true },
      blocks: [], limitsState: { limits: [], pendingUnlocks: [], loaded: true, enforcement: true },
      ...o,
    },
  };
  for (const m of ['uninstallRequestDelay', 'uninstallCancelDelay', 'uninstallSetWait', 'uninstallChallenge', 'uninstallSubmitToken']) {
    ctl[m] = async (...a) => { calls.push([m, ...a]); return ctl.results?.[m] || { ok: true, code: 'CODE-1', unlockAt: 5 }; };
  }
  return ctl;
}
function mount(ctl, deps = {}) {
  const body = installDom();
  const listeners = [];
  const cleanup = mountUninstallSection(body, ctl, { subscribe: (f) => { listeners.push(f); return () => { listeners.splice(listeners.indexOf(f), 1); }; }, tzOffsetAt: () => 0, ...deps });
  return { body, cleanup, listeners };
}
const noBad = (t) => assert.doesNotMatch(t, /undefined|NaN|null|\[object/);

test('protected state shows text, wait button, partner button and wait control', () => {
  const { body, cleanup } = mount(fake());
  const t = text(body);
  assert.match(t, /Uninstall protection/);
  assert.match(t, /Uninstall is protected/);
  assert.equal(byFk(body, 'un-wait').textContent, 'Start the waiting period (24 h)');
  assert.equal(byFk(body, 'un-partner').textContent, 'Ask for a partner code');
  assert.equal(byFk(body, 'un-cancel'), undefined);
  assert.ok(!dis(byFk(body, 'un-wait')));
  noBad(t);
  cleanup();
});

test('the wait control offers presets, selects the current one and adds a custom value', () => {
  const a = mount(fake());
  const opts = findAll(byFk(a.body, 'un-setwait'), (n) => n.tag === 'option');
  assert.deepEqual(opts.map((o) => o.textContent), ['1 h', '6 h', '24 h', '48 h', '7 days']);
  assert.equal(byFk(a.body, 'un-setwait').value, String(24 * H));
  a.cleanup();
  const b = mount(fake({ uninstall: { waitMs: 10 * H, pendingAt: null, permitUntil: null, known: true } }));
  const o2 = findAll(byFk(b.body, 'un-setwait'), (n) => n.tag === 'option').map((o) => o.textContent);
  assert.ok(o2.includes('10 h'));
  assert.equal(byFk(b.body, 'un-setwait').value, String(10 * H));
  b.cleanup();
});

test('pending shows a countdown and Cancel, and disables Start', () => {
  const ctl = fake({ uninstall: { waitMs: 24 * H, pendingAt: Date.now() + 2 * H + 5 * 60000, permitUntil: null, known: true } });
  const { body, cleanup } = mount(ctl);
  assert.match(text(body), /Waiting period running/);
  assert.match(text(body), /2h \d\dm/);
  assert.ok(byFk(body, 'un-cancel'));
  assert.ok(dis(byFk(body, 'un-wait')));
  cleanup();
});

test('permit active shows the allowed-until text and no Start button', () => {
  const ctl = fake({ uninstall: { waitMs: 24 * H, pendingAt: null, permitUntil: Date.now() + 20 * 60000, known: true } });
  const { body, cleanup } = mount(ctl);
  assert.match(text(body), /You can uninstall until \d\d:\d\d/);
  assert.ok(!byFk(body, 'un-wait') || dis(byFk(body, 'un-wait')));
  assert.doesNotMatch(text(body), /Start the waiting period/);
  cleanup();
});

test('no partner: explanation and no partner button', () => {
  const { body, cleanup } = mount(fake({ partner: { set: false, name: null } }));
  assert.equal(byFk(body, 'un-partner'), undefined);
  assert.match(text(body), /Add a partner/);
  assert.ok(byFk(body, 'un-wait'));
  cleanup();
});

test('helper down: not running, controls disabled, no countdown or protection claims', () => {
  const ctl = fake({ helper: { kind: 'not-running' }, uninstall: { waitMs: 24 * H, pendingAt: null, permitUntil: null, known: false } });
  const { body, cleanup } = mount(ctl);
  assert.match(text(body), /Enforcement is not running/);
  assert.doesNotMatch(text(body), /protected|You can uninstall/i);
  for (const fk of ['un-wait', 'un-setwait']) assert.ok(dis(byFk(body, fk)), fk);
  assert.equal(byFk(body, 'un-partner'), undefined);
  assert.equal(byFk(body, 'un-cancel'), undefined);
  noBad(text(body));
  cleanup();
});

test('Start the waiting period and Cancel call the controller', async () => {
  const ctl = fake();
  const { body, cleanup } = mount(ctl);
  await fire(byFk(body, 'un-wait'), 'click');
  assert.deepEqual(ctl.calls, [['uninstallRequestDelay']]);
  cleanup();
  const c2 = fake({ uninstall: { waitMs: 24 * H, pendingAt: Date.now() + H, permitUntil: null, known: true } });
  const m = mount(c2);
  await fire(byFk(m.body, 'un-cancel'), 'click');
  assert.deepEqual(c2.calls, [['uninstallCancelDelay']]);
  m.cleanup();
});

test('raising the wait calls uninstallSetWait', async () => {
  const ctl = fake();
  const { body, cleanup } = mount(ctl);
  const sel = byFk(body, 'un-setwait');
  sel.value = String(48 * H);
  await fire(sel, 'change');
  assert.deepEqual(ctl.calls, [['uninstallSetWait', 48 * H]]);
  cleanup();
});

test('lowering the wait saves nothing and opens the dialog for the uninstall target', async () => {
  const ctl = fake();
  const opened = [];
  const { body, cleanup } = mount(ctl, { openUnlockDialog: (o) => { opened.push(o); return { close() {} }; } });
  const sel = byFk(body, 'un-setwait');
  sel.value = String(6 * H);
  await fire(sel, 'change');
  assert.equal(ctl.calls.length, 0);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].block.uninstall, true);
  assert.match(text(body), /needs a permit/);
  assert.equal(byFk(body, 'un-setwait').value, String(24 * H));
  cleanup();
});

test('lowering with a live permit saves directly', async () => {
  const ctl = fake({ uninstall: { waitMs: 24 * H, pendingAt: null, permitUntil: Date.now() + 10 * 60000, known: true } });
  const { body, cleanup } = mount(ctl, { openUnlockDialog: () => assert.fail('no dialog') });
  const sel = byFk(body, 'un-setwait');
  sel.value = String(6 * H);
  await fire(sel, 'change');
  assert.deepEqual(ctl.calls, [['uninstallSetWait', 6 * H]]);
  cleanup();
});

test('errors from the controller show inline', async () => {
  const ctl = fake();
  ctl.results = { uninstallSetWait: { ok: false, message: 'Needs a permit first.', code: 'needs-permit' }, uninstallRequestDelay: { ok: false, message: 'Helper unreachable.', code: 'unreachable' } };
  const { body, cleanup } = mount(ctl);
  const sel = byFk(body, 'un-setwait');
  sel.value = String(48 * H);
  await fire(sel, 'change');
  assert.deepEqual(alerts(body), ['Needs a permit first.']);
  await fire(byFk(body, 'un-wait'), 'click');
  assert.deepEqual(alerts(body), ['Helper unreachable.']);
  cleanup();
});

test('the partner button opens the dialog and its success shows the accepted text', async () => {
  const ctl = fake();
  let opts;
  const { body, cleanup } = mount(ctl, { openUnlockDialog: (o) => { opts = o; return { close() {} }; } });
  await fire(byFk(body, 'un-partner'), 'click');
  assert.equal(opts.block.uninstall, true);
  opts.onDone({ ok: true });
  assert.match(text(body), /Your partner's code was accepted\. You can uninstall for the next 30 minutes\./);
  cleanup();
});

test('a countdown ticks once a second and cleanup stops every timer', async () => {
  const set = globalThis.setInterval, clr = globalThis.clearInterval;
  const live = new Set();
  let fn;
  globalThis.setInterval = (f) => { const id = Symbol(); live.add(id); fn = f; return id; };
  globalThis.clearInterval = (id) => { live.delete(id); };
  try {
    let t0 = Date.now();
    const ctl = fake({ uninstall: { waitMs: 24 * H, pendingAt: t0 + 3 * 60000, permitUntil: null, known: true } });
    const { body, cleanup } = mount(ctl, { now: () => t0 });
    const before = text(body);
    assert.match(before, /3m 00s/);
    t0 += 5000;
    fn();
    assert.match(text(body), /2m 55s/);
    assert.equal(live.size, 1);
    cleanup();
    assert.equal(live.size, 0);
    // permit state: no timer at all
    const m = mount(fake({ uninstall: { waitMs: 24 * H, pendingAt: null, permitUntil: Date.now() + 60000, known: true } }));
    assert.equal(live.size, 0);
    m.cleanup();
  } finally { globalThis.setInterval = set; globalThis.clearInterval = clr; }
});

test('subscribe updates re-render and cleanup unsubscribes', () => {
  const ctl = fake();
  const m = mount(ctl);
  assert.equal(m.listeners.length, 1);
  ctl.state.uninstall = { waitMs: 24 * H, pendingAt: Date.now() + H, permitUntil: null, known: true };
  m.listeners[0]();
  assert.match(text(m.body), /Waiting period running/);
  m.cleanup();
  assert.equal(m.listeners.length, 0);
});

// ---- dialog in uninstall mode ----
test('the unlock dialog in uninstall mode uses the uninstall controller methods', async () => {
  const ctl = fake();
  const body = installDom();
  let done;
  const d = openUnlockDialog({ controller: ctl, block: { key: 'uninstall', uninstall: true, title: 'Uninstall protection' }, onDone: (r) => { done = r; } });
  const get = byFk(body, 'un-getcode');
  await fire(get, 'click');
  assert.deepEqual(ctl.calls[0], ['uninstallChallenge']);
  const token = findAll(body, (n) => n.tag === 'input')[0];
  token.value = 'TOKEN';
  await fire(token, 'input');
  await fire(byFk(body, 'un-submit'), 'click');
  assert.deepEqual(ctl.calls[1], ['uninstallSubmitToken', 'TOKEN']);
  assert.ok(done && done.ok);
  d.close();
});

test('the dialog wait route uses uninstallRequestDelay and uninstallCancelDelay', async () => {
  const ctl = fake();
  const body = installDom();
  const d = openUnlockDialog({ controller: ctl, block: { key: 'uninstall', uninstall: true, title: 'Uninstall protection' } });
  assert.match(text(body), /24 hours/);
  await fire(byFk(body, 'un-startwait'), 'click');
  assert.deepEqual(ctl.calls[0], ['uninstallRequestDelay']);
  d.close();
});

test('home mounts the section after Time limits', () => {
  const body = installDom();
  const ctl = fake();
  Object.assign(ctl.state, { loaded: true, lists: [], schedules: [], syncPending: false, notice: null });
  ctl.refreshStatus = async () => {}; ctl.resync = async () => {};
  const cleanup = mountHome(body, ctl, {}, { subscribe: () => () => {}, tzOffsetAt: () => 0 });
  const t = text(body);
  assert.ok(t.indexOf('Time limits') < t.indexOf('Uninstall protection'));
  assert.ok(byFk(body, 'un-wait'));
  cleanup();
});
