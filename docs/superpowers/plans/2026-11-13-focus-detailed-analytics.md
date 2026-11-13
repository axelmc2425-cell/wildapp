# Focus Room detailed analytics (7a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The helper records every foreground stretch to the second (90 days) plus hourly totals (730 days), and the Stats page gains a zoomable Today timeline, hour-of-day charts, averages, focus metrics and per-app drill-down.

**Architecture:** A portable `SessionStore` (stretch merging, per-day flat files) sits beside `UsageStore` inside `Daemon`. The Windows sampler now reports every second with the local hour. `DayUsage` gains `hours`. New pure JS (`stats-detail.js`), SVG builders (`charts-detail.js`) and page views extend the existing Stats page.

**Tech Stack:** Rust (existing crate, serde), vanilla JS ES modules, plain SVG, `node --test`, fake DOM at `tests/helpers/fake-dom.js`.

**Spec:** `docs/superpowers/specs/2026-11-13-focus-detailed-analytics-design.md` (builds on `2026-11-10-focus-analytics-design.md`).

## Global Constraints

- Sampler reports every 1 second; idle over 300 s, locked screen or no window counts nothing (unchanged). The per-report cap of 15 s stays. `MIN_REPORT_GAP_SECS` drops from 4 to 1.
- A report carries the user's local `day` and a new optional local `hour` (0 to 23). Old 5-second samplers without `hour` must still work (hours skipped, stretches and totals still recorded).
- A stretch is `{ start, end, exe, site }`: unix seconds, `site` null when not a browser or unmatched. Consecutive intervals of the same `exe` and `site` merge when the gap is at most `max(2, 2 x report interval)` seconds; idle, lock or no sample ends a stretch; a change of local `day` starts a new stretch; an interval ending at or before the last recorded end is ignored (clock moved back).
- Stretch storage: flat files `sessions-YYYY-MM-DD.json` in the state directory (NOT a subfolder: an unexpected subdirectory makes service adoption quarantine the whole state dir). Same atomic write, `.bak`, `.tmp` and `.corrupt-<unixms>` quarantine as `usage.json`; flushed at most once a minute and at shutdown; 90 days kept; at most 20,000 stretches per day, after which the day is marked `truncated` while daily totals and hours keep counting.
- `DayUsage.hours: [u32; 24]` (`#[serde(default)]`; absent in old rows and then not treated as zeros), kept 730 days. On a daylight-saving day the repeated hour is summed into one slot.
- Protocol: `ReportForeground` gains `hour: Option<u8>` (`#[serde(default)]`, 0 to 23 else `bad-request`). New `GetSessions { day }` answered by `Sessions { day, truncated: bool, stretches: [{start,end,exe,site}] }` (`bad-request` for a bad day). `GetUsage` rows carry `hours`. Test-only `AddSessions { day, truncated?, stretches }` behind the `test-clock` feature.
- Window titles are never stored or logged. Only program names, website labels and times.
- Focus stretch (metric) = unbroken run in the same program, ending on program change, idle or lock. App switches count program changes only. Per-hour averages divide by days that have `hours` data.
- Durations: compact `1h 04m` (existing `formatDuration`) and with seconds `1h 04m 09s` in detail views and tooltips.
- Light and dark themes via existing CSS variables; no chart library; weeks start Monday.
- Every subagent runs on Sonnet.

## Review Focus

- Clock moved back or a suspended PC must never create overlapping, negative or invented stretches: pinned in Task 2 and 3.
- A stretch crossing local midnight lands in two day files, and a day with no `hours` (older rows) is "not recorded", never zero: pinned in Tasks 2 and 5.
- A crash between flushes loses at most a minute of stretches and never corrupts files; a corrupt stretch file is quarantined, not deleted: pinned in Task 2 and Task 4 (adoption must keep `sessions-*` files).
- Day with no stretch file, a truncated day, and helper down each show their own message, not an empty chart: pinned in Task 8.
- Averages over a range with no data or a single day must not divide by zero or show NaN: pinned in Task 5 and 7.

---

### Task 1: Hourly totals and report hour (usage + protocol + sampler)

**Files:**
- Modify: `focus-helper/src/usage.rs`, `focus-helper/src/ipc.rs`, `focus-helper/src/daemon.rs` (`MIN_REPORT_GAP_SECS`, `ReportForeground` arm), `focus-helper/src/win/foreground.rs`
- Test: `focus-helper/tests/usage.rs`, `focus-helper/tests/usage_protocol.rs`

**Interfaces:**
- Produces: `Sample { exe, title, idle_secs, day, hour: Option<u8> }`; `DayUsage.hours: [u32; 24]` with `#[serde(default)]` and a `hours_recorded` flag is NOT needed: a `Vec<u32>` that is empty when absent is simpler. Use `pub hours: Vec<u32>` (empty = not recorded, else exactly 24). `Request::ReportForeground { exe, title, idle_secs, day, #[serde(default)] hour: Option<u8> }`. `Sample` gains `hour`.

- [ ] **Step 1: Write failing tests**
  - `usage.rs`: `record_with_hour_adds_to_that_hour_slot` (a sample with `hour: Some(14)` and 5 elapsed seconds gives `hours.len()==24`, `hours[14]==5`, `total==5`); `record_without_hour_leaves_hours_empty`; `hours_sum_to_total_when_every_sample_has_hour`; `hours_roundtrip_and_old_file_without_hours_loads` (old JSON row lacking `hours` loads with empty `hours`).
  - `usage_protocol.rs`: `report_with_hour_ok`, `report_with_hour_24_is_bad_request`, `report_without_hour_still_ok` (old sampler), `get_usage_rows_include_hours`.
- [ ] **Step 2: Run** `cd focus-helper && cargo test --test usage --test usage_protocol` and see FAIL.
- [ ] **Step 3: Implement.** `UsageStore::record` credits `secs` to `hours[hour]` when `sample.hour` is `Some`, creating the 24-slot vec on first use for that day (if the day already has seconds without hours, leave `hours` empty rather than mixing). Add the field to `Request::ReportForeground`, validate `hour <= 23` in the `daemon.rs` arm (message "hour must be 0 to 23"), set `MIN_REPORT_GAP_SECS` to 1 (update any test that assumed 4). In `win/foreground.rs` set `REPORT_EVERY` to 1 s, read the local hour with `GetLocalTime` (`wHour`) beside `local_day`, include `"hour"` in the request JSON, and add it to `Sample`.
- [ ] **Step 4: Run** `cargo test` in `focus-helper` (all tests) and `cargo build --features test-clock`; expect PASS.
- [ ] **Step 5: Commit** `feat(helper): hourly usage totals and report hour`.

### Task 2: Stretch store (`sessions.rs`, portable)

**Files:**
- Create: `focus-helper/src/sessions.rs`; Modify: `focus-helper/src/lib.rs` (`pub mod sessions;`)
- Test: `focus-helper/tests/sessions.rs`

**Interfaces:**
- Produces:
  - `pub struct Stretch { pub start: i64, pub end: i64, pub exe: String, pub site: Option<String> }` (serde, Clone, PartialEq, Debug).
  - `pub struct DayStretches { pub truncated: bool, pub stretches: Vec<Stretch> }`.
  - `pub const MAX_STRETCHES_PER_DAY: usize = 20_000; pub const KEEP_SESSION_DAYS: usize = 90;`
  - `pub struct SessionStore` with `new()`, `record(&mut self, day: &str, exe: &str, site: Option<&str>, start: i64, end: i64, interval_secs: u64)` (merge/ignore rules from Global Constraints), `day(&self, day: &str) -> Option<DayStretches>`, `set_day(&mut self, day: &str, d: DayStretches)` (test seeding), `prune(&mut self)` (keep newest 90 days), `dirty_days(&self) -> Vec<String>`, `mark_clean(&mut self)`.
  - Files: `pub fn session_file(dir: &Path, day: &str) -> PathBuf` (`sessions-YYYY-MM-DD.json`), `pub fn save_day(dir: &Path, day: &str, d: &DayStretches) -> io::Result<()>` (atomic, `.bak`), `pub fn load_day(dir: &Path, day: &str, unix_ms: i64) -> Option<(DayStretches, bool)>` (bool = loaded from backup; corrupt main file renamed to `sessions-<day>.json.corrupt-<unixms>`), `pub fn delete_old_files(dir: &Path, keep_days: &[String])`. Mirror the structure and versioned envelope of `usage.rs` `save`/`load`.

- [ ] **Step 1: Write failing tests** in `focus-helper/tests/sessions.rs`: `merges_same_program_and_site_within_gap`, `different_site_makes_new_stretch`, `gap_over_two_seconds_splits`, `gap_tolerates_five_second_reports` (interval 5, gap 9 merges, 11 splits), `new_day_starts_new_stretch`, `earlier_or_overlapping_interval_ignored` (clock back), `cap_marks_truncated_and_stops_adding` (20,001st stretch not stored, `truncated` true), `prune_keeps_newest_90_days`, `save_load_roundtrip`, `load_falls_back_to_bak`, `corrupt_file_is_quarantined_and_returns_none`, `no_file_returns_none`, `record_dirties_only_that_day`.
- [ ] **Step 2: Run** `cargo test --test sessions`; FAIL.
- [ ] **Step 3: Implement** per the signatures. Keep stretches ordered; `record` only extends or appends the last stretch of the day.
- [ ] **Step 4: Run** `cargo test --test sessions`; PASS.
- [ ] **Step 5: Commit** `feat(helper): per-day stretch store`.

### Task 3: Daemon integration, protocol, adoption

**Files:**
- Modify: `focus-helper/src/daemon.rs` (own a `SessionStore` and `sessions_dir` = state dir; record in `report_foreground`; flush dirty days at most once a minute with `usage` flush and in the shutdown flush; prune; `GetSessions` arm), `focus-helper/src/ipc.rs` (`Request::GetSessions { day }`, `Response::Sessions`, daemon-only like `GetUsage`), `focus-helper/src/service_logic.rs` (`classify_child`/`EXPECTED_STATE_FILES`/`is_quarantine_name` accept `sessions-YYYY-MM-DD.json`, `.bak`, `.tmp`, and `.corrupt-` variants as `ResetAcl` and never delete quarantined ones), `focus-helper/src/main.rs` (test-only `AddSessions`, same pattern as `AddUsage`)
- Test: `focus-helper/tests/usage_protocol.rs`, `focus-helper/tests/daemon.rs`, unit tests in `service_logic.rs`

**Interfaces:**
- Consumes: Task 1 `Sample.hour`, Task 2 `SessionStore`/`save_day`/`load_day`.
- Produces: protocol shapes in Global Constraints. `report_foreground` records the interval `[wall_s - elapsed, wall_s]` (wall seconds from the service clock) with the report's `day`, `exe`, matched `site` (same label logic as `usage.record`); idle, none and locked samples record nothing.

- [ ] **Step 1: Write failing tests:** a sequence of 1-second reports for one program yields one stretch via `GetSessions`; switching program yields two; a browser site title yields `site`; idle sample ends the stretch; `GetSessions` for a day with no data returns empty `stretches`, `truncated:false`; bad day string is `bad-request`; stretches survive restart (flush then reload from the same dir); `classify_child("sessions-2026-11-13.json", false, false)` is `ResetAcl`, also `.bak`, `.tmp`, and `.corrupt-123`; `classify_child("sessions-x.json", ..)` is `RemoveFile`; a sessions file older than 90 days is deleted on prune.
- [ ] **Step 2: Run** `cargo test`; FAIL.
- [ ] **Step 3: Implement** as described. Load per-day files lazily on `GetSessions` or when recording into a day not yet in memory; startup loads only today. `AddSessions` seeds and saves.
- [ ] **Step 4: Run** `cargo test` and `cargo build --features test-clock`; PASS.
- [ ] **Step 5: Commit** `feat(helper): stretch recording, GetSessions, adoption of session files`.

### Task 4: Client and pure detail logic (`stats-detail.js`)

**Files:**
- Create: `src/modules/focus/stats-detail.js`; Modify: `src/modules/focus/helper-client.js`, `src/modules/focus/controller.js` (add `getSessions(day)` next to `getUsage`, same `{ok, down, message, code}` result shape and the no-op in the unavailable stub)
- Test: `tests/focus-stats-detail.test.js`, `tests/focus-client.test.js`, `tests/focus-controller.test.js`

**Interfaces:**
- Produces from `stats-detail.js` (all pure, exported):
  - `hourlyAverages(days) -> { hours: number[24] (avg secs per hour), daysCounted: number }` (only days with a 24-long `hours`; empty input gives zeros and `daysCounted: 0`).
  - `weekdayHourGrid(days) -> { grid: number[7][24] (avg secs, Monday=0), counts: number[7] }`.
  - `periodAverages(days, range, today) -> { perDay, perWeekday[7], perWeek, perMonth, perApp: [{name, perActiveDay, total, activeDays}] }` (empty days up to today count as zero for perDay/perWeek/perMonth; `perApp` averages over days the app was used).
  - `focusMetrics(stretches) -> { longestStretchSecs, longestStretchExe, switchesPerActiveHour, firstStart, lastEnd, activeSecs, stretchCount }` using the focus-stretch and switch definitions in Global Constraints.
  - `activeStreaks(days, today) -> { current, best }` (a day with `total > 0` is active).
  - `timelineWindow(stretches, fromSec, toSec) -> [{ start, end, exe, site }]` clipped to the window, dropping empty; `mergeTiny(blocks, secsPerPx, minPx = 1)` merges adjacent same-key blocks and drops sub-pixel gaps for drawing.
  - `appDrilldown(days, name, kind) -> { total, activeDays, perActiveDay, shareOfTotal, peakHour (or null when no hours), daily: [{day, secs}], sites: [{name, secs}] (for browsers) }`, `kind` is `'app'` or `'site'`.
  - `formatDurationSecs(secs) -> '1h 04m 09s'` (`'0s'` for 0, `'42s'`, `'3m 05s'`).

- [ ] **Step 1: Write failing tests** with exact values: hourly average of two days (`hours[14]` = 3600 and 1800) gives 2700 for slot 14, `daysCounted: 2`; a day with empty `hours` is excluded; `focusMetrics` on `[A 0-600, A 600-900, B 900-960]` gives longest 900 (A merged), 1 switch over active time 960 s; `timelineWindow` clips a stretch spanning the window start; `formatDurationSecs(3849)` is `'1h 04m 09s'`; empty inputs return zeros, no NaN anywhere (`JSON.stringify` has no `null` from NaN check: assert `Number.isFinite`); `activeStreaks` over a gap resets current but keeps best; client test: `getSessions('2026-11-13')` sends `{type:'GetSessions', day}`; controller returns `{ok:true, ...}` and maps down/error like `getUsage`.
- [ ] **Step 2: Run** `node --test tests/focus-stats-detail.test.js tests/focus-client.test.js tests/focus-controller.test.js`; FAIL.
- [ ] **Step 3: Implement** the signatures; reuse `addDays`, `dayKey` and `formatDuration` from `stats.js` rather than duplicating.
- [ ] **Step 4: Run** the same command plus `npm test`; PASS.
- [ ] **Step 5: Commit** `feat(focus): detail statistics logic and getSessions`.

### Task 5: Detail charts (`ui/charts-detail.js`)

**Files:**
- Create: `src/modules/focus/ui/charts-detail.js`
- Test: `tests/focus-charts-detail.test.js`

**Interfaces:**
- Consumes: `chartColor`, `scale`, `niceMax`, `heatLevel` from `charts.js`; `h` from `ui/dom.js`; block and stats shapes from Task 4.
- Produces (SVG elements built like `charts.js`, each with `aria-label` and per-mark `<title>` tooltips):
  - `timelineStrip(blocks, { fromSec, toSec, width = 720, colorOf }) -> SVGElement` (one rect per block, tooltip `exe / site · HH:MM:SS to HH:MM:SS · 9m 45s`, tick marks adaptive to the window length: hours, 10 minutes, minutes, 10 seconds), `timelineLegend(names, colorOf)`.
  - `hourBars(hours /*24*/, daysCounted) -> SVGElement`.
  - `weekdayHourHeatmap(grid) -> SVGElement` (7 rows by 24 columns, `heatLevel` classes).
  - `dailyTrendBars(daily) -> SVGElement` for the drill-down.

- [ ] **Step 1: Write failing tests** with the existing fake DOM: element counts (`timelineStrip` with 3 blocks has 3 block rects), no `NaN` in any attribute for empty and single-block input, heatmap has 168 cells, `hourBars` has 24 bars and an `aria-label` mentioning the days counted, tooltip text for a known block is exactly `Chrome / youtube · 14:32:05 to 14:41:50 · 9m 45s`.
- [ ] **Step 2: Run** `node --test tests/focus-charts-detail.test.js`; FAIL.
- [ ] **Step 3: Implement** the four builders; colors from CSS variables via `chartColor`.
- [ ] **Step 4: Run** the test and `npm test`; PASS.
- [ ] **Step 5: Commit** `feat(focus): detail chart builders`.

### Task 6: Stats page: Today timeline and focus cards

**Files:**
- Modify: `src/modules/focus/ui/stats-page.js` (add a `Today` view alongside Day/Week/Month/Year; keep existing views untouched), `src/modules/focus/ui/home.js` only if navigation needs it
- Test: `tests/focus-stats-page.test.js`

**Interfaces:**
- Consumes: `controller.getSessions(day)` (Task 4), `timelineWindow`, `mergeTiny`, `focusMetrics`, `activeStreaks` (Task 4), `timelineStrip`, `timelineLegend` (Task 5).
- Produces: a `Today` period button (`data-fk="p-today"`) showing day navigation (previous/next day), the timeline strip with zoom buttons `data-fk="zoom-day|zoom-6h|zoom-1h|zoom-10m"` and a scroll position control (a range input `data-fk="pan"`) for the sub-day zooms, the focus cards (longest stretch with its program, switches per active hour, first and last activity, current and best streak, active time with seconds), states: loading, helper down (last data plus notice), tracking off, no detailed data for that day ("detailed timeline not available for this day; daily totals only" when the day has totals but no stretches), truncated notice ("timeline incomplete after N stretches; totals are complete").

- [ ] **Step 1: Write failing tests** with a fake controller: Today view renders the strip for a seeded day; zoom buttons change the window label; a day with usage totals but empty stretches shows the "not available" message; `truncated: true` shows the notice; helper down shows the notice; previous day button requests the previous day; no `NaN` text anywhere.
- [ ] **Step 2: Run** `node --test tests/focus-stats-page.test.js`; FAIL.
- [ ] **Step 3: Implement** inside the existing page structure (same `load`/`render`/`cache`/`seq` pattern; a separate cache key for sessions).
- [ ] **Step 4: Run** that test and `npm test`; PASS.
- [ ] **Step 5: Commit** `feat(focus): Stats Today timeline and focus cards`.

### Task 7: Stats page: hour-of-day charts and averages

**Files:**
- Modify: `src/modules/focus/ui/stats-page.js`
- Test: `tests/focus-stats-page.test.js`

**Interfaces:**
- Consumes: `hourlyAverages`, `weekdayHourGrid`, `periodAverages` (Task 4), `hourBars`, `weekdayHourHeatmap` (Task 5).
- Produces: below the existing charts on Day/Week/Month/Year: an "Hours of the day" section (hour bars and weekday-by-hour heatmap; caption "Based on N days with hour data" and a note when N is below the range's day count) and an "Averages" section: per day, per weekday, per week, per month, and a ranked list of apps by average per active day, each durations compact. If no day in range has hour data, show "Hour detail is recorded from the update onwards" instead of empty charts.

- [ ] **Step 1: Write failing tests:** with two seeded days having `hours`, the hour bars section renders with caption "Based on 2 days with hour data"; with seeded days lacking `hours` the placeholder message shows and no chart; Day period shows only that day's hour bars; averages section shows the exact per-day average for known data; empty range shows no NaN.
- [ ] **Step 2: Run** `node --test tests/focus-stats-page.test.js`; FAIL.
- [ ] **Step 3: Implement** the two sections reusing the page's existing `asTable` toggle and `dataTable` for the accessible table.
- [ ] **Step 4: Run** that test and `npm test`; PASS.
- [ ] **Step 5: Commit** `feat(focus): Stats hour-of-day charts and averages`.

### Task 8: Drill-down page

**Files:**
- Modify: `src/modules/focus/ui/stats-page.js` (ranked app and site rows become buttons; a drill-down sub-view with back button)
- Test: `tests/focus-stats-page.test.js`

**Interfaces:**
- Consumes: `appDrilldown` (Task 4), `dailyTrendBars`, `hourBars`, `timelineStrip` (Task 5), `controller.getSessions`.
- Produces: opening an app or site shows total, active days, average per active day, share of total, peak hour, daily trend (over the current range), that item's timeline for a chosen day within the last 90 days (blocks filtered to the app or site), and for a browser the sites used inside it (from daily totals). Outside the 90-day window the timeline says detail is not kept that far back.

- [ ] **Step 1: Write failing tests:** clicking a ranked row opens the drill-down with exact total and average; back returns to the previous view and period; the timeline filters to that app; a day older than 90 days shows the not-kept message; a site drill-down omits the inner-sites list; browser drill-down lists sites.
- [ ] **Step 2: Run** `node --test tests/focus-stats-page.test.js`; FAIL.
- [ ] **Step 3: Implement** with a `view` state (`'main' | 'drill'`) and `drill = { name, kind }`.
- [ ] **Step 4: Run** that test and `npm test`; PASS.
- [ ] **Step 5: Commit** `feat(focus): Stats app and site drill-down`.

### Task 9: End to end, screenshots, docs, checklist

**Files:**
- Modify: `tests/focus-analytics-e2e.test.js` (or create `tests/focus-detail-e2e.test.js`), `scripts/stats-steps.mjs`, `docs/windows-checklist.md` (find the existing checklist file with Grep for "checklist"; add a section), the Focus Room user doc that mentions Stats (Grep "usage.json" in `docs/`), `focus-helper/README` if present
- Test: the e2e test itself

**Interfaces:**
- Consumes: everything above; helper built with `--features test-clock` and the test-only `AddUsage` and `AddSessions`.

- [ ] **Step 1: Write the failing e2e test:** start the real helper (same harness as `focus-analytics-e2e.test.js`), seed a day with `AddUsage` (with `hours`) and `AddSessions`, then through the client check `GetUsage` rows carry `hours`, `GetSessions` returns the seeded stretches, a bad day is rejected, and a truncated day reports `truncated: true`.
- [ ] **Step 2: Run** `node --test tests/focus-detail-e2e.test.js` with the helper built; FAIL then implement any gaps; PASS.
- [ ] **Step 3: Extend** `scripts/stats-steps.mjs` with steps for Today at each zoom, hour charts, averages, drill-down, empty and truncated states, light and dark; run it and save screenshots to the scratchpad `shots` folder (not committed).
- [ ] **Step 4: Docs:** checklist section for Windows: second accuracy against a stopwatch (switch apps at known times, compare timeline), idle exclusion at 5 minutes, lock exclusion, a browser site stretch, upgrade over an existing install with `usage.json` (old days keep totals, no hour data), stretch files survive a service restart, and the state directory still adopts cleanly with `sessions-*` files present. Document accepted limits (up to a minute of stretches lost on a crash, hour boundary skew of one second, old sampler until next sign-in).
- [ ] **Step 5: Run** the full suites: `npm test`, `cd focus-helper && cargo test`, `cargo build --features test-clock`, and the e2e; PASS. Commit `test/docs: detailed analytics end to end, checklist`.
