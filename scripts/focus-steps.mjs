// Focus Room screenshot scenarios (harness steps file). Run:
//   node scripts/shot.mjs /tmp/focus-shots --helper target/debug/focus-helper --steps scripts/focus-steps.mjs [--dark]
import { saveList, createSessions } from '../src/modules/focus/store.js';
import { readFileSync } from 'node:fs';
import { generatePartnerKeys, signUnlock } from '../src/modules/focus/unlock.js';
import { lockedWarning } from '../src/modules/focus/lock-logic.js';
import { STARTERS } from '../src/modules/focus/starters.js';

let partnerKeys = null;
const ok = (cond, msg) => { if (!cond) throw new Error('ASSERT FAILED: ' + msg); console.log('ok:', msg); };
const detailMap = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.fr-details .fr-dl dt')].map(dt => [dt.textContent, dt.nextElementSibling.innerText.trim()])));
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? null, sel);

export default async function steps(page, shot, h) {
  // (a) first run
  await page.goto(page.url().split('#')[0] + '#/focus');
  await page.waitForSelector('.fr-welcome');
  const body = await text(page, '.fr-home');
  ok(body.includes('Create your first list'), 'welcome card says "Create your first list"');
  for (const s of STARTERS) ok(body.includes(s.name), `starter "${s.name}" is shown`);
  ok(body.includes('Blank list'), 'blank list button is shown');
  await page.waitForSelector('.fr-banner.fr-ok', { timeout: 8000 });
  await shot('focus-1-first-run');

  // Task 10 (a, fresh helper): details exist, start collapsed, and show the empty status
  ok((await page.locator('.fr-details').count()) === 1, 'exactly one details element');
  ok(await page.evaluate(() => !document.querySelector('.fr-details').open), 'details are collapsed by default');
  await page.click('.fr-details > summary');
  ok(await page.evaluate(() => document.querySelector('.fr-details').open), 'clicking the summary opens the details');
  const d0 = await detailMap(page);
  ok(d0['Helper'] === 'Running' && d0['Partner key'] === 'not set' && d0['Blocking now'] === '0 sites, 0 apps', `fresh details: ${JSON.stringify(d0)}`);
  await page.focus('.fr-details > summary');
  await page.keyboard.press('Enter');
  ok(await page.evaluate(() => !document.querySelector('.fr-details').open), 'Enter on the summary closes it');
  await page.keyboard.press('Space');
  ok(await page.evaluate(() => document.querySelector('.fr-details').open), 'Space on the summary opens it');
  await page.keyboard.press('Enter');

  await editorScenarios(page, shot, h);

  // (b) running block
  const now = Date.now();
  const a = await saveList(h.db, { name: 'Distractions', sites: ['reddit.com', 'youtube.com', 'x.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'twitch.tv', 'news.ycombinator.com'], apps: [] });
  const b = await saveList(h.db, { name: 'Games', sites: [], apps: ['steam.exe', 'League of Legends.exe'] });
  await saveList(h.db, { name: 'News', sites: ['bbc.com', 'cnn.com'], apps: [] });
  const hostile = await saveList(h.db, { name: '<img src=x onerror=alert(1)> very long list name indeed', sites: ['a'.repeat(100) + '.com', 'b.com'], apps: ['a'.repeat(80) + '.exe'] });
  ok(a.ok && b.ok && hostile.ok, 'lists saved: ' + JSON.stringify(hostile));
  await createSessions(h.db, { listIds: [a.id, b.id], starts: now - 45 * 60000, ends: now + 134 * 60000 });
  await page.reload();
  await page.waitForSelector('.fr-home');
  ok(!(await text(page, '.fr-home')).includes('Create your first list'), 'no first-run flash while lists exist');
  await page.waitForSelector('.fr-block');
  const cd = await page.evaluate(() => document.querySelector('.fr-big').textContent);
  ok(/^\d+ h \d+ min left$/.test(cd), `countdown reads like "2 h 14 min left" (got "${cd}")`);
  await page.waitForSelector('.fr-banner.fr-ok', { timeout: 8000 });
  const bn = await text(page, '.fr-banner');
  ok(bn.includes('Helper running'), `banner reads Helper running (got "${bn.replace(/\n/g, ' ')}")`);
  const chips = await page.evaluate(() => [...document.querySelectorAll('.fr-chip')].map(e => e.textContent));
  ok(chips.includes('reddit.com') && chips.includes('+2'), `chips shown with +N overflow (${chips.slice(0, 8).join(', ')})`);
  ok(await page.evaluate(() => !document.querySelector('.fr-home img')), 'hostile list name did not become an element');
  ok(await page.evaluate(() => document.querySelector('button[aria-label="Delete Distractions"]').disabled), 'Delete is disabled while the list is in a running block');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.getElementById('content').scrollWidth <= document.getElementById('content').clientWidth), 'no horizontal overflow at 1280');
  await shot('focus-2-running');

  // (c) helper down, then recovery
  h.setHelperDown(true);
  await page.waitForSelector('.fr-banner.fr-error', { timeout: 7500 });
  const down = await text(page, '.fr-banner');
  ok(down.includes("helper isn't running"), `red banner says helper isn't running (got "${down.replace(/\n/g, ' ')}")`);
  await shot('focus-3-helper-down');
  await page.focus('.fr-banner .fr-retry');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  ok(await page.evaluate(() => document.activeElement.classList.contains('fr-retry')), 'keyboard Retry while helper is down keeps focus on Retry');
  h.setHelperDown(false);
  await page.focus('.fr-banner .fr-retry');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.fr-banner.fr-ok', { timeout: 5000 });
  ok(true, 'Retry turned the banner green again');
  await shot('focus-4-recovered');

  // (d) warnings
  h.setWarnings(['hosts: Access is denied. (os error 5)']);
  await page.waitForSelector('.fr-banner.fr-warn', { timeout: 7500 });
  const warn = await text(page, '.fr-banner-detail');
  ok(warn === "The helper couldn't update the Windows hosts file, so some websites may not be blocked.", `amber detail is the plain sentence (got "${warn}")`);
  await shot('focus-5-warnings');
  h.setWarnings(['persist: disk full']);
  await page.waitForSelector('.fr-banner.fr-error', { timeout: 7500 });
  const persist = await text(page, '.fr-banner');
  ok(persist.includes('lost on restart'), `red banner says lost on restart (got "${persist.replace(/\n/g, ' ')}")`);
  await shot('focus-6-persist');
  h.setWarnings(null);

  // (d2) extend and cancel dialogs
  await page.click('.fr-block button:has-text("Extend")');
  await page.waitForSelector('.fr-dialog');
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  ok(await page.evaluate(() => !!document.activeElement.closest('.fr-dialog')), 'focus stays trapped inside the dialog');
  await shot('focus-7-extend');
  await page.keyboard.press('Escape');
  await page.click('.fr-block button:has-text("Extend")');
  await page.waitForSelector('.fr-dialog');
  await page.focus('.fr-choices button');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.fr-dialog'));
  await page.waitForTimeout(800);
  ok(await page.evaluate(() => document.activeElement.textContent === 'Extend' && !!document.activeElement.closest('.fr-block')), 'after keyboard +15 min, focus is on the card Extend button (not BODY)');
  await page.click('.fr-block button:has-text("Extend")');
  await page.keyboard.press('Escape');
  ok(await page.evaluate(() => !document.querySelector('.fr-dialog') && document.activeElement.textContent === 'Extend'), 'Esc closes the dialog and returns focus to Extend');

  // (e) navigate away and back: no duplicate banners, no errors
  await page.goto(page.url().split('#')[0] + '#/settings');
  await page.waitForSelector('#content');
  await page.goto(page.url().split('#')[0] + '#/focus');
  await page.waitForSelector('.fr-block');
  ok((await page.locator('.fr-banner').count()) === 1, 'exactly one banner after navigating back');
  await page.waitForTimeout(1500);

  await detailsScenarios(page, shot, h);
  await startScenarios(page, shot, h);
}

// ---- Task 8: list editor scenarios (start from the first-run state, leave no lists behind) ----
async function editorScenarios(page, shot, h) {
  const siteIn = '.fr-dialog input[id^="fr-ed-site-"]';
  const appIn = '.fr-dialog input[id^="fr-ed-app-"]';
  const nameIn = '.fr-dialog input[id^="fr-ed-name-"]';
  const rows = async (kind) => page.evaluate((k) => [...document.querySelectorAll(`.fr-dialog input[id^="fr-ed-${k}-"]`)[0].closest('.fr-field').querySelectorAll('.fr-edchip .fr-chip-text')].map(e => e.textContent), kind);
  const msg = async (kind) => page.evaluate((k) => document.querySelector(`.fr-dialog input[id^="fr-ed-${k}-"]`).closest('.fr-field').querySelector('.fr-msg').innerText, kind);
  const saveDisabled = () => page.evaluate(() => document.querySelector('.fr-dialog button.primary').disabled);
  const closed = () => page.waitForFunction(() => !document.querySelector('.fr-dialog'));

  // (a) starter opens the editor with the preset
  await page.click('.fr-welcome button:has-text("Social media")');
  await page.waitForSelector('.fr-dialog .fr-editor');
  ok(await page.inputValue(nameIn) === 'Social media', 'editor opens with the preset name');
  ok((await rows('site')).length === 6, '6 site chips from the Social media preset');
  ok(await page.evaluate(() => document.activeElement.id.startsWith('fr-ed-name-')), 'name input is focused');
  ok(await page.evaluate(() => document.querySelector('.fr-dialog-title').textContent) === 'New list', 'title is New list');
  await shot('focus-8-editor-preset');

  // (c) names
  await page.fill(nameIn, '');
  ok(await saveDisabled(), 'empty name: Save disabled');
  await page.fill(nameIn, 'x'.repeat(70));
  ok((await page.inputValue(nameIn)).length === 60, 'typing 70 chars yields a 60-char name');
  await page.fill(nameIn, 'Social media');
  ok(!(await saveDisabled()), 'valid name: Save enabled');
  await page.keyboard.press('Enter');
  ok(await page.evaluate(() => document.activeElement.id.startsWith('fr-ed-site-')), 'Enter in name moves focus to Websites');
  ok(await page.evaluate(() => !!document.querySelector('.fr-dialog')), 'Enter in name does not submit');

  // (b) entries
  await page.fill(siteIn, 'https://www.Example.org/a?b=1');
  await page.keyboard.press('Enter');
  ok((await rows('site')).includes('example.org'), 'chip example.org added');
  ok((await msg('site')).includes('Will be saved as example.org'), 'note "Will be saved as example.org" shown');
  ok(await page.inputValue(siteIn) === '', 'input cleared after add');
  await page.fill(siteIn, 'reddit.com');
  await page.keyboard.press('Enter');
  ok((await rows('site')).filter(v => v === 'reddit.com').length === 1, 'duplicate reddit.com collapses silently');
  await page.keyboard.type('not a domain');
  const before = (await rows('site')).length;
  await page.keyboard.press('Enter');
  ok((await msg('site')).includes("That doesn't look like a website address."), 'bad site shows plain-English error');
  ok((await rows('site')).length === before, 'no chip added for the bad entry');
  ok(await page.inputValue(siteIn) === 'not a domain', 'bad text remains in the input');
  ok(await page.evaluate(() => !!document.querySelector('.fr-dialog .fr-err[role="alert"]:not([hidden])')), 'error is an alert');
  await page.fill(appIn, 'League of Legends.exe');
  await page.keyboard.press('Enter');
  ok((await rows('app')).join('|') === 'league of legends.exe', `app chip keeps the space (${(await rows('app')).join('|')})`);
  await page.fill(appIn, 'C:\\Games\\');
  await page.keyboard.press('Enter');
  ok((await msg('app')).includes("Use the program's file name, like steam.exe."), 'bad app shows the file-name error');
  await shot('focus-9-editor-errors');
  await page.fill(appIn, 'a.exe, b.exe');
  await page.keyboard.press('Enter');
  ok((await rows('app')).join('|') === 'league of legends.exe|a.exe|b.exe', 'comma-separated apps add each piece');
  await page.fill(appIn, '');
  await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
  ok((await rows('app')).join('|') === 'league of legends.exe', 'Backspace on empty input removes the last chip');
  await page.focus(siteIn); await page.fill(siteIn, '');
  await page.fill(siteIn, 'a1.com,b1.com');
  await page.keyboard.press('Enter');
  ok((await rows('site')).includes('a1.com') && (await rows('site')).includes('b1.com'), 'comma-separated sites add each piece');

  // (d) save
  await page.keyboard.press('Escape');
  await closed();
  ok(await page.evaluate(() => document.activeElement.textContent.includes('Social media')), 'Esc returns focus to the starter button');
  await page.click('.fr-welcome button:has-text("Social media")');
  await page.waitForSelector('.fr-dialog .fr-editor');
  await page.fill(siteIn, 'https://www.Example.org/a?b=1'); await page.keyboard.press('Enter');
  await page.fill(appIn, 'steam.exe'); await page.keyboard.press('Enter');
  await page.click('.fr-dialog button.primary');
  await closed();
  await page.waitForSelector('.fr-list');
  const homeText = await text(page, '.fr-home');
  ok(homeText.includes('Social media') && homeText.includes('facebook.com') && homeText.includes('+2'), 'saved list appears on Home with its chips');
  ok(await page.evaluate(async () => { try { const r = await window.__TAURI__.core.invoke('focus_helper_call', { request: JSON.stringify({ type: 'GetStatus' }) }); return !!r; } catch { return false; } }), 'helper GetStatus still works after saving');

  // (g) duplicate name
  await page.click('button:has-text("New list")');
  await page.waitForSelector('.fr-dialog .fr-editor');
  await page.fill(nameIn, 'SOCIAL MEDIA');
  await page.fill(siteIn, 'other.com'); await page.keyboard.press('Enter');
  await page.click('.fr-dialog button.primary');
  await page.waitForSelector('.fr-dialog .fr-err:not([hidden])');
  const nerr = await page.evaluate(() => document.querySelector('.fr-dialog .fr-field input[id^="fr-ed-name-"]').closest('.fr-field').querySelector('.fr-err').textContent);
  ok(nerr === 'A list with this name already exists.', `duplicate name error under the name field (got "${nerr}")`);
  ok(await page.inputValue(nameIn) === 'SOCIAL MEDIA' && (await rows('site')).includes('other.com'), 'input intact after the failed save');
  ok(!(await saveDisabled()), 'Save re-enabled after a failed save');
  await shot('focus-10-editor-name-error');

  // (h) cap
  await page.fill(nameIn, 'Big list');
  const big = Array.from({ length: 600 }, (_, i) => `site${i}.com`).join('\n');
  await page.fill(siteIn, '');
  await page.evaluate(({ sel, text }) => { // a real paste event: <input> strips newlines from typed/filled values
    const el = document.querySelector(sel); el.focus();
    const dt = new DataTransfer(); dt.setData('text', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { sel: siteIn, text: big });
  ok((await msg('site')).includes('A list can hold up to 512 entries.'), 'cap message shown for 600 entries');
  ok((await rows('site')).length === 512, 'exactly 512 chips');
  ok(await page.evaluate(() => { const b = document.querySelector('.fr-dialog').getBoundingClientRect(); return b.bottom <= innerHeight && b.top >= 0 && document.documentElement.scrollWidth <= innerWidth; }), 'dialog fits the 1280x800 viewport with 512 chips');
  await shot('focus-11-editor-many');
  await page.keyboard.press('Escape'); await closed();

  // (e) edit again: remove via keyboard and via the chip button
  await page.click('button[aria-label="Edit Social media"], .fr-list button:has-text("Edit")');
  await page.waitForSelector('.fr-dialog .fr-editor');
  ok(await page.evaluate(() => document.querySelector('.fr-dialog-title').textContent) === 'Edit list', 'title is Edit list');
  const has = await rows('site');
  await page.focus(siteIn);
  await page.keyboard.press('Backspace');
  const after1 = await rows('site');
  ok(after1.length === has.length - 1 && !after1.includes('example.org'), `Backspace removed the last site chip (${has.length} -> ${after1.length})`);
  await page.click('.fr-dialog button[aria-label="Remove facebook.com"]');
  ok(!(await rows('site')).includes('facebook.com'), 'chip remove button removes facebook.com');
  ok(await page.evaluate(() => document.activeElement.id.startsWith('fr-ed-site-')), 'focus returns to the input after removing a chip');
  await page.click('.fr-dialog button.primary');
  await closed();
  await page.waitForTimeout(300);
  const chips2 = await page.evaluate(() => [...document.querySelectorAll('.fr-list .fr-chip')].map(e => e.textContent));
  ok(!chips2.includes('facebook.com') && chips2.includes('instagram.com') && !chips2.includes('+2'), `Home chips reflect the edit (${chips2.join(', ')})`);

  // (f) keyboard-only reach
  await page.click('.fr-list button:has-text("Edit")');
  await page.waitForSelector('.fr-dialog .fr-editor');
  await page.focus(nameIn);
  const seen = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    seen.push(await page.evaluate(() => document.activeElement.textContent.trim() || document.activeElement.id));
    if (seen.includes('Save') && seen.includes('Cancel')) break;
  }
  ok(seen.includes('Cancel') && seen.includes('Save'), `Tab reaches Cancel and Save (${seen.slice(-4).join(' > ')})`);
  await page.keyboard.press('Escape'); await closed();
  ok(await page.evaluate(() => document.activeElement.textContent === 'Edit'), 'Esc returns focus to the Edit button');

  // (g) desktop pickers: harness stubs window.__TAURI__ (dialog.open + core), so hasNative() is true
  await page.click('button:has-text("New list")');
  await page.waitForSelector('.fr-dialog .fr-editor');
  ok((await page.locator('.fr-dialog button.fr-browse').count()) === 2, 'both Browse buttons shown when running in the desktop app');
  ok((await page.locator('.fr-dialog button:has-text("Browse files")').count()) === 1 && (await page.locator('.fr-dialog button:has-text("Browse folder")').count()) === 1, 'Browse files and Browse folder are both present');
  await page.fill(nameIn, 'Game library');
  await page.fill(siteIn, 'twitch.tv'); await page.keyboard.press('Enter');
  await page.evaluate(() => { window.__pickFiles = ['C:\\Program Files\\Steam\\steam.exe', 'D:\\Games\\launcher.exe']; });
  await page.click('.fr-dialog button:has-text("Browse files")');
  await page.waitForFunction(() => document.querySelectorAll('.fr-dialog input[id^="fr-ed-app-"]')[0].closest('.fr-field').querySelectorAll('.fr-edchip').length >= 2);
  ok((await rows('app')).join('|') === 'steam.exe|launcher.exe', `file picks became app chips (${(await rows('app')).join('|')})`);
  const folderChips = () => page.evaluate(() => [...document.querySelectorAll('.fr-dialog .fr-chip.fr-folder .fr-chip-text')].map(e => e.textContent));
  for (const d of ['D:\\Games\\Epic', 'C:\\Games\\Foo Bar']) {
    await page.evaluate((p) => { window.__pickDir = p; }, d);
    await page.click('.fr-dialog button:has-text("Browse folder")');
    await page.waitForFunction((n) => document.querySelectorAll('.fr-dialog .fr-chip.fr-folder').length >= n, d.endsWith('Epic') ? 1 : 2);
  }
  ok((await folderChips()).length === 2, `two folder chips (${(await folderChips()).join(' | ')})`);
  await page.evaluate(() => { window.__pickDir = 'C:\\Windows'; });
  await page.click('.fr-dialog button:has-text("Browse folder")');
  await page.waitForFunction(() => /part of Windows/.test(document.querySelector('.fr-dialog .fr-field .fr-err:not([hidden])')?.textContent || ''));
  ok((await folderChips()).length === 2, 'forbidden folder added no chip');
  ok(await page.evaluate(() => document.querySelector('.fr-dialog .fr-err[role="alert"]:not([hidden])') !== null), 'forbidden-folder error is an alert');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow with folder chips');
  await shot('focus-12-editor-folders');
  await page.evaluate(() => { window.__pickDir = null; window.__pickFiles = null; });
  await page.keyboard.press('Escape'); await closed();

  // clean up: no lists left for the later scenarios
  await h.db.run('DELETE FROM focus_items'); await h.db.run('DELETE FROM focus_sessions'); await h.db.run('DELETE FROM focus_lists');
  await page.reload();
  await page.waitForSelector('.fr-welcome');
}

// ---- Task 9: start dialog and block actions (fresh state, leaves nothing behind) ----
const getStatus = (page) => page.evaluate(async () => JSON.parse(await window.__TAURI__.core.invoke('focus_helper_call', { request: JSON.stringify({ type: 'GetStatus' }) })));
const blockedSites = async (page) => { const s = await getStatus(page); return s.decision?.blockSites ?? []; };
const windowsOf = async (page) => { const s = await getStatus(page); return s.windows ?? []; };

async function startScenarios(page, shot, h) {
  const closed = () => page.waitForFunction(() => !document.querySelector('.fr-dialog'));
  const startDisabled = () => page.evaluate(() => document.querySelector('.fr-dialog button.primary').disabled);
  const summary = () => text(page, '.fr-st-summary');
  const derr = () => page.evaluate(() => { const e = document.querySelector('.fr-dialog .fr-err:not([hidden])'); return e ? e.textContent : ''; });
  const MSG = 'Enter a whole number of minutes from 1 to 1440.';
  const custom = '.fr-dialog input[id^="fr-st-custom-"]';

  // fresh state: no lists, no sessions; wait until the helper agrees nothing is blocked
  await h.db.run('DELETE FROM focus_items'); await h.db.run('DELETE FROM focus_sessions'); await h.db.run('DELETE FROM focus_lists');
  const la = await saveList(h.db, { name: 'Alpha <b>list</b>', sites: ['alpha-one.com', 'alpha-two.com'], apps: ['alpha.exe'] });
  const lb = await saveList(h.db, { name: 'Beta', sites: ['beta-one.com'], apps: [] });
  ok(la.ok && lb.ok, 'two lists seeded');
  await page.reload();
  await page.waitForSelector('.fr-list');
  await page.waitForSelector('.fr-banner.fr-ok', { timeout: 8000 });
  await page.click('button:has-text("Start a block")');
  await page.waitForSelector('.fr-dialog .fr-start');
  ok(await page.evaluate(() => document.querySelector('.fr-dialog-title').textContent) === 'Start a block', 'dialog title');
  ok((await page.locator('.fr-dialog .fr-checkrow input[type=checkbox]').count()) === 2, 'one checkbox per list');
  ok((await page.locator('.fr-dialog input[type=checkbox]:checked').count()) === 0, 'no list pre-checked');
  ok(await startDisabled(), 'Start disabled with nothing checked');
  ok(await page.evaluate(() => !document.querySelector('.fr-dialog b') && document.querySelector('.fr-checkname').textContent.includes('<b>')), 'hostile list name is text');
  const t0 = await text(page, '.fr-dialog');
  ok(t0.includes('2 sites, 1 app') && t0.includes('1 site'), 'list summaries shown');
  ok(t0.includes('Normal') && t0.includes('You can cancel any time.') && t0.includes('Locked') && !t0.includes('coming soon') && !t0.includes('Frozen'), 'normal + locked choices, no coming-soon, no Frozen');
  ok(await page.evaluate(() => document.querySelector('input[type=radio][value=normal]').checked && document.querySelectorAll('.fr-modes input[type=radio]').length === 2), 'two radios, Normal selected by default');
  await page.locator('.fr-dialog input[type=checkbox]').first().check();
  ok(!(await startDisabled()), 'Start enabled after checking a list');
  ok((await summary()).includes('Ends at'), `summary says Ends at (got "${await summary()}")`);
  for (const bad of ['abc', '1441', '0']) {
    await page.fill(custom, bad);
    ok((await derr()) === MSG && (await startDisabled()), `custom "${bad}" -> inline error and Start disabled`);
  }
  await page.fill(custom, 'abc');
  await shot('focus-11-start-dialog-error');
  await page.click('.fr-durchip:has-text("25 min")');
  ok((await page.inputValue(custom)) === '' && (await derr()) === '', '25 min chip clears the custom input and the error');
  ok(await page.evaluate(() => document.querySelector('.fr-durchip[aria-pressed=true]').textContent) === '25 min', '25 min chip pressed');
  const s25 = await summary();
  ok(s25.includes('Ends at'), `summary after 25 min chip: ${s25}`);
  await page.fill(custom, '90');
  ok(await page.evaluate(() => !document.querySelector('.fr-durchip[aria-pressed=true]')), 'typing custom unpresses the chips');
  ok((await summary()) !== s25, `summary tracks custom (${s25} -> ${await summary()})`);
  // dead-end regression: chip, custom, clear custom -> the chip is pressed again
  await page.click('.fr-durchip:has-text("1 h")');
  const s60 = await summary();
  await page.fill(custom, '9');
  ok(await page.evaluate(() => !document.querySelector('.fr-durchip[aria-pressed=true]')) && (await summary()) !== s60, `custom 9 un-presses chips and updates summary (${await summary()})`);
  await page.focus(custom); await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace');
  ok(await page.evaluate(() => document.querySelector('.fr-durchip[aria-pressed=true]')?.textContent) === '1 h', '1 h chip pressed again after clearing custom');
  ok((await summary()) === s60 && !(await startDisabled()), `summary back (${await summary()}) and Start enabled`);
  await page.click('.fr-durchip:has-text("25 min")');
  await shot('focus-11-start-dialog');

  // double click Start: exactly one block
  await page.evaluate(() => { const b = document.querySelector('.fr-dialog button.primary'); b.click(); b.click(); });
  await closed();
  await page.waitForSelector('.fr-block');
  ok((await page.locator('.fr-block').count()) === 1, 'double click created exactly one block card');
  const cd = await page.evaluate(() => document.querySelector('.fr-big').textContent);
  ok(/^(24|25) min left$/.test(cd), `countdown reads 24/25 min left (got "${cd}")`);
  let bs = await blockedSites(page);
  ok(bs.includes('alpha-one.com') && bs.includes('alpha-two.com') && !bs.includes('beta-one.com'), `helper blocks Alpha's sites (${bs.join(',')})`);
  ok(await page.evaluate(() => document.activeElement !== document.body), 'focus is not lost to <body> after the dialog closes');
  await shot('focus-11b-running');

  // (b) extend by keyboard
  const ends0 = (await windowsOf(page))[0].ends;
  await page.click('.fr-block button:has-text("Extend")');
  await page.waitForSelector('.fr-dialog');
  await page.focus('.fr-choices button');
  await page.keyboard.press('Enter');
  await closed();
  await page.waitForFunction(() => /^(39|40) min left$/.test(document.querySelector('.fr-big')?.textContent));
  ok(true, 'countdown grew to about 40 min');
  const ends1 = (await windowsOf(page))[0].ends;
  ok(Math.abs((ends1 - ends0) - 15 * 60000) <= 2000, `helper window end moved by 15 min (${ends0} -> ${ends1})`);

  // (c) second block on the other list
  await page.click('button:has-text("Start a block")');
  await page.waitForSelector('.fr-dialog .fr-start');
  await page.locator('.fr-dialog .fr-checkrow:has-text("Beta") input').check();
  await page.click('.fr-dialog button.primary');
  await closed();
  await page.waitForFunction(() => document.querySelectorAll('.fr-block').length === 2);
  bs = await blockedSites(page);
  ok(bs.includes('alpha-one.com') && bs.includes('beta-one.com'), `both lists blocked (${bs.join(',')})`);
  await shot('focus-12-two-blocks');

  // (d) cancel one, then the other
  const cancelCard = async (name) => {
    await page.click(`.fr-block:has(.fr-pill:text-is("${name}")) button:has-text("Cancel")`);
    await page.waitForSelector('.fr-dialog');
    await page.click('.fr-dialog button:has-text("Stop blocking")');
    await closed();
  };
  await cancelCard('Beta');
  await page.waitForFunction(() => document.querySelectorAll('.fr-block').length === 1);
  bs = await blockedSites(page);
  ok(!bs.includes('beta-one.com') && bs.includes('alpha-one.com'), `Beta released, Alpha still blocked (${bs.join(',')})`);
  await cancelCard('Alpha <b>list</b>');
  await page.waitForFunction(() => document.querySelectorAll('.fr-block').length === 0);
  bs = await blockedSites(page);
  ok(bs.length === 0, 'no sites blocked after cancelling both');

  // (e) start while the helper is down
  h.setHelperDown(true);
  await page.click('button:has-text("Start a block")');
  await page.waitForSelector('.fr-dialog .fr-start');
  await page.locator('.fr-dialog .fr-checkrow:has-text("Beta") input').check();
  await page.click('.fr-dialog button.primary');
  await closed();
  await page.waitForSelector('.fr-block');
  await page.waitForSelector('.fr-banner.fr-error', { timeout: 8000 });
  ok((await text(page, '.fr-block')).includes('Saved, not yet enforced.'), 'card says "Saved, not yet enforced."');
  await shot('focus-12-start-helper-down');
  h.setHelperDown(false);
  await page.click('.fr-banner .fr-retry');
  await page.waitForSelector('.fr-banner.fr-ok', { timeout: 8000 });
  await page.waitForFunction(() => !document.querySelector('.fr-block')?.innerText.includes('not yet enforced'));
  ok(true, 'notice gone and banner green after Retry');
  bs = await blockedSites(page);
  ok(bs.includes('beta-one.com'), 'helper now lists the block');
  ok((await windowsOf(page)).length === 1, 'pushed exactly once: windows.length === 1');

  // (f) cancel while helper down
  h.setHelperDown(true);
  await page.click('.fr-block button:has-text("Cancel")');
  await page.waitForSelector('.fr-dialog');
  await page.click('.fr-dialog button:has-text("Stop blocking")');
  await closed();
  await page.waitForFunction(() => document.querySelector('.fr-notes')?.innerText.includes("Couldn't tell the helper to stop. It will stop by"));
  ok(await page.evaluate(() => !!document.querySelector('.fr-notes .fr-retry')), 'note has a Retry button');
  await shot('focus-12-cancel-helper-down');
  h.setHelperDown(false);
  await page.click('.fr-notes .fr-retry');
  await page.waitForFunction(() => !document.querySelector('.fr-notes')?.innerText.includes("Couldn't tell"), null, { timeout: 8000 });
  ok(true, 'stop note gone after Retry');
  ok((await windowsOf(page)).length === 0, 'helper no longer lists the window');

  await pendingScenarios(page, shot, h);
  await lockScenarios(page, shot, h);
  await unlockScenarios(page, shot, h);

  // clean up
  await h.db.run('DELETE FROM focus_items'); await h.db.run('DELETE FROM focus_sessions'); await h.db.run('DELETE FROM focus_lists');
}

// ---- fix round 1: Esc/overlay are inert while a request is pending ----
async function pendingScenarios(page, shot, h) {
  const closed = () => page.waitForFunction(() => !document.querySelector('.fr-dialog'));
  const open = () => page.evaluate(() => !!document.querySelector('.fr-dialog'));
  await h.db.run('DELETE FROM focus_sessions');
  await page.reload();
  await page.waitForSelector('.fr-banner.fr-ok', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('.fr-block').length === 0);

  // (a) Esc while Start is pending
  h.setHelperDelay(700);
  await page.click('button:has-text("Start a block")');
  await page.waitForSelector('.fr-dialog .fr-start');
  await page.locator('.fr-dialog .fr-checkrow:has-text("Beta") input').check();
  await page.click('.fr-dialog button.primary');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5); // overlay click
  ok(await open(), 'Esc and overlay click are inert while Start is pending');
  await closed();
  await page.waitForSelector('.fr-block');
  ok(true, 'dialog closed after the request settled and the block card is shown');
  h.setHelperDelay(0);
  await page.click('.fr-block button:has-text("Cancel")');
  await page.click('.fr-dialog button:has-text("Stop blocking")');
  await closed();
  await page.waitForFunction(() => document.querySelectorAll('.fr-block').length === 0);

  // (b) failure while pending: the message lands in the still-open dialog
  await page.click('button:has-text("Start a block")');
  await page.waitForSelector('.fr-dialog .fr-start');
  await page.locator('.fr-dialog .fr-checkrow:has-text("Beta") input').check();
  await h.db.run("DELETE FROM focus_items WHERE list_id = (SELECT id FROM focus_lists WHERE name = 'Beta')");
  await h.db.run("DELETE FROM focus_lists WHERE name = 'Beta'");
  await page.evaluate(() => {
    document.querySelector('.fr-dialog button.primary').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('.fr-dialog')?.innerText.includes('One of those lists no longer exists.'));
  ok(await open(), 'failure message "One of those lists no longer exists." is visible in the still-open dialog');
  ok(await page.evaluate(() => !document.querySelector('.fr-dialog button.primary').disabled), 'inputs re-enabled after the failure');
  await page.keyboard.press('Escape');
  await closed();
  ok(true, 'Esc closes the dialog once idle');

  // (c) list editor: Esc while a save is pending
  const before = (await h.db.all('SELECT id FROM focus_lists')).length;
  h.setHelperDelay(700);
  await page.click('button:has-text("New list")');
  await page.waitForSelector('.fr-dialog .fr-editor');
  await page.fill('.fr-dialog input[id^="fr-ed-name-"]', 'Gamma');
  await page.fill('.fr-dialog input[id^="fr-ed-site-"]', 'gamma.com'); await page.keyboard.press('Enter');
  await page.click('.fr-dialog button.primary');
  await page.keyboard.press('Escape');
  ok(await open(), 'Esc is inert while the list save is pending');
  await closed();
  h.setHelperDelay(0);
  await page.waitForSelector('.fr-list:has-text("Gamma")');
  ok((await h.db.all('SELECT id FROM focus_lists')).length === before + 1, 'the list was saved exactly once');
  await page.click('button:has-text("New list")');
  await page.waitForSelector('.fr-dialog .fr-editor');
  await page.keyboard.press('Escape');
  await closed();
  ok(true, 'plain Esc still closes an idle editor');
}

// ---- Task 10: helper details panel (runs with the running block from scenario (b) in place) ----
async function detailsScenarios(page, shot, h) {
  const isOpen = () => page.evaluate(() => document.querySelector('.fr-details').open);
  await page.waitForSelector('.fr-banner.fr-ok', { timeout: 8000 });
  if (!(await isOpen())) await page.click('.fr-details > summary');

  // (a) a running block shows up in the details
  await page.waitForFunction(() => /^8 sites, 2 apps$/.test([...document.querySelectorAll('.fr-details .fr-dl dd')].map(d => d.innerText.trim())[2] || ''), null, { timeout: 8000 });
  const d1 = await detailMap(page);
  ok(d1['Blocking now'] === '8 sites, 2 apps' && d1['Windows held'] === '2', `running details (one window per list): ${JSON.stringify(d1)}`);
  await page.evaluate(() => document.querySelector('.fr-details').scrollIntoView({ block: 'end' }));
  await shot('focus-13-details-open');

  // (b) the 5 s poll must not collapse or rebuild the open panel
  await page.evaluate(() => document.querySelector('.fr-details').setAttribute('data-tag', 'mine'));
  await page.waitForTimeout(6000);
  ok(await isOpen(), 'panel is still open after a 5 s poll');
  ok(await page.evaluate(() => document.querySelector('.fr-details')?.getAttribute('data-tag') === 'mine'), 'the <details> element is the same node after the poll');

  // (c) raw warnings, one per line, while the banner shows the plain sentence
  h.setWarnings(['hosts: Access is denied. (os error 5)', 'state: loaded from backup']);
  await page.waitForSelector('.fr-banner.fr-warn', { timeout: 7500 });
  await page.waitForFunction(() => document.querySelectorAll('.fr-details .fr-warnlist li').length === 2, null, { timeout: 7500 });
  const lis = await page.evaluate(() => [...document.querySelectorAll('.fr-details .fr-warnlist li')].map(l => l.textContent));
  ok(lis[0] === 'hosts: Access is denied. (os error 5)' && lis[1] === 'state: loaded from backup', `warnings listed verbatim: ${JSON.stringify(lis)}`);
  const bd = await text(page, '.fr-banner-detail');
  ok(bd.startsWith("The helper couldn't update the Windows hosts file"), `banner shows the plain sentence (got "${bd}")`);
  ok(await isOpen() && await page.evaluate(() => document.querySelector('.fr-details').getAttribute('data-tag') === 'mine'), 'panel stayed open and unreplaced while warnings arrived');
  await page.evaluate(() => document.querySelector('.fr-details').scrollIntoView({ block: 'end' }));
  await shot('focus-14-details-warnings');
  h.setWarnings(null);
  await page.waitForSelector('.fr-banner.fr-ok', { timeout: 7500 });
  await page.waitForFunction(() => !document.querySelector('.fr-details .fr-warnlist'), null, { timeout: 7500 });

  // (d) helper down: details show the explanation, not fake data
  h.setHelperDown(true);
  await page.waitForSelector('.fr-banner.fr-error', { timeout: 7500 });
  await page.waitForFunction(() => !document.querySelector('.fr-details .fr-dl'), null, { timeout: 3000 });
  const dt = await text(page, '.fr-details');
  ok(dt.includes('start the MyBrainFocus service') && !dt.includes('Running'), `down details explain how to fix (got "${dt.replace(/\n/g, ' ')}")`);
  await page.evaluate(() => document.querySelector('.fr-details').scrollIntoView({ block: 'end' }));
  await shot('focus-15-details-down');
  h.setHelperDown(false);
  await page.click('.fr-banner .fr-retry');
  await page.waitForSelector('.fr-banner.fr-ok', { timeout: 8000 });
  await page.waitForSelector('.fr-details .fr-dl', { timeout: 5000 });
  ok(true, 'Retry restores the rows');

  // (e) navigate away and back: one panel, closed again, no errors
  await page.goto(page.url().split('#')[0] + '#/settings');
  await page.waitForSelector('#content');
  await page.goto(page.url().split('#')[0] + '#/focus');
  await page.waitForSelector('.fr-block');
  ok((await page.locator('.fr-details').count()) === 1, 'exactly one details element after navigating back');
  ok(await page.evaluate(() => !document.querySelector('.fr-details').open), 'details start collapsed again');
  await page.waitForTimeout(1200);
}

// ---- Task 9: Locked option and partner setup ----
async function lockScenarios(page, shot, h) {
  const dialogs = () => page.locator('.fr-dialog').count();
  const closed = () => page.waitForFunction(() => !document.querySelector('.fr-dialog'));
  partnerKeys = await generatePartnerKeys(); // the Unlock scenarios sign with this key
  const valid = partnerKeys.publicKey;
  const noOverflow = () => page.evaluate(() => [...document.querySelectorAll('.fr-dialog')].every((d) => d.scrollWidth <= d.clientWidth));
  await h.db.run('DELETE FROM focus_sessions');
  const ll = await saveList(h.db, { name: 'Lockable', sites: ['lock-one.com', 'lock-two.com'], apps: [] });
  ok(ll.ok, 'list for the locked scenarios saved');
  await page.reload();
  await page.waitForSelector('.fr-banner.fr-ok', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('.fr-block').length === 0);

  // (a) helper down: Locked is disabled with the reason
  h.setHelperDown(true);
  await page.waitForSelector('.fr-banner.fr-error', { timeout: 7500 });
  await page.click('button:has-text("Start a block")');
  await page.waitForSelector('.fr-dialog .fr-start');
  ok(await page.evaluate(() => document.querySelector('input[type=radio][value=locked]').disabled), 'helper down: Locked radio is disabled');
  ok((await text(page, '.fr-dialog')).includes('The helper must be running to lock a block.'), 'helper down: the reason is shown');
  await shot('focus-16-locked-helper-down');
  await page.keyboard.press('Escape'); await closed();
  h.setHelperDown(false);
  await page.click('.fr-banner .fr-retry');
  await page.waitForSelector('.fr-banner.fr-ok', { timeout: 8000 });

  // (b) no partner: the setup button opens the partner dialog on top; Esc closes only that one
  await page.click('button:has-text("Start a block")');
  await page.waitForSelector('.fr-dialog .fr-start');
  await page.locator('.fr-dialog .fr-checkrow:has-text("Lockable") input').check();
  await page.click('.fr-moderow:has-text("Locked")');
  ok(await page.evaluate(() => document.querySelector('input[type=radio][value=locked]').checked), 'Locked radio selected');
  ok((await text(page, '.fr-dialog')).includes('Set up your partner first'), 'no partner: "Set up your partner first" shown');
  ok(await page.evaluate(() => document.querySelector('.fr-dialog button.primary').disabled), 'no partner: Start is disabled');
  await shot('focus-17-locked-no-partner');
  await page.click('.fr-dialog button:has-text("Set up your partner first")');
  await page.waitForSelector('.fr-ps');
  ok((await dialogs()) === 2, 'setup dialog opened on top of the start dialog');
  ok(await noOverflow(), 'no horizontal overflow in the dialogs');
  await shot('focus-18-partner-setup');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('.fr-dialog').length === 1);
  ok(await page.evaluate(() => !!document.querySelector('.fr-start') && !document.querySelector('.fr-ps')), 'Esc closed only the setup dialog');
  await page.click('.fr-dialog button:has-text("Set up your partner first")');
  await page.waitForSelector('.fr-ps');

  // (c) the page download works offline: a Blob with the partner page
  const dl = page.waitForEvent('download');
  await page.click('.fr-ps button:has-text("Save the partner page")');
  const file = await dl;
  ok(file.suggestedFilename() === 'partner-unlock.html', `partner page downloads as ${file.suggestedFilename()}`);

  // (d) a junk key: the helper's refusal shows, input is kept, dialog stays open
  ok(await page.evaluate(() => document.querySelector('.fr-ps button.primary').disabled), 'Save partner disabled while empty');
  await page.fill('.fr-ps input[type=text]', 'Sam <b>the</b> partner');
  await page.fill('.fr-ps textarea', 'not-a-key');
  await page.click('.fr-ps button.primary');
  await page.waitForFunction(() => document.querySelector('.fr-ps .fr-err:not([hidden])'));
  const refusal = await text(page, '.fr-ps .fr-err');
  ok(refusal.includes("isn't valid"), `junk key shows the helper's refusal ("${refusal}")`);
  ok(await page.evaluate(() => document.querySelector('.fr-ps .fr-err').getAttribute('role') === 'alert'), 'refusal is role=alert');
  ok((await page.inputValue('.fr-ps textarea')) === 'not-a-key' && (await page.inputValue('.fr-ps input[type=text]')) === 'Sam <b>the</b> partner', 'input is intact after the refusal');
  ok((await dialogs()) === 2, 'dialog stays open after the refusal');
  await shot('focus-19-partner-bad-key');

  // (e) Esc and overlay are inert while saving
  h.setHelperDelay(700);
  h.setPersistFail(true);
  await page.fill('.fr-ps textarea', valid);
  await page.click('.fr-ps button.primary');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  ok((await dialogs()) === 2, 'Esc and overlay click are inert while the partner is saving');
  await page.waitForFunction(() => !document.querySelector('.fr-ps'), null, { timeout: 8000 });
  h.setHelperDelay(0);
  h.setPersistFail(false);
  ok((await dialogs()) === 1, 'saved: setup dialog closed, start dialog still open');
  await page.waitForFunction(() => document.querySelector('.fr-notes')?.innerText.includes('lost on restart'), null, { timeout: 5000 });
  ok(true, `a successful save that came with a warning shows it in the Home note ("${(await text(page, '.fr-notes')).replace(/\n/g, ' ')}")`);
  ok(await page.evaluate(() => document.activeElement && document.activeElement !== document.body && document.querySelector('.fr-dialog').contains(document.activeElement)), 'focus moved into the start dialog after the setup closed');
  await page.waitForFunction(() => !document.querySelector('.fr-st-partner') || document.querySelector('.fr-st-partner').hidden);
  ok(await page.evaluate(() => !document.querySelector('.fr-st-lockedopts').hidden), 'locked options appear once the partner is set');

  // (f) the confirmation gates Lock it; the warning follows the waiting period
  ok((await text(page, '.fr-dialog button.primary')) === 'Lock it', 'Start button reads "Lock it"');
  ok(await page.evaluate(() => document.querySelector('.fr-dialog button.primary').disabled), 'Lock it disabled until confirmed');
  ok((await text(page, '.fr-lockwarn')) === lockedWarning(24), 'warning text for the 24 h default');
  await page.locator('.fr-lockwarn input').check();
  ok(await page.evaluate(() => !document.querySelector('.fr-dialog button.primary').disabled), 'Lock it enabled once confirmed');
  await page.click('.fr-moderow:has-text("Normal")');
  await page.click('.fr-moderow:has-text("Locked")');
  ok(await page.evaluate(() => !document.querySelector('.fr-lockwarn input').checked && document.querySelector('.fr-dialog button.primary').disabled), 'switching Normal and back clears the confirmation: Lock it disabled again');
  await page.locator('.fr-lockwarn input').check();
  await page.click('.fr-dialog .fr-delaychip:has-text("6 h")');
  ok((await text(page, '.fr-lockwarn')) === lockedWarning(6) && await page.evaluate(() => !document.querySelector('.fr-lockwarn input').checked), 'changing the period updates the warning and clears the confirmation');
  await page.fill('.fr-dialog input[id^="fr-st-delay-"]', '200');
  ok((await page.evaluate(() => document.querySelector('.fr-dialog .fr-err:not([hidden])')?.textContent)) === 'Enter a whole number of hours from 1 to 168.', 'custom hours over 168 are refused inline');
  await page.fill('.fr-dialog input[id^="fr-st-delay-"]', '');
  await page.click('.fr-dialog .fr-durchip:has-text("1 day")');
  ok(await page.evaluate(() => document.querySelector('.fr-durchip[aria-pressed=true]').textContent) === '1 day', '1 day chip exists in Locked');
  await page.fill('.fr-dialog input[id^="fr-st-custom-"]', '10081');
  ok((await page.evaluate(() => document.querySelector('.fr-dialog .fr-err:not([hidden])')?.textContent)).includes('10080'), 'custom minutes over 10080 are refused');
  await page.fill('.fr-dialog input[id^="fr-st-custom-"]', '10080');
  ok((await text(page, '.fr-st-summary')) === 'Locked for 7 days', 'summary reads Locked for 7 days');
  await page.fill('.fr-dialog input[id^="fr-st-custom-"]', '');
  await page.click('.fr-dialog .fr-durchip:has-text("25 min")');
  await page.click('.fr-dialog .fr-delaychip:has-text("24 h")');
  await page.locator('.fr-lockwarn input').check();
  ok(await noOverflow(), 'no horizontal overflow with Locked options open');
  await shot('focus-20-locked-options');

  // (g) Esc is inert while the locked start is pending; then the block exists
  h.setHelperDelay(700);
  await page.click('.fr-dialog button.primary');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  ok((await dialogs()) === 1, 'Esc and overlay click are inert while the locked start is pending');
  await closed();
  h.setHelperDelay(0);
  await page.waitForSelector('.fr-block');
  ok((await page.locator('.fr-block').count()) === 1, 'a block exists after the locked start');
  await shot('focus-21-locked-started');
}

// ---- Task 10: locked card and the Unlock early dialog (runs with the locked block from lockScenarios in place) ----
async function unlockScenarios(page, shot, h) {
  const closed = () => page.waitForFunction(() => !document.querySelector('.fr-dialog'));
  const open = () => page.evaluate(() => !!document.querySelector('.fr-dialog'));
  const cards = () => page.locator('.fr-block').count();
  const keys = partnerKeys;
  await h.db.run('UPDATE focus_partner SET name = ?', ['Sam']);
  await page.reload();
  await page.waitForSelector('.fr-block .fr-lock');
  await page.waitForSelector('.fr-banner.fr-ok', { timeout: 8000 });

  // (a) the locked card
  const card = await text(page, '.fr-block');
  ok(card.includes('Locked') && card.includes('Locked until'), 'locked card has the lock label and "Locked until <time>"');
  ok(await page.evaluate(() => !!document.querySelector('.fr-block .fr-lock')), 'lock label element exists');
  ok((await page.locator('.fr-block button:has-text("Cancel")').count()) === 0, 'locked card has NO Cancel button');
  ok((await page.locator('.fr-block button:has-text("Unlock early")').count()) === 1, 'locked card has Unlock early');
  ok((await page.locator('.fr-block button:has-text("Extend")').count()) === 1, 'locked card has Extend');
  await page.click('.fr-block button:has-text("Extend")');
  await page.waitForSelector('.fr-dialog');
  ok((await text(page, '.fr-dialog')).includes('can only make the lock longer'), 'Extend says it can only make the lock longer');
  await shot('focus-22-extend-locked');
  await page.keyboard.press('Escape'); await closed();

  // (b) list rows: Edit and Delete are disabled with the reason
  const lockedList = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.fr-list')].find((r) => r.innerText.includes('Lockable'));
    const [edit, del] = [...row.querySelectorAll('button')];
    return { editDisabled: edit.disabled, delDisabled: del.disabled, editTitle: edit.title, text: row.innerText };
  });
  ok(lockedList.editDisabled && lockedList.delDisabled, 'Edit and Delete are disabled for a list in a locked block');
  ok(/^In a locked block until \d{1,2}:\d{2}/.test(lockedList.editTitle) && /In a locked block until/.test(lockedList.text), `reason shown: "${lockedList.editTitle}"`);
  await page.evaluate(() => document.querySelector('.fr-lists').scrollIntoView({ block: 'center' }));
  await shot('focus-23-locked-list-rows');
  await page.evaluate(() => window.scrollTo(0, 0));

  // (c) the dialog and the code
  await page.click('.fr-block button:has-text("Unlock early")');
  await page.waitForSelector('.fr-dialog .fr-un');
  ok((await text(page, '.fr-dialog-title')) === 'Unlock early', 'Unlock early opens the dialog');
  const dt = await text(page, '.fr-dialog');
  ok(dt.includes('Ask my partner') && dt.includes('Wait it out') && dt.includes('24 hours'), 'both options shown, wait length is 24 hours');
  await shot('focus-24-unlock-dialog');
  await page.click('.fr-dialog button:has-text("Get a code")');
  await page.waitForSelector('.fr-un-codearea:not([hidden])');
  const code = await page.inputValue('.fr-un-code');
  ok(code.length > 10, `a code is shown (${code.slice(0, 12)}...)`);
  ok((await page.locator('.fr-dialog button:has-text("Copy")').count()) === 1, 'Copy button is shown');
  await page.click('.fr-dialog button:has-text("Copy")');
  await page.waitForFunction(() => document.querySelector('.fr-un-copymsg').textContent !== '');
  ok(true, `copy gave feedback and did not throw ("${await text(page, '.fr-un-copymsg')}")`);
  ok((await page.getByLabel("Partner's signed token").count()) === 1, 'token field is labelled');
  await shot('focus-25-unlock-code');

  // (d) wrong tokens: plain reason, role=alert, the lock stays
  await page.fill('.fr-un-token', 'garbage');
  await page.click('.fr-dialog button:has-text("Submit")');
  await page.waitForFunction(() => document.querySelector('.fr-un .fr-err:not([hidden])'));
  const e1 = await text(page, '.fr-un-opt .fr-err:not([hidden])');
  ok(e1.includes("isn't in the right format") && e1.includes('The lock stays on'), `garbage token: "${e1}"`);
  ok(await page.evaluate(() => document.querySelector('.fr-un .fr-err:not([hidden])').getAttribute('role') === 'alert'), 'error is role=alert');
  const other = await generatePartnerKeys();
  await page.fill('.fr-un-token', await signUnlock(other.privateKeyJwk, code, Date.now()));
  await page.click('.fr-dialog button:has-text("Submit")');
  await page.waitForFunction(() => /signed by your partner/.test(document.querySelector('.fr-un .fr-err:not([hidden])')?.textContent || ''));
  ok(true, 'a token signed by the wrong key says it was not signed by the partner key');
  await shot('focus-26-unlock-wrong-token');
  ok((await open()) && (await cards()) === 1, 'dialog stays open and the card stays after a wrong token');

  // (e) the right token removes the card
  await page.fill('.fr-un-token', await signUnlock(keys.privateKeyJwk, code, Date.now()));
  await page.click('.fr-dialog button:has-text("Submit")');
  await closed();
  await page.waitForFunction(() => document.querySelectorAll('.fr-block').length === 0, null, { timeout: 8000 });
  ok(true, 'a correctly signed token closed the dialog and removed the card');
  const after = await h.helperCall({ type: 'GetStatus' });
  ok(after.windows.every((w) => w.ends <= after.now_ms) && after.decision.blockSites.length === 0, 'the helper ended the window and blocks nothing');
  await shot('focus-27-unlocked');

  // (f) wait it out
  await startLocked(page, 120, 1);
  ok((await cards()) === 1 && (await page.locator('.fr-block .fr-lock').count()) === 1, 'second locked block started (2 h, 1 h wait)');
  await page.click('.fr-block button:has-text("Unlock early")');
  await page.waitForSelector('.fr-dialog .fr-un');
  ok((await text(page, '.fr-dialog')).includes('1 hour after you start waiting'), 'wait text names 1 hour');
  ok((await page.locator('.fr-dialog button:has-text("Cancel request")').isHidden()), 'no Cancel request before waiting');
  await page.click('.fr-dialog button:has-text("Start waiting")');
  await page.waitForFunction(() => /^Unlocks at \d/.test(document.querySelector('.fr-un-waitat')?.textContent || ''));
  ok(await page.locator('.fr-dialog button:has-text("Cancel request")').isVisible(), 'Unlocks at <time> and Cancel request shown');
  await shot('focus-28-wait-started');
  // Esc is inert while the cancel request is pending
  h.setHelperDelay(700);
  await page.click('.fr-dialog button:has-text("Cancel request")');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  ok(await open(), 'Esc and overlay click are inert while a request is pending');
  await page.waitForFunction(() => /Start waiting/.test(document.querySelector('.fr-dialog')?.innerText || '') && !document.querySelector('.fr-dialog button[data-fk="un-startwait"]').hidden);
  h.setHelperDelay(0);
  ok(true, 'cancelling the request returns to Start waiting');
  ok((await h.helperCall({ type: 'GetStatus' })).pending_unlocks.length === 0, 'helper has no pending unlock after cancelling');
  await page.keyboard.press('Escape'); await closed();
  ok((await cards()) === 1 && !(await text(page, '.fr-block')).includes('unless you cancel'), 'cancelling leaves the card, with no pending text');
  // double click starts one wait only
  await page.click('.fr-block button:has-text("Unlock early")');
  await page.waitForSelector('.fr-dialog .fr-un');
  h.setHelperDelay(400);
  await page.evaluate(() => { const b = document.querySelector('[data-fk="un-startwait"]'); b.click(); b.click(); });
  await page.waitForFunction(() => /^Unlocks at/.test(document.querySelector('.fr-un-waitat')?.textContent || ''));
  h.setHelperDelay(0);
  ok((await h.helperCall({ type: 'GetStatus' })).pending_unlocks.length === 1, 'double click sent a single request');
  await page.keyboard.press('Escape'); await closed();
  await page.waitForFunction(() => document.querySelector('.fr-block .fr-pending'));
  const pend = await text(page, '.fr-block .fr-pending');
  ok(/^Unlocks at \d{1,2}:\d{2}.* unless you cancel$/.test(pend), `pending card text: "${pend}"`);
  await shot('focus-29-pending-card');
  // reopening starts in the pending state
  await page.click('.fr-block button:has-text("Unlock early")');
  await page.waitForSelector('.fr-dialog .fr-un');
  ok(await page.locator('.fr-dialog button:has-text("Cancel request")').isVisible() && /Unlocks at/.test(await text(page, '.fr-un-waitat')), 'dialog opens in the pending state when a wait is running');
  await page.keyboard.press('Escape'); await closed();

  // (g) helper details list the pending unlock and the partner name
  if (!(await page.evaluate(() => document.querySelector('.fr-details').open))) await page.click('.fr-details > summary');
  await page.waitForFunction(() => /unlocks at/.test(document.querySelector('.fr-details')?.innerText || ''), null, { timeout: 8000 });
  const dm = await detailMap(page);
  ok(dm['Partner key'] === 'Sam (key set)', `details show the partner name (${dm['Partner key']})`);
  ok(/unlocks at \d/.test(dm['Pending unlocks']), `details list the pending unlock (${dm['Pending unlocks']})`);
  await page.evaluate(() => document.querySelector('.fr-details').scrollIntoView({ block: 'end' }));
  await shot('focus-30-details-pending');
  await page.evaluate(() => window.scrollTo(0, 0));

  // (h) the helper clock passes the wait: the card goes after the next poll
  await h.advanceHelperClock(61 * 60000);
  await page.waitForFunction(() => document.querySelectorAll('.fr-block').length === 0, null, { timeout: 12000 });
  ok(true, 'after the wait elapsed on the helper clock the card disappeared');
  await shot('focus-31-wait-elapsed');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
}

async function startLocked(page, minutes, delayHours) {
  await page.click('button:has-text("Start a block")');
  await page.waitForSelector('.fr-dialog .fr-start');
  await page.locator('.fr-dialog .fr-checkrow:has-text("Lockable") input').check();
  await page.click('.fr-moderow:has-text("Locked")');
  await page.click(`.fr-dialog .fr-durchip:has-text("${minutes === 120 ? '2 h' : '25 min'}")`);
  await page.click(`.fr-dialog .fr-delaychip:has-text("${delayHours} h")`);
  await page.locator('.fr-lockwarn input').check();
  await page.click('.fr-dialog button.primary');
  await page.waitForFunction(() => !document.querySelector('.fr-dialog'));
  await page.waitForSelector('.fr-block .fr-lock');
}
