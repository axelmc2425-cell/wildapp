import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, findAll } from './helpers/fake-dom.js';
import { openPartnerSetup } from '../src/modules/focus/ui/partner-setup.js';
import { buildPartnerPage } from '../src/modules/focus/partner-page.js';

const PATH = 'C:\\Users\\me\\Desktop\\partner-unlock.html';
const HINT = 'Send this file to your partner (email, WhatsApp, a USB stick). They open it in a browser.';
const controller = { state: { partner: null }, setPartner: async () => ({ ok: true }) };
const btn = (root, t) => findAll(root, n => n.tag === 'button' && n.textContent === t)[0];
const status = (root) => findAll(root, n => n.tag === 'p' && n.className.includes('fr-saved') && !n.hidden).map(n => n.textContent);

function mount({ save, invoke }) {
  const calls = [];
  const body = installDom({
    dialog: { save },
    core: { invoke: async (cmd, args) => { calls.push([cmd, args]); return invoke ? invoke(cmd, args) : undefined; } },
  });
  openPartnerSetup({ controller });
  return { body, calls };
}

test('saves the page via the dialog, reveals it, and shows the send-it message', async () => {
  const { body, calls } = mount({ save: async () => PATH });
  await btn(body, 'Save the partner page').click();
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'write_files');
  assert.equal(calls[0][1].dir, 'C:\\Users\\me\\Desktop');
  assert.equal(calls[0][1].files.length, 1);
  assert.equal(calls[0][1].files[0].path, 'partner-unlock.html');
  assert.equal(new TextDecoder().decode(new Uint8Array(calls[0][1].files[0].bytes)), buildPartnerPage());
  assert.deepEqual(calls[1], ['reveal_in_folder', { path: PATH }]);
  assert.deepEqual(status(body), [`Saved to ${PATH}. ${HINT}`]);
});

test('a reveal failure still shows the saved message', async () => {
  const { body } = mount({ save: async () => PATH, invoke: (cmd) => { if (cmd === 'reveal_in_folder') throw new Error('nope'); } });
  await btn(body, 'Save the partner page').click();
  assert.deepEqual(status(body), [`Saved to ${PATH}. ${HINT}`]);
});

test('a cancelled dialog writes nothing and shows nothing', async () => {
  const { body, calls } = mount({ save: async () => null });
  await btn(body, 'Save the partner page').click();
  assert.equal(calls.length, 0);
  assert.deepEqual(status(body), []);
});

test('a failing write shows the reason and does not reveal', async () => {
  const { body, calls } = mount({ save: async () => PATH, invoke: () => { throw new Error('disk full'); } });
  await btn(body, 'Save the partner page').click();
  assert.deepEqual(calls.map(c => c[0]), ['write_files']);
  const errs = findAll(body, n => n.tag === 'p' && n.className.includes('fr-err') && !n.hidden).map(n => n.textContent);
  assert.deepEqual(errs, ['Could not save the page: disk full. Nothing was sent.']);
  assert.deepEqual(status(body), []);
});

test('without the desktop app it downloads the blob and shows the hint', async () => {
  const body = installDom(undefined);
  globalThis.Blob = class { constructor(parts, o) { this.parts = parts; this.type = o.type; } };
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
  let clicked = null;
  const realCreate = document.createElement;
  document.createElement = (t) => { const e = realCreate(t); if (t === 'a') e.click = () => { clicked = e; }; return e; };
  openPartnerSetup({ controller });
  await btn(body, 'Save the partner page').click();
  assert.equal(clicked.getAttribute('download'), 'partner-unlock.html');
  assert.deepEqual(status(body), [HINT]);
});

test('root paths keep the separator in dir', async () => {
  for (const [path, dir, name] of [['C:\\partner.html', 'C:\\', 'partner.html'], ['/partner.html', '/', 'partner.html']]) {
    const { body, calls } = mount({ save: async () => path });
    await btn(body, 'Save the partner page').click();
    assert.equal(calls[0][1].dir, dir);
    assert.equal(calls[0][1].files[0].path, name);
  }
});

test('a reason ending in a period does not double it', async () => {
  const { body } = mount({ save: async () => PATH, invoke: () => { throw new Error('disk full.'); } });
  await btn(body, 'Save the partner page').click();
  const errs = findAll(body, n => n.tag === 'p' && n.className.includes('fr-err') && !n.hidden).map(n => n.textContent);
  assert.deepEqual(errs, ['Could not save the page: disk full. Nothing was sent.']);
});

test('a bare file name gives an empty dir', async () => {
  const { body, calls } = mount({ save: async () => 'b.html' });
  await btn(body, 'Save the partner page').click();
  assert.equal(calls[0][1].dir, '');
  assert.equal(calls[0][1].files[0].path, 'b.html');
});
