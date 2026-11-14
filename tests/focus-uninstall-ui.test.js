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
  assert.equal(byFk(body, 'un-wait'), undefined);
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
  ctl.state.uninstall = { waitMs: 24 * H, pendingAt: null, permitUntil: Date.now() + 30 * 60000, known: true };
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

// ---- review round 1 ----
const ACCEPTED = /Your partner's code was accepted/;
async function accepted(extra = {}) {
  let t0 = 1_000_000_000_000;
  const ctl = fake();
  let opts;
  const m = mount(ctl, { now: () => t0, openUnlockDialog: (o) => { opts = o; return { close() {} }; }, ...extra });
  await fire(byFk(m.body, 'un-partner'), 'click');
  ctl.state.uninstall = { waitMs: 24 * H, pendingAt: null, permitUntil: t0 + 30 * 60000, known: true };
  opts.onDone({ ok: true });
  return { ctl, m, opts, advance: (ms) => { t0 += ms; }, now: () => t0 };
}

test('the accepted text goes away once the permit has expired', async () => {
  const x = await accepted();
  assert.match(text(x.m.body), ACCEPTED);
  x.advance(31 * 60000);
  x.m.listeners[0]();
  assert.doesNotMatch(text(x.m.body), ACCEPTED);
  assert.doesNotMatch(text(x.m.body), /You can uninstall/);
  x.m.cleanup();
});

test('the accepted text goes away when the helper becomes unknown', async () => {
  const x = await accepted();
  x.ctl.state.helper = { kind: 'not-running' };
  x.ctl.state.uninstall = { waitMs: 24 * H, pendingAt: null, permitUntil: null, known: false };
  x.m.listeners[0]();
  assert.doesNotMatch(text(x.m.body), ACCEPTED);
  assert.match(text(x.m.body), /Enforcement is not running/);
  x.m.cleanup();
});

test('the shorten note clears when a permit becomes live and when the dialog closes', async () => {
  const ctl = fake();
  let opts;
  const m = mount(ctl, { openUnlockDialog: (o) => { opts = o; return { close() {} }; } });
  const sel = byFk(m.body, 'un-setwait');
  sel.value = String(6 * H);
  await fire(sel, 'change');
  assert.match(text(m.body), /Shortening the waiting period needs a permit/);
  ctl.state.uninstall = { waitMs: 24 * H, pendingAt: null, permitUntil: Date.now() + 600000, known: true };
  m.listeners[0]();
  assert.doesNotMatch(text(m.body), /Shortening the waiting period needs a permit/);
  m.cleanup();
  const c2 = fake();
  const m2 = mount(c2, { openUnlockDialog: (o) => { opts = o; return { close() {} }; } });
  const s2 = byFk(m2.body, 'un-setwait');
  s2.value = String(6 * H);
  await fire(s2, 'change');
  assert.match(text(m2.body), /Shortening the waiting period needs a permit/);
  opts.onClose();
  assert.doesNotMatch(text(m2.body), /Shortening the waiting period needs a permit/);
  m2.cleanup();
});

test('a one-shot timeout at permitUntil removes the permit text without a poll', () => {
  const set = globalThis.setTimeout, clr = globalThis.clearTimeout;
  const timeouts = new Map();
  let n = 0;
  globalThis.setTimeout = (f, ms) => { timeouts.set(++n, { f, ms }); return n; };
  globalThis.clearTimeout = (id) => { timeouts.delete(id); };
  try {
    let t0 = 1_000_000_000_000;
    const ctl = fake({ uninstall: { waitMs: 24 * H, pendingAt: null, permitUntil: t0 + 60000, known: true } });
    const m = mount(ctl, { now: () => t0 });
    assert.match(text(m.body), /You can uninstall until/);
    assert.equal(timeouts.size, 1);
    const [{ f, ms }] = [...timeouts.values()];
    assert.ok(ms >= 60000 && ms < 61000);
    t0 += 61000;
    timeouts.clear(); // it fired
    f();
    assert.doesNotMatch(text(m.body), /You can uninstall until/);
    m.cleanup();
    assert.equal(timeouts.size, 0);
  } finally { globalThis.setTimeout = set; globalThis.clearTimeout = clr; }
});

test('focus survives a busy cycle by data-fk', async () => {
  const ctl = fake();
  const { body, cleanup } = mount(ctl);
  byFk(body, 'un-wait').focus();
  const p = fire(byFk(body, 'un-wait'), 'click');
  await p;
  assert.equal(document.activeElement.getAttribute('data-fk'), 'un-wait');
  assert.ok(document.activeElement.isConnected);
  cleanup();
});

test('no partner: Add a partner opens the setup only when helper is known', async () => {
  const calls = [];
  const deps = { openPartnerSetup: (o) => calls.push(o) };
  const a = mount(fake({ partner: { set: false, name: null } }), deps);
  await fire(byFk(a.body, 'un-addpartner'), 'click');
  assert.equal(calls.length, 1);
  a.cleanup();
  const b = mount(fake(), deps);
  assert.equal(byFk(b.body, 'un-addpartner'), undefined);
  b.cleanup();
  const c = mount(fake({ partner: { set: false }, helper: { kind: 'not-running' }, uninstall: { waitMs: 24 * H, known: false } }), deps);
  assert.equal(byFk(c.body, 'un-addpartner'), undefined);
  c.cleanup();
});

test('unmounting closes an open flow dialog', async () => {
  let closed = 0;
  const m = mount(fake(), { openUnlockDialog: () => ({ close() { closed++; } }) });
  await fire(byFk(m.body, 'un-partner'), 'click');
  m.cleanup();
  assert.equal(closed, 1);
});
