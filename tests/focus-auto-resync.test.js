import test from 'node:test';
import assert from 'node:assert/strict';
import { startAutoResync } from '../src/modules/focus/auto-resync.js';

function rig(over = {}) {
  let clock = 1000000;
  const calls = { resync: 0 };
  const ctl = { resync: async () => { calls.resync++; if (over.fail) throw new Error('x'); }, state: {} };
  const timers = [];
  const handlers = {};
  const target = { addEventListener: (n, f) => { handlers[n] = f; }, removeEventListener: (n) => { delete handlers[n]; } };
  const doc = { visibilityState: 'visible', addEventListener: (n, f) => { handlers['doc:' + n] = f; }, removeEventListener: (n) => { delete handlers['doc:' + n]; } };
  const opts = { setIntervalFn: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearIntervalFn: () => {}, now: () => clock, target, doc };
  return { ctl, calls, timers, handlers, doc, opts, advance: (ms) => { clock += ms; } };
}

test('resyncs every 6 hours', () => {
  const r = rig();
  startAutoResync(r.ctl, r.opts);
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0].ms, 6 * 3600000);
  r.timers[0].f();
  assert.equal(r.calls.resync, 1);
});

test('focus and visibility resync only when the last sync is over an hour old', () => {
  const r = rig();
  startAutoResync(r.ctl, r.opts);
  r.handlers.focus();
  assert.equal(r.calls.resync, 0);
  r.advance(61 * 60000);
  r.handlers.focus();
  assert.equal(r.calls.resync, 1);
  r.handlers.focus(); // just synced
  assert.equal(r.calls.resync, 1);
  r.advance(61 * 60000);
  r.doc.visibilityState = 'hidden';
  r.handlers['doc:visibilitychange']();
  assert.equal(r.calls.resync, 1);
  r.doc.visibilityState = 'visible';
  r.handlers['doc:visibilitychange']();
  assert.equal(r.calls.resync, 2);
});

test('starting twice for one controller registers once; stop removes it', () => {
  const r = rig();
  const a = startAutoResync(r.ctl, r.opts);
  const b = startAutoResync(r.ctl, r.opts);
  assert.equal(a, b);
  assert.equal(r.timers.length, 1);
  a();
  assert.equal(r.handlers.focus, undefined);
});

test('a failing or throwing resync is swallowed', async () => {
  const r = rig({ fail: true });
  startAutoResync(r.ctl, r.opts);
  r.timers[0].f();
  await new Promise((x) => setTimeout(x, 5));
  const t = rig();
  t.ctl.resync = () => { throw new Error('sync throw'); };
  startAutoResync(t.ctl, t.opts);
  assert.doesNotThrow(() => t.timers[0].f());
});
