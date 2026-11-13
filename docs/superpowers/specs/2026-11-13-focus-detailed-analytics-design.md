# Focus Room detailed analytics (sub-project 7a): second-level tracking and deep stats

Date: 2026-11-13. Status: built (Tasks 1-9 of the plan; Windows checks in checklist section 18).

Builds on `2026-11-10-focus-analytics-design.md` (6a: daily totals, Stats page). Order agreed with the owner: 7a (this) first, then daily and weekly time limits (6b), then uninstall protection (6c).

## Intent

The owner wants the app to rival the best screen-time trackers and blockers, to cut distractions and raise productivity. For tracking that means seeing exactly where time goes, per app and per website, down to the hour, minute and second, with averages of every kind.

Today the helper stores only one total per app and per website per local day. It cannot answer "what did I do at 14:32?", "which hours am I most distracted?" or "how long did my longest focus stretch last?". Idle time is already excluded (no input for more than 300 s counts nothing); that stays.

## Goals

- Record every foreground stretch exactly: start and end to the second, program, and website when the program is a browser.
- A Today view with a timeline of the day that zooms hour, then minute, then second.
- Hour-of-day analytics that work for the full 730 days kept: a weekday-by-hour heatmap, and average usage per hour of the day.
- Averages of every kind: per day, per weekday, per hour of day, per app per active day, per week, per month.
- Focus metrics: longest stretch without switching program or leaving the keyboard, number of app switches per active hour, first and last activity of the day, and active-day streaks.
- A drill-down page per app or website: its timeline for a chosen day, daily trend, average per active day, share of total, peak hour, and the sites used inside it for browsers.
- Durations are shown to the second in detail views (`1h 04m 09s`) and compactly (`1h 04m`) in cards and charts.

## Non-goals

- Time limits and goals (6b), uninstall protection (6c), exporting, cloud sync, per-window-title detail, a browser extension, mobile.
- Productive/unproductive category scoring (can follow later; not in this project).

## Anti-goals

- Never store or log window titles; only program names, website labels and times (as today).
- Never invent time: a suspended or stalled helper must not fill gaps, and idle time is never counted.
- Do not make the Stats page slow or make the helper's files grow without bound.

## Constraints

- The existing helper design stays: a per-user sampler process reports to the LocalSystem service over the named pipe; the service does all accounting and storage. The app cannot alter stored usage.
- Existing `usage.json` (daily totals, 730 days) and its atomic-write, `.bak`, and quarantine behaviour stay. Existing protocol messages (`GetUsage`, `ReportForeground`) keep working; additions only.
- Windows-only behaviour cannot be run in CI; it goes on the manual checklist as before. Portable logic is covered by tests with fake clocks and fake sources.
- Vanilla JS ES modules, SVG charts without a library, light and dark themes, as today.

## Approaches considered

1. **Per-minute buckets.** One row per minute (about 1 MB a month). Cheap, but seconds are only an approximation and focus-stretch and switch metrics cannot be exact. Rejected: the owner asked for seconds.
2. **Session log plus hourly rollup (chosen).** Store every continuous stretch exactly for 90 days, and keep a 24-slot hourly total in each daily row for the full 730 days. Exact to the second, supports every requested metric, bounded size.
3. **Second-by-second counters.** Heavy and adds nothing over 2.

The owner approved approach 2 in conversation.

## Design

### Helper (Rust)

- **Sampling rate.** The sampler observes the foreground once per second (it was every 5 s). Reports may be sent each second or batched (for example every 5 s as a list of one-second observations with timestamps); the builder chooses, as long as stored times stay exact to the second and the pipe load stays small. Idle rule, lock rule and the 15 s cap on elapsed time per report are unchanged, so a stalled helper never invents time.
- **Stretches.** The service merges consecutive observations of the same program and the same website label into one stretch `{start, end, exe, site}` (unix seconds, local day derived at record time). A gap of more than 2 s between observations, an idle period or a locked screen ends the stretch. Window titles are used in memory only to pick the site label, as today.
- **Stretch storage.** One file per local day under a `sessions` folder next to `usage.json`, same atomic write and quarantine as `usage.json`, flushed at most once a minute and at shutdown. Kept for 90 days, then deleted. At most 20,000 stretches per day; beyond that new time still counts in the daily and hourly totals but is not logged as stretches.
- **Hourly rollup.** `DayUsage` gains `hours: [u32; 24]`, active seconds per local clock hour (index 0 to 23, local time, so a daylight-saving day simply has an hour with no or doubled data). Written for every new second of usage, kept 730 days. Days recorded before this change have no `hours`; the app treats it as absent, not zero.
- **Protocol additions.** `GetSessions { day }` returns `{ type: "Sessions", day, stretches: [{ start, end, exe, site }] }`, with `site` null when not a browser or unmatched. `GetUsage` rows gain `hours`. Status gains `sessions_tracking` info only if needed; otherwise unchanged. A test-only `AddSessions` behind the `test-clock` feature seeds stretches for end-to-end tests.
- Existing caps (64-character names, 200 apps and 200 sites per day) apply to daily totals as before; stretches store the already-capped label.

### App (JavaScript)

- **Client:** `getSessions(day)`.
- **Pure logic (`stats.js` and a new `stats-detail.js`):** averages per hour of day, per weekday-by-hour, per app per active day, per week and per month; focus metrics from stretches (longest stretch, switches per active hour, first and last activity, active-day streak); timeline layout for a zoom window (stretches clipped to the window, merged for drawing when too small to see); drill-down summaries. All pure and tested; day keys and week-from-Monday rules as today.
- **Stats page** gains:
  - **Today timeline**: a strip for the chosen day, colored by app, zoom to a 6-hour, 1-hour, 10-minute window, down to a minute across 1-second ticks; hover or tap shows `Chrome / youtube · 14:32:05 to 14:41:50 · 9m 45s`. Day selector with previous/next.
  - **Focus cards**: longest stretch, switches per hour, first and last activity, current and best streak, total active time with seconds.
  - **Hour-of-day charts**: average active time per hour (bar chart) and a weekday-by-hour heatmap for the selected range. For days without `hours` data these charts say how many days are included.
  - **Averages section**: per day, per weekday, per hour, per week, per month, per app per active day.
  - **Drill-down**: selecting an app or site opens its page with the content listed in Goals.
- Existing Day, Week, Month, Year periods and their charts stay. New views follow the same loading, empty, helper-down and tracking-off states.

## Errors and edge cases

- Helper down: last loaded data with a notice, as today. A day with no stretch file (older than 90 days or before this change) shows a clear "detailed timeline not available for this day; daily totals only" message while still showing totals.
- A corrupt stretch file is quarantined like `usage.json`; Status carries a warning.
- Clock moved back: stretches never overlap or go negative; an observation earlier than the last recorded end is ignored.
- Midnight: a stretch crossing local midnight is split at midnight.

## Testing

- Rust: stretch merging, gap/idle/lock breaks, midnight split, hourly rollup (including a daylight-saving day), 20,000 cap, 90-day pruning, atomic save and corrupt-file recovery, protocol shape and bounds.
- JS: every pure function above with empty, single-day and long-range data; timeline clipping and merging; page states with a fake client.
- End to end with the real helper on Linux using the test-only `AddSessions`.
- Screenshots (light and dark) of Today timeline at each zoom, heatmap, averages, drill-down, empty and helper-down states.
- Windows manual checklist: second accuracy against a stopwatch, idle exclusion, lock exclusion, a browser site, upgrade from an install with existing `usage.json`.

## Decisions from the builder check (my calls; change if wrong)

- **Local time is owned by the sampler.** Each report carries the user's local `day` and local `hour` (the service runs as SYSTEM and may have a different time zone). Stretches are stored as unix seconds plus that local day. On a daylight-saving day the repeated hour is summed into one slot.
- **Old sampler after upgrade:** it keeps sending 5-second reports without `hour` until the next sign-in. The service accepts them: daily totals and stretches still work, `hours` is skipped for that time. The stretch gap rule is "more than 2 s or 2x the report interval, whichever is larger". The 15 s cap applies to the span of one report.
- **Storage:** one file per day, rewritten atomically at most once a minute (about 1 MB at the 20,000 cap). A crash can lose up to a minute of stretches; `usage.json` totals are the authority. A day that hit the cap is marked truncated and the UI says "timeline incomplete after N stretches; totals are complete".
- **Definitions:** a focus stretch is an unbroken run in the same program, ending on a program change, idle or lock. Switches per active hour count program changes only (a website change inside a browser is not a switch). The same stretches feed the timeline and these metrics.
- **Ranges:** averages and heatmap follow the Day, Week, Month, Year selector. For Day, the hour chart shows that single day. Per-hour averages divide by days that have `hours` data, and the chart says how many days are included.
- **Drill-down:** the per-day timeline for an app or site covers the last 90 days; its daily trend, averages and the site breakdown inside a browser come from daily totals and so cover the full 730 days.

## Left to the builder

Report batching, file formats for stretch files, chart styling details, and the exact zoom levels and gestures.

## Calls made without the owner (change if wrong)

- 90 days of exact stretches, 730 days of hourly totals.
- One-second sampling.
- Productivity categories, exporting and goals are deferred.
