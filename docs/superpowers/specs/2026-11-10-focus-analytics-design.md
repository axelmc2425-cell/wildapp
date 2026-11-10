# Focus Room analytics, sub-project 6a: usage tracking and Stats

Date: 2026-11-10. Status: draft, awaiting owner review.

Builds on `2026-11-08-focus-room-design.md` (helper, pipe protocol) and `2026-11-09-focus-room-ui-design.md` (screens). Order agreed with the owner: 5a pickers (building), recurring schedules (sub-project 3), daily and weekly time limits (6b), 6a analytics. Time limits reuse this tracking, so 6a's helper part ships before 6b. Uninstall protection is its own spec.

## Purpose

Show the owner where their time goes: which apps and websites they spend the most time on, total screen time, and daily, weekly, monthly and yearly averages, with graphs.

## Owner decisions

- Websites are measured from browser window titles (approximate, no browser add-on).
- Graphs and averages for day, week, month and year.
- The helper collects the data, so it keeps running when the app is closed and the app database cannot alter it.

## Scope

In: helper usage sampler, helper usage store and a `GetUsage` request, the Stats tab with summary cards and SVG charts, tests, checklist.

Out: time limits (6b), per-site exact timing (needs a browser extension), exporting stats, cloud sync, per-window-title detail, mobile.

## Success criteria

- With the helper running, time in the foreground program is counted per program and per day, within a few seconds' accuracy, and idle time is not counted.
- Browser time is attributed to a website when the tab title matches the built-in map or one of the owner's blocked sites; the rest is "Other browsing". Website figures are labelled as estimates.
- Only program names, website names and seconds are stored; window titles are never written to disk or logged.
- The Stats tab shows total, daily average, most-used app and the change against the previous period, plus the charts below, for Day, Week, Month and Year, in light and dark.
- Stats work with no data (clear empty state) and with the helper down (shows what was last read, with a notice).
- Pure and Rust logic is covered by tests; the Windows sampler is on the manual checklist.

## Helper changes (Rust)

- **Sampler** (`win/foreground.rs`, Windows only): every 5 seconds read the foreground window's process image name (`GetForegroundWindow`, `GetWindowThreadProcessId`, `QueryFullProcessImageNameW`) and, for browsers only, its title (`GetWindowTextW`). Idle: `GetLastInputInfo`; if the last input was more than 300 seconds ago, count nothing. A locked workstation or no foreground window counts nothing. Behind a `ForegroundSource` trait so the logic is tested with a fake.
- **Accounting** (`usage.rs`, portable): `UsageStore` keeps, per local day (`YYYY-MM-DD` in the helper's local time zone), total active seconds, seconds per program (normalized exe name) and seconds per website. Each sample adds `min(elapsed since the previous sample, 15)` seconds, so a stalled or suspended helper never invents time. At most 200 programs and 200 websites per day (the rest roll into `other`).
- **Website matching** (`sites.rs`, portable): a browser is one of `chrome.exe, msedge.exe, firefox.exe, brave.exe, opera.exe, vivaldi.exe`. A title matches a site when it contains the site's label (case-insensitive, whole word) from a built-in map of about 100 popular sites, or the stem of one of the active block lists' domains (pushed windows supply the domains; `reddit.com` gives `reddit`). The first match wins; none gives "Other browsing". The map is a plain constant table with its own tests.
- **Persistence**: its own file next to the lock state, atomic write with `.bak`, versioned, flushed at most once a minute and on shutdown; 730 days of daily rows are kept, older days are pruned. A corrupt file is kept as `*.corrupt-<unixms>` and the store starts empty with a warning in Status.
- **Protocol**: `GetUsage { from_day, to_day }` returns `{ type: "Usage", days: [{ day, total, apps: {name: secs}, sites: {name: secs}, other_browsing }] }` for the inclusive range (at most 400 days; `bad-request` otherwise). Status gains `usage_tracking: bool` (false when the sampler cannot run).
- The sampler is skipped on non-Windows builds, so Linux CI and the stdio test mode use a fake source (a test-only `AddUsage` request behind the `test-clock` feature seeds days for end-to-end tests).

## App changes (JavaScript)

- **Client** (`helper-client.js`): `getUsage(fromDay, toDay)`.
- **Pure stats** (`stats.js`, new): `rangeFor(period, today)` (Day, Week from Monday, Month, Year), `previousRange`, `summarize(days)` returning `{ total, dailyAverage, activeDays, topApp, topSite, perDay[], perWeekday[7], topApps[], topSites[] }`, `deltaVs(previous, current)`. Days with no rows count as zero for averages over the range up to today.
- **Charts** (`ui/charts.js`, new): plain SVG built with `h()`/`createElementNS`, no library, colors from CSS variables for light and dark: stacked daily bars (top 5 apps plus other), horizontal ranked bars with time and share, weekday average bars, and a year calendar heatmap (53 columns by 7 rows). Each chart has a text summary (`aria-label` and a visually available table toggle) and hover titles.
- **Stats tab** (`ui/stats-page.js`, new, reached from the Focus Room header next to Helper details): period switch, previous/next period arrows, summary cards (Total, Daily average, Most-used app, vs previous), then the charts. Loading, empty, helper-down and "tracking is off" states.
- Durations format as `3h 12m`; the day is the local calendar day; weeks start on Monday.

## Errors

- Helper down: the last loaded data stays on screen with "Showing the last data from <time>. The helper isn't running."; with none loaded, an empty state explains how to start the helper.
- `usage_tracking` false (non-Windows or sampler failure): a card says tracking is off and why, not zeros.
- A `GetUsage` failure shows a retry; the rest of the Focus Room is unaffected.

## Testing

- Rust: accounting (cap of 15 s per sample, idle not counted, day rollover at local midnight, 200-entry roll-up), website matching table (known titles, own block-list stems, "Other browsing", browser vs non-browser), persistence round trip and pruning at 730 days, corrupt file recovery, `GetUsage` range bounds and shape.
- JS: `stats.js` (ranges, previous range, averages including empty days, weekday averages, deltas, top lists, month and year boundaries), chart builders (element counts, no NaN, empty data), stats page states with a fake client.
- End to end with the real helper on Linux using the test-only `AddUsage`: seed days, `GetUsage` returns them.
- Screenshots in light and dark: Day, Week, Month, Year, empty state, helper-down.
- Windows checklist: foreground program is counted, idle stops counting after 5 minutes, locking the PC stops counting, browser tab titles attribute to the right site, tracking survives a reboot and the app being closed, a day boundary rolls over correctly.

## Decisions and limits

- Website time is an estimate from the tab title: a page whose title does not name the site, or a site not in the map or the owner's lists, counts as "Other browsing". Incognito and background tabs are not seen separately.
- Only the foreground window counts; audio, video on a second monitor and background programs do not.
- Titles are read in memory to choose a website and then discarded.
- Admin users can stop the service or delete the usage file; uninstall and service protection are sub-project 6c (uninstall protection).

## Open items

None.
