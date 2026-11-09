import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteRunner } from '../src/shell/router.js';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('the previous screen is cleaned up when the route changes, even when render is async', async () => {
  const r = createRouteRunner();
  const log = [];
  await r.run(async () => { await wait(1); return () => log.push('A cleaned'); });
  await r.run(async () => () => log.push('B cleaned'));
  assert.deepEqual(log, ['A cleaned']);
  await r.run(() => undefined);
  assert.deepEqual(log, ['A cleaned', 'B cleaned']);
});

test('a render that finishes after the user already moved on is cleaned up immediately', async () => {
  const r = createRouteRunner();
  const log = [];
  const slow = r.run(async () => { await wait(30); return () => log.push('slow cleaned'); });
  await wait(5);
  await r.run(async () => () => log.push('fast cleaned'));
  await slow;
  assert.deepEqual(log, ['slow cleaned']);
  await r.run(() => undefined);
  assert.deepEqual(log, ['slow cleaned', 'fast cleaned']);
});

test('renders may return nothing or a non-function, and a throwing cleanup does not block navigation', async () => {
  const r = createRouteRunner();
  await r.run(() => 42);
  await r.run(() => () => { throw new Error('boom'); });
  await r.run(() => 'next');
  await assert.doesNotReject(r.run(() => undefined));
});

test('an error from the current render is rethrown, but one from a stale render is ignored', async () => {
  const r = createRouteRunner();
  await assert.rejects(r.run(async () => { throw new Error('bad'); }), /bad/);
  const stale = r.run(async () => { await wait(20); throw new Error('late'); });
  await r.run(() => undefined);
  await assert.doesNotReject(stale);
});
