// Focus Room screenshot scenarios (harness steps file). Run:
//   node scripts/shot.mjs /tmp/focus-shots --helper target/debug/focus-helper --steps scripts/focus-steps.mjs [--dark]
import { saveList, createSessions } from '../src/modules/focus/store.js';
import { STARTERS } from '../src/modules/focus/starters.js';

const ok = (cond, msg) => { if (!cond) throw new Error('ASSERT FAILED: ' + msg); console.log('ok:', msg); };
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
  await page.goto(page.url().split('#')[0] + '#/secondbrain');
  await page.waitForSelector('.sb-list, #content');
  await page.goto(page.url().split('#')[0] + '#/focus');
  await page.waitForSelector('.fr-block');
  ok((await page.locator('.fr-banner').count()) === 1, 'exactly one banner after navigating back');
  await page.waitForTimeout(1500);
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

  // clean up: no lists left for the later scenarios
  await h.db.run('DELETE FROM focus_items'); await h.db.run('DELETE FROM focus_sessions'); await h.db.run('DELETE FROM focus_lists');
  await page.reload();
  await page.waitForSelector('.fr-welcome');
}
