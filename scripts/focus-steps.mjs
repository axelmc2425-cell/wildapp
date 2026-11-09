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
