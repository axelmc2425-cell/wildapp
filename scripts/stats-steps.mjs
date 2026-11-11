// Focus Room Stats page screenshots (harness steps file). Run (light, then --dark):
//   node scripts/shot.mjs /tmp/stats-shots --helper target/debug/focus-helper --steps scripts/stats-steps.mjs [--dark]
// Needs a focus-helper built with --features test-clock (AddUsage). Seeds ~400 days relative to today.
const ok = (cond, msg) => { if (!cond) throw new Error('ASSERT FAILED: ' + msg); console.log('ok:', msg); };

const APPS = ['chrome.exe', 'code.exe', 'msedge.exe', 'slack.exe', 'WINWORD.EXE', 'spotify.exe', 'explorer.exe', 'Teams.exe', 'devenv.exe', 'notepad.exe', 'figma.exe', 'steam.exe'];
const SITES = ['YouTube', 'Reddit', 'GitHub', 'Wikipedia', 'Gmail', 'Netflix', 'LinkedIn', 'Stack Overflow', 'Twitter', 'Amazon'];

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function seedDays(n = 400) {
  const rand = rng(12345);
  const out = [];
  const today = new Date();
  for (let i = 0; i < n; i += 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const wd = (d.getDay() + 6) % 7; // Monday = 0
    if (rand() < (wd >= 5 ? 0.35 : 0.06)) continue; // some days with no data
    const scale = (wd >= 5 ? 0.35 : 1) * (0.4 + rand() * 1.1);
    const apps = {};
    const picks = 3 + Math.floor(rand() * 6);
    for (let k = 0; k < picks; k += 1) {
      const name = APPS[Math.floor(rand() * rand() * APPS.length)]; // skewed: early names dominate
      apps[name] = (apps[name] || 0) + Math.round((300 + rand() * 6000) * scale);
    }
    const browser = (apps['chrome.exe'] || 0) + (apps['msedge.exe'] || 0);
    const sites = {};
    let siteSecs = 0;
    for (let k = 0; k < 2 + Math.floor(rand() * 5) && browser > 0; k += 1) {
      const name = SITES[Math.floor(rand() * rand() * SITES.length)];
      const v = Math.round(browser * (0.05 + rand() * 0.2));
      sites[name] = (sites[name] || 0) + v; siteSecs += v;
    }
    const other = Math.max(0, Math.min(browser - siteSecs, Math.round(browser * (0.1 + rand() * 0.3))));
    const total = Object.values(apps).reduce((a, b) => a + b, 0);
    out.push({ day: keyOf(d), total, apps, sites, other_browsing: other });
  }
  return out;
}

async function openStats(page) {
  await page.goto(page.url().split('#')[0] + '#/focus');
  await page.waitForSelector('.fr-home');
  await page.click('[data-fk="open-stats"]');
  await page.waitForSelector('.fr-stats');
  await page.waitForFunction(() => !document.querySelector('.fr-stats')?.innerText.includes('Loading usage'), null, { timeout: 8000 });
}
const choose = async (page, p) => {
  await page.click(`[data-fk="p-${p}"]`);
  await page.waitForFunction((x) => document.querySelector(`[data-fk="p-${x}"]`)?.getAttribute('aria-pressed') === 'true' && !document.querySelector('.fr-stats')?.innerText.includes('Loading usage'), p, { timeout: 8000 });
};
const overflow = (page) => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));

export default async function steps(page, shot, h) {
  // (1) empty state: nothing seeded yet, tracking on.
  h.setUsageTracking(true);
  await openStats(page);
  await shot('stats-1-empty');
  ok((await page.innerText('.fr-stats')).includes('No usage recorded yet'), 'empty state text is shown');

  // (2) seed and view each period
  const days = seedDays(400);
  for (const day of days) { const r = await h.helperCall({ type: 'AddUsage', day }); if (r.type !== 'Ok') throw new Error('AddUsage failed ' + JSON.stringify(r)); }
  console.log('seeded', days.length, 'days');
  await page.reload();
  await openStats(page);
  for (const p of ['day', 'week', 'month', 'year']) {
    await choose(page, p);
    await page.setViewportSize({ width: 1280, height: 2300 }); // tall, so the whole page is in one image
    await shot(`stats-2-${p}`);
    await page.setViewportSize({ width: 1280, height: 800 });
    const o = await overflow(page);
    ok(o.sw <= o.cw, `${p}: no horizontal page overflow (${o.sw} <= ${o.cw})`);
  }
  await choose(page, 'week');
  await page.click('[data-fk="table"]');
  await page.setViewportSize({ width: 1280, height: 1500 });
  await shot('stats-3-week-table');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('[data-fk="table"]');

  // (3) phone width
  await page.setViewportSize({ width: 390, height: 800 });
  await choose(page, 'week');
  await shot('stats-4-week-phone');
  const o = await overflow(page);
  ok(o.sw <= o.cw, `phone: no horizontal page overflow (${o.sw} <= ${o.cw})`);
  await choose(page, 'year');
  await shot('stats-5-year-phone');
  // The app shell has no collapsed sidebar, so also show the page at phone width without it.
  await page.addStyleTag({ content: '#sidebar{display:none !important}' });
  await choose(page, 'week');
  await shot('stats-4b-week-phone-nosidebar');
  const o2 = await overflow(page);
  ok(o2.sw <= o2.cw, `phone, no sidebar: no horizontal page overflow (${o2.sw} <= ${o2.cw})`);
  await page.setViewportSize({ width: 390, height: 3000 });
  await shot('stats-4c-week-phone-tall');
  await page.setViewportSize({ width: 390, height: 800 });
  await choose(page, 'year');
  await shot('stats-5b-year-phone-nosidebar');
  await page.setViewportSize({ width: 1280, height: 800 });

  // (4) helper down, no cache
  h.setHelperDown(true);
  await page.reload();
  await page.goto(page.url().split('#')[0] + '#/focus');
  await page.waitForSelector('.fr-home');
  await page.click('[data-fk="open-stats"]');
  await page.waitForSelector('[data-fk="down"]', { timeout: 10000 });
  await shot('stats-6-helper-down');
  h.setHelperDown(false);
}
