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
  ok((await page.locator('.fr-dialog input[type=checkbox]').count()) === 2, 'one checkbox per list');
  ok((await page.locator('.fr-dialog input[type=checkbox]:checked').count()) === 0, 'no list pre-checked');
  ok(await startDisabled(), 'Start disabled with nothing checked');
  ok(await page.evaluate(() => !document.querySelector('.fr-dialog b') && document.querySelector('.fr-checkname').textContent.includes('<b>')), 'hostile list name is text');
  const t0 = await text(page, '.fr-dialog');
  ok(t0.includes('2 sites, 1 app') && t0.includes('1 site'), 'list summaries shown');
  ok(t0.includes('Normal: you can cancel any time.') && t0.includes('🔒 Locked, coming soon') && !t0.includes('Frozen'), 'normal + locked-coming-soon, no Frozen');
  ok(await page.evaluate(() => document.querySelector('.fr-locked').getAttribute('aria-disabled') === 'true' && document.querySelector('.fr-locked').tabIndex === -1), 'locked option is aria-disabled and not focusable');
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
