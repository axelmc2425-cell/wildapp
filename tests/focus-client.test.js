import test from 'node:test';
import assert from 'node:assert/strict';
import { createHelperClient } from '../src/modules/focus/helper-client.js';

function fake(reply) {
  const sent = [];
  const call = async (json) => { sent.push(json); return typeof reply === 'function' ? reply(json) : reply; };
  return { sent, client: createHelperClient(call) };
}

test('each method sends exact JSON and returns parsed reply', async () => {
  const w = { id: 'a', starts: 1, ends: 2, lock: 'none', mode: 'block', sites: [], apps: [] };
  let f = fake('{"type":"Ok"}');
  assert.deepEqual(await f.client.pushWindows([w]), { type: 'Ok' });
  assert.equal(f.sent[0], JSON.stringify({ type: 'PushWindows', windows: [w] }));

  const status = { type: 'Status', decision: {}, windows: [], partner_set: false, now_ms: 5, warnings: [] };
  f = fake(JSON.stringify(status));
  assert.deepEqual(await f.client.status(), status);
  assert.equal(f.sent[0], '{"type":"GetStatus"}');

  f = fake('{"type":"Challenge","code":"abc"}');
  assert.deepEqual(await f.client.requestChallenge('w1'), { type: 'Challenge', code: 'abc' });
  assert.equal(f.sent[0], '{"type":"RequestChallenge","window_id":"w1"}');

  f = fake('{"type":"Ok"}');
  await f.client.submitToken('tok');
  assert.equal(f.sent[0], '{"type":"SubmitToken","token":"tok"}');
  await f.client.setPartner('pk');
  assert.equal(f.sent[1], '{"type":"SetPartner","public_key":"pk"}');
});

test('Error reply rejects with message and code', async () => {
  const { client } = fake('{"type":"Error","code":"no-partner","message":"need key"}');
  await assert.rejects(client.status(), (e) => e instanceof Error && e.message === 'need key' && e.code === 'no-partner');
});

test('garbage reply rejects bad-response', async () => {
  for (const r of ['not json', '42', '{"x":1}']) {
    const { client } = fake(r);
    await assert.rejects(client.status(), (e) => e.code === 'bad-response');
  }
});

test('call failures and sync throws become rejections', async () => {
  const c1 = createHelperClient(() => { throw new Error('boom'); });
  let p;
  assert.doesNotThrow(() => { p = c1.status(); });
  await assert.rejects(p, /boom/);
  const c2 = createHelperClient(async () => { throw new Error('async boom'); });
  await assert.rejects(c2.status(), (e) => e instanceof Error && e.code === 'unreachable' && /async boom/.test(e.message));
  await assert.rejects(c1.status(), (e) => e.code === 'unreachable');
});

test('string rejections from the Tauri transport become unreachable errors', async () => {
  const c = createHelperClient(async () => { throw 'The Focus Room helper service is not running'; });
  await assert.rejects(c.status(), (e) => e instanceof Error && e.code === 'unreachable'
    && e.message === 'The Focus Room helper service is not running');
});

test('resetClock sends ResetClock', async () => {
  const f = fake('{"type":"Ok"}');
  assert.deepEqual(await f.client.resetClock(), { type: 'Ok' });
  assert.equal(f.sent[0], '{"type":"ResetClock"}');
  const e = fake('{"type":"Error","code":"lock-active","message":"nope"}');
  await assert.rejects(e.client.resetClock(), (x) => x.code === 'lock-active');
});
