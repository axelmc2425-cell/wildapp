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

  await detailSteps(page, shot, h);
}

// ---- detailed analytics: Today timeline, hour charts, averages, drill-down ----
const midnight = (back) => { const d = new Date(); return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime() / 1000); };
// A believable working day: [startHour, minutes, exe, site, adjacent]. `adjacent` starts the stretch the instant the previous one ends (a program switch with no gap).
const PLAN = [[8.5, 40, 'code.exe', null], [9.2, 25, 'chrome.exe', 'GitHub', true], [9.7, 50, 'code.exe', null], [10.6, 12, 'chrome.exe', 'YouTube'], [10.9, 35, 'slack.exe', null, true],
  [11.6, 70, 'code.exe', null], [13.1, 20, 'chrome.exe', 'Reddit'], [13.5, 15, 'chrome.exe', null], [14.0, 55, 'WINWORD.EXE', null, true], [15.1, 30, 'chrome.exe', 'YouTube'],
  [15.7, 45, 'code.exe', null, true], [16.5, 18, 'Teams.exe', null], [16.9, 40, 'code.exe', null]];
function stretchesFor(back, nowCap) {
  const base = midnight(back);
  const out = [];
  let prevEnd = null;
  for (const [startH, mins, exe, site, adjacent] of PLAN) {
    const start = adjacent && prevEnd != null ? prevEnd : base + Math.round(startH * 3600);
    let end = start + mins * 60;
    if (nowCap && start >= nowCap) continue;
    if (nowCap) end = Math.min(end, nowCap);
    prevEnd = end;
    out.push({ start, end, exe: exe.toLowerCase(), site });
  }
  return out;
}
function usageFor(back, stretches) {
  const apps = {}; const sites = {}; const hours = Array(24).fill(0); let browser = 0; let siteSecs = 0;
  const base = midnight(back);
  for (const s of stretches) {
    for (let t = s.start; t < s.end;) {
      const hr = Math.floor((t - base) / 3600);
      const cut = Math.min(s.end, base + (hr + 1) * 3600);
      const secs = cut - t;
      apps[s.exe] = (apps[s.exe] || 0) + secs; hours[Math.min(23, hr)] += secs;
      if (s.exe === 'chrome.exe') { browser += secs; if (s.site) { sites[s.site] = (sites[s.site] || 0) + secs; siteSecs += secs; } }
      t = cut;
    }
  }
  const total = Object.values(apps).reduce((a, b) => a + b, 0);
  return { day: keyOf(new Date(base * 1000)), total, apps, sites, other_browsing: browser - siteSecs, hours };
}
const must = (r) => { if (r.type !== 'Ok') throw new Error('seed failed ' + JSON.stringify(r)); };

async function detailSteps(page, shot, h) {
  await page.setViewportSize({ width: 1280, height: 800 });
  h.setUsageTracking(true);
  // 30 days with hours; the last two also carry stretches.
  for (let back = 0; back < 35; back += 1) {
    const base = back === 0 ? stretchesFor(0, Math.floor(Date.now() / 1000) - 120) : stretchesFor(back);
    const wd = (new Date(midnight(back) * 1000).getDay() + 6) % 7;
    if (back > 1 && wd >= 5) continue;
    const st = back === 0 && base.length === 0 ? stretchesFor(1) : base;
    const u = usageFor(back, st.map((s) => (back === 0 && base.length === 0 ? { ...s, start: s.start + 86400, end: s.end + 86400 } : s)));
    must(await h.helperCall({ type: 'AddUsage', day: u }));
    if (back <= 1) must(await h.helperCall({ type: 'AddSessions', day: u.day, truncated: false, stretches: base.length || back ? st : [] }));
  }
  await page.reload();
  await openStats(page);
  await choose(page, 'today');
  await page.waitForSelector('[data-fk="strip"]', { timeout: 8000 }).catch(async (e) => { await shot('detail-debug'); console.log((await page.innerText('.fr-stats')).slice(0, 600)); throw e; });
  await page.setViewportSize({ width: 1280, height: 1900 });
  for (const z of ['day', '6h', '1h', '10m']) {
    await page.click(`[data-fk="zoom-${z}"]`);
    const at = { '6h': 8 * 3600, '1h': 9 * 3600 + 1800, '10m': 10 * 3600 + 2400 }[z]; // 08:00, 09:30, 10:40: where the seeded day has activity
    if (at !== undefined) await page.evaluate((v) => { const el = document.querySelector('[data-fk="pan"]'); el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, at);
    await shot(`detail-1-today-zoom-${z}`);
  }
  await page.click('[data-fk="zoom-day"]');
  await page.click('[data-fk="table"]');
  await shot('detail-1b-today-table');
  await page.click('[data-fk="table"]');
  for (const p of ['week', 'month']) {
    await choose(page, p);
    await page.setViewportSize({ width: 1280, height: 2600 });
    await shot(`detail-2-${p}-hours-averages`);
    const t = await page.innerText('.fr-stats');
    ok(/hour/i.test(t), `${p}: hour section text present`);
  }
  // drill-down for an app and for a site
  await choose(page, 'week');
  await page.setViewportSize({ width: 1280, height: 1800 });
  await page.click('[data-fk="app-code.exe"]');
  await page.waitForSelector('[data-fk="drill-day"]');
  await page.waitForFunction(() => !document.querySelector('.fr-stats')?.innerText.includes('Loading'), null, { timeout: 8000 });
  await shot('detail-3-drill-app');
  await page.click('[data-fk="drill-back"]');
  await page.click('[data-fk="site-YouTube"]');
  await page.waitForSelector('[data-fk="drill-day"]');
  await page.waitForFunction(() => !document.querySelector('.fr-stats')?.innerText.includes('Loading'), null, { timeout: 8000 });
  await shot('detail-3b-drill-site');
  await page.click('[data-fk="drill-prev"]');
  await page.waitForTimeout(300);
  await shot('detail-3c-drill-site-prev-day');
  await page.click('[data-fk="drill-back"]');

  // phone width, Today
  await choose(page, 'today');
  await page.addStyleTag({ content: '#sidebar{display:none !important}' });
  await page.setViewportSize({ width: 390, height: 2600 });
  await shot('detail-4-today-phone');
  await page.click('[data-fk="zoom-1h"]');
  await shot('detail-4b-today-phone-1h');
  const ov = await overflow(page);
  ok(ov.sw <= ov.cw, `detail phone: no horizontal page overflow (${ov.sw} <= ${ov.cw})`);
  await choose(page, 'week');
  await page.setViewportSize({ width: 390, height: 3600 });
  await shot('detail-4c-week-phone-hours');
  await page.setViewportSize({ width: 1280, height: 800 });

  // Today: totals but no detail ("timeline not available")
  const today = usageFor(0, stretchesFor(0, Math.floor(Date.now() / 1000) - 120));
  must(await h.helperCall({ type: 'AddSessions', day: today.day, truncated: false, stretches: [] }));
  await page.reload(); await openStats(page); await choose(page, 'today');
  await page.setViewportSize({ width: 1280, height: 1500 });
  await shot('detail-5-today-no-detail');
  // Today: truncated timeline
  must(await h.helperCall({ type: 'AddSessions', day: today.day, truncated: true, stretches: stretchesFor(0, Math.floor(Date.now() / 1000) - 120).slice(0, 5) }));
  await page.reload(); await openStats(page); await choose(page, 'today');
  await shot('detail-6-today-truncated');
  // Week with days that have no hours: placeholder
  must(await h.helperCall({ type: 'AddUsage', day: { ...today, hours: [] } }));
  await page.reload(); await openStats(page); await choose(page, 'week');
  await page.setViewportSize({ width: 1280, height: 2400 });
  await shot('detail-7-week-hours-partial');
  await page.setViewportSize({ width: 1280, height: 800 });
}
