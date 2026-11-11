# Focus Room analytics (6a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The helper measures foreground time per program and per website (from browser titles), stores it by local day, serves it over `GetUsage`, and the app shows it on a Stats tab with summary cards and SVG charts.

**Architecture:** A portable Rust `UsageStore` (accounting, persistence in its own file) plus a portable website matcher are driven by a `Platform::foreground()` sample taken every 5 s by `Daemon::tick`. A Windows-only `win/foreground.rs` supplies samples; Linux and stdio use `NullPlatform` (no samples) and a test-only `AddUsage` request. The app adds `getUsage` to the helper client, a pure `stats.js`, a DOM-free-testable `charts.js` and a `stats-page.js` reached from the Focus Room header.

**Tech Stack:** Rust (serde, existing crate, `windows-sys` features added), vanilla JS ES modules, plain SVG, `node --test`, a fake DOM at `tests/helpers/fake-dom.js`.

**Spec:** `docs/superpowers/specs/2026-11-10-focus-analytics-design.md`

## Global Constraints

- Sampler period: 5 seconds. Idle: last input more than 300 seconds ago counts nothing. Locked workstation or no foreground window counts nothing.
- Each sample adds `min(elapsed since previous sample, 15)` seconds.
- At most 200 programs and 200 websites per day; the rest roll into key `other`.
- Browsers: `chrome.exe, msedge.exe, firefox.exe, brave.exe, opera.exe, vivaldi.exe`. A title matches a site when it contains the site's label (case-insensitive, whole word) from a built-in map of about 100 popular sites, or the stem of an active block-list domain (`reddit.com` gives `reddit`). First match wins; none gives "Other browsing".
- Window titles are never written to disk or logged; only program names, website names and seconds are stored.
- Day key: `YYYY-MM-DD` in the helper's local time zone. Weeks start Monday.
- Usage file: its own file next to the lock state, atomic write with `.bak`, versioned, flushed at most once a minute and on shutdown; 730 days kept; a corrupt file is kept as `*.corrupt-<unixms>` and the store starts empty with a warning in Status.
- `GetUsage { from_day, to_day }` is inclusive, at most 400 days, otherwise `bad-request`. Reply `{ type: "Usage", days: [{ day, total, apps: {name: secs}, sites: {name: secs}, other_browsing }] }`. Status gains `usage_tracking: bool` (`#[serde(default)]`).
- Durations format as `3h 12m`. Website figures are labelled as estimates.
- No JS chart library; colors come from CSS variables and work in light and dark.
- Every subagent runs on Sonnet.

## Review Focus

- A day with no rows inside the range counts as zero for averages up to today (not skipped): pinned in Task 4 `summarize`.
- Clock jumps or a suspended PC must not invent time: pinned by the 15 s cap in Task 2.
- A block-list stem inside a longer word (`reddit` in `Redditors`) must not match: whole-word rule pinned in Task 1.
- `GetUsage` with `from_day > to_day`, a malformed day string, or a range over 400 days: pinned in Task 3.
- Stats page with `usage_tracking: false`, helper down with no data, and a `GetUsage` failure each show their own state, never zeros: pinned in Task 6.

---

### Task 1: Website matcher (`sites.rs`)

**Files:**
- Create: `focus-helper/src/sites.rs`
- Modify: `focus-helper/src/lib.rs` (add `pub mod sites;`)
- Test: `focus-helper/tests/sites.rs`

**Interfaces:**
- Produces:
  - `pub fn is_browser(exe: &str) -> bool` (case-insensitive, exe base name such as `chrome.exe`).
  - `pub fn stems_from_domains(domains: &[String]) -> Vec<String>` (`reddit.com` gives `reddit`, `www.news.bbc.co.uk` gives `bbc`; lowercase, deduped).
  - `pub fn match_site(title: &str, extra_stems: &[String]) -> Option<String>` returns the site label, e.g. `"YouTube"`, or the stem for an own-list match.
  - `pub const SITE_MAP: &[(&str, &str)]` pairs of (label as it appears in titles, canonical name), about 100 popular sites (YouTube, Reddit, Twitter, X, Facebook, Instagram, TikTok, Netflix, Twitch, GitHub, Wikipedia, Amazon, Gmail, LinkedIn, Discord, WhatsApp, Spotify, ChatGPT and so on).

- [ ] **Step 1: Write the failing tests** in `focus-helper/tests/sites.rs`:
  - `browser_detection`: `is_browser("Chrome.EXE")`, `msedge.exe`, `firefox.exe`, `brave.exe`, `opera.exe`, `vivaldi.exe` true; `notepad.exe`, `chromedriver.exe`, `` false.
  - `known_titles`: `match_site("Funny cats - YouTube - Google Chrome", &[])` is `Some("YouTube")`; `"(3) Facebook"` gives `Facebook`; `"r/rust - Reddit"` gives `Reddit`.
  - `whole_word_only`: `match_site("Predicted outcomes", &["reddit".into()])` is `None`; `match_site("Redditors unite", &["reddit".into()])` is `None`; `match_site("Home / Reddit", &["reddit".into()])` is `Some("Reddit")` (the map wins over the stem).
  - `own_stems_match_when_not_in_map`: `match_site("Inbox | acmecorp", &["acmecorp".into()])` is `Some("acmecorp")`.
  - `first_match_wins`: a title naming two sites returns the one whose label appears first in the title.
  - `none_is_none`: `match_site("Untitled", &[])` is `None`.
  - `stems`: `stems_from_domains(&["reddit.com".into(),"www.news.bbc.co.uk".into(),"reddit.com".into()])` is `["reddit","bbc"]`.
  - `map_is_sane`: `SITE_MAP.len() >= 90`, no duplicate canonical-name/label pair, every label non-empty and ASCII.

- [ ] **Step 2: Run to verify failure:** `cd focus-helper && cargo test --test sites` (module missing).

- [ ] **Step 3: Implement** the functions in `sites.rs`. Whole word means the characters before and after the match are not alphanumeric. Title matching scans each candidate (map labels, then stems) and picks the earliest position in the title; ties go to the map.

- [ ] **Step 4: Run to verify pass:** `cargo test --test sites` passes; `cargo clippy --all-targets -- -D warnings` clean if clippy is in use.

- [ ] **Step 5: Commit:** `git add focus-helper && git commit -m "feat(helper): website matcher for browser window titles"`

---

### Task 2: Usage accounting and persistence (`usage.rs`)

**Files:**
- Create: `focus-helper/src/usage.rs`
- Modify: `focus-helper/src/lib.rs` (add `pub mod usage;`)
- Test: `focus-helper/tests/usage.rs`

**Interfaces:**
- Consumes: `sites::{is_browser, match_site}`.
- Produces:
  - `pub struct Sample { pub exe: String, pub title: Option<String>, pub idle_secs: u64, pub day: String }` (`exe` is the base name; `title` is set only for browsers by the platform; `day` is the local `YYYY-MM-DD`).
  - `pub const MAX_SAMPLE_SECS: u64 = 15; pub const IDLE_LIMIT_SECS: u64 = 300; pub const MAX_NAMES: usize = 200; pub const KEEP_DAYS: usize = 730;`
  - `#[derive(Serialize, Deserialize, Default, Clone, PartialEq, Debug)] pub struct DayUsage { pub day: String, pub total: u64, pub apps: BTreeMap<String,u64>, pub sites: BTreeMap<String,u64>, pub other_browsing: u64 }`
  - `pub struct UsageStore` with:
    - `pub fn new() -> UsageStore`
    - `pub fn record(&mut self, sample: Option<&Sample>, elapsed_secs: u64, stems: &[String])` (None, idle over the limit, or elapsed 0 adds nothing; adds `min(elapsed, 15)` to total, to `apps[exe.to_lowercase()]`, and for browsers to `sites[label]` or `other_browsing`; rolls into `"other"` past 200 names).
    - `pub fn range(&self, from_day: &str, to_day: &str) -> Result<Vec<DayUsage>, RangeError>` (`RangeError::{BadDay, Reversed, TooLong}`; days present only, ascending; at most 400 days inclusive).
    - `pub fn add_day(&mut self, d: DayUsage)` (test seeding; replaces the day).
    - `pub fn prune(&mut self)` (keeps newest `KEEP_DAYS`).
    - `pub fn dirty(&self) -> bool`, `pub fn mark_clean(&mut self)`.
  - `pub fn save(path: &Path, store: &UsageStore) -> io::Result<()>` (versioned JSON `{"version":1,"days":[...]}`, `.tmp` then rename, `.bak` copy of a parsing main file, same approach as `persist.rs`).
  - `pub enum UsageLoad { Fresh, Main, Backup, Corrupt(PathBuf) }`; `pub fn load(path: &Path, unix_ms: i64) -> (UsageStore, UsageLoad)` (a file that does not parse is renamed `<name>.corrupt-<unix_ms>` and the store starts empty).

- [ ] **Step 1: Write the failing tests** in `focus-helper/tests/usage.rs`:
  - `cap_is_15_seconds`: record a chrome sample with elapsed 60: total is 15.
  - `idle_not_counted`: `idle_secs = 301` adds 0; `idle_secs = 300` adds time.
  - `none_sample_adds_nothing`.
  - `program_name_lowercased`: exe `Code.EXE` stored as `code.exe`.
  - `browser_site_and_other`: chrome with title `x - YouTube` adds to `sites["YouTube"]`; title `Untitled` adds to `other_browsing`; notepad with title `YouTube` adds only to apps and never to sites.
  - `own_stem_used`: stems `["acmecorp"]` and title `Inbox | acmecorp` gives `sites["acmecorp"]`.
  - `titles_never_stored`: serialize the store to JSON after samples with title `SECRET-TITLE - YouTube`; the string `SECRET-TITLE` does not appear.
  - `day_rollover`: samples with `day` `2026-01-01` and `2026-01-02` produce two `DayUsage` rows.
  - `rollup_at_200`: 205 distinct exes on one day give 201 keys with `other` holding the extras' seconds; same for sites.
  - `range_bounds`: inclusive both ends; reversed gives `Reversed`; `2026-13-40` gives `BadDay`; a 401-day span gives `TooLong`; exactly 400 days is fine.
  - `prune_730`: 800 seeded days leave 730, the newest.
  - `persistence_round_trip`: save then load equals the original; a `.bak` appears after a second save.
  - `corrupt_file_recovery`: write garbage to the file; `load` returns an empty store with `UsageLoad::Corrupt(p)` where `p` exists and has the garbage; the main path no longer exists.
  - `dirty_flag`: false after `new`, true after a recorded sample, false after `mark_clean`.

- [ ] **Step 2: Run to verify failure:** `cargo test --test usage`.

- [ ] **Step 3: Implement** `usage.rs`. Keep days in a `BTreeMap<String, DayUsage>`; validate `YYYY-MM-DD` with a small calendar check (no new dependency); count days between two valid dates with a days-from-civil function.

- [ ] **Step 4: Run to verify pass:** `cargo test --test usage`.

- [ ] **Step 5: Commit:** `git add focus-helper && git commit -m "feat(helper): per-day usage accounting and persistence"`

---

### Task 3: Protocol, daemon integration, test-only AddUsage

> Note: `Platform::foreground`/`usage_tracking` and tick sampling below were replaced by the 4b design (see Rework (4b) under Task 4).

**Files:**
- Modify: `focus-helper/src/ipc.rs` (add `GetUsage`, `Usage`, `usage_tracking`), `focus-helper/src/daemon.rs` (own the `UsageStore`, sampling, flush), `focus-helper/src/main.rs` (usage path for stdio, `AddUsage` under `test-clock`), `focus-helper/src/win/pipe.rs` and `focus-helper/src/service_logic.rs` (usage file path, flush on stop), `focus-helper/src/win/paths.rs` (`usage_file()`)
- Test: `focus-helper/tests/usage_protocol.rs`, extend `focus-helper/tests/stdio.rs`

**Interfaces:**
- Consumes: `usage::{UsageStore, Sample, DayUsage, load, save, RangeError}`, `sites::stems_from_domains`.
- Produces:
  - `Request::GetUsage { from_day: String, to_day: String }`.
  - `Response::Usage { days: Vec<DayUsage> }`; error codes `bad-request` for any `RangeError`.
  - `Response::Status` gains `#[serde(default)] usage_tracking: bool`.
  - `Platform` gains `fn foreground(&mut self) -> Option<Sample> { None }` and `fn usage_tracking(&self) -> bool { false }` (default methods, so existing platforms compile unchanged).
  - `Daemon::load(state_path)` also loads usage from `<state dir>/usage.json` (sibling of the state file); `Daemon::load_with_usage(state_path, usage_path)` is the explicit form used by stdio tests.
  - `Daemon::tick` calls the sampler every 5 s of monotonic time: `elapsed` is the mono-ms difference since the previous sample in whole seconds, stems come from `stems_from_domains` of the sites of windows active now; the store is saved at most once per 60 s when dirty and by `Daemon::flush_usage()` (called by the Windows loop on stop).
  - `Daemon::add_usage(day: DayUsage)` (used only by the test-only request).
  - Test-only request `{"type":"AddUsage","day":{...DayUsage}}` handled in `main.rs` under `#[cfg(feature = "test-clock")]`, reply `{"type":"Ok"}`; it saves immediately.

- [ ] **Step 1: Write the failing tests:**
  - `usage_protocol.rs` using `Daemon` with a fake `Platform` returning scripted samples: `status_reports_usage_tracking` (true only when the platform says so); `sampling_every_five_seconds` (ticks at mono 0, 1 000, 5 000, 10 000 ms with a chrome sample at each produce 2 samples worth of seconds, never more than 15 per sample); `suspend_gap_capped` (mono jumps 10 minutes: adds 15); `block_list_stem_used` (a pushed window with site `acmecorp.com` active now; a chrome sample titled `Inbox | acmecorp` records `sites["acmecorp"]`); `get_usage_shape` (seed via `add_usage`; reply JSON has `type":"Usage"` and `days[0]` has keys `day,total,apps,sites,other_browsing`); `get_usage_rejects` (reversed, malformed, 401 days give `Error` with code `bad-request`).
  - `stdio.rs`: with the `test-clock` feature (`#[cfg(feature = "test-clock")]`) `AddUsage` then `GetUsage` over the real binary returns the seeded day; a restart with the same `--state` still returns it (persistence).
  - Existing status tests keep passing (`usage_tracking` defaults false in `NullPlatform`).

- [ ] **Step 2: Run to verify failure:** `cargo test --test usage_protocol` and `cargo test --features test-clock --test stdio`.

- [ ] **Step 3: Implement** as listed. `GetUsage` does not mutate the lock store, so do not persist the lock state for it (mirror how `GetStatus` is handled in `Daemon::handle_line`). The usage path for stdio is `<state path with file name usage.json>` in the same directory.

- [ ] **Step 4: Run to verify pass:** `cargo test` and `cargo test --features test-clock` in `focus-helper`; both fully green.

- [ ] **Step 5: Commit:** `git add focus-helper && git commit -m "feat(helper): GetUsage protocol, usage_tracking status and daemon sampling"`

---

### Task 4: Windows foreground sampler (`win/foreground.rs`)

> Note: `WindowsPlatform::foreground` was replaced by the 4b design: the sampler runs in a per-user process (see Rework (4b) below).

**Files:**
- Create: `focus-helper/src/win/foreground.rs`
- Modify: `focus-helper/src/win/mod.rs` (`pub mod foreground;`), `focus-helper/src/win/platform.rs` (`WindowsPlatform` implements `foreground` and `usage_tracking`), `focus-helper/Cargo.toml` (add `windows-sys` features `Win32_UI_WindowsAndMessaging`, `Win32_UI_Input_KeyboardAndMouse`, `Win32_System_RemoteDesktop` and others the code needs)
- Docs: `docs/superpowers/focus-room-windows-checklist.md` (new section for analytics before Cleanup)

**Interfaces:**
- Consumes: `usage::Sample`, `sites::is_browser`.
- Produces: `pub fn sample() -> Option<Sample>`: `GetForegroundWindow`, `GetWindowThreadProcessId`, `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`, `QueryFullProcessImageNameW` for the exe base name; `GetWindowTextW` only when `is_browser(exe)`; `GetLastInputInfo` with `GetTickCount` for `idle_secs`; local day from `GetLocalTime`; returns `None` when there is no foreground window, the process cannot be opened, or the workstation is locked (the foreground window belongs to `LockApp.exe` or the input desktop cannot be opened with `OpenInputDesktop`). `WindowsPlatform::usage_tracking()` returns true.
- Pure helper (portable, unit-tested): `pub fn base_name(path: &str) -> String` and `pub fn day_string(y: u16, m: u16, d: u16) -> String` placed in `service_logic.rs` or `usage.rs` so they run on Linux.

- [ ] **Step 1: Write the failing tests** for the pure helpers on Linux: `base_name(r"C:\Program Files\Google\Chrome\Application\chrome.exe")` is `chrome.exe`; a path with forward slashes and an empty string behave; `day_string(2026, 3, 7)` is `2026-03-07`.

- [ ] **Step 2: Run to verify failure:** `cargo test base_name`.

- [ ] **Step 3: Implement** the helpers and the Windows sampler. Titles are read into a local `String`, passed in the `Sample`, and never logged. Check the Windows target compiles: `cargo check --target x86_64-pc-windows-gnu -p focus-helper` if the target is installed; otherwise say so in the report.

- [ ] **Step 4: Run to verify pass:** Linux `cargo test` green; Windows check result reported. Add checklist items: foreground program counted, idle stops counting after 5 minutes, locking the PC stops counting, browser tab titles attribute to the right site, tracking survives reboot and app closed, a day boundary rolls over, and the usage file contains no window titles.

- [ ] **Step 5: Commit:** `git add focus-helper docs && git commit -m "feat(helper): Windows foreground sampler and checklist"`

**Rework (4b):** the helper service runs in Session 0 and cannot see a user's foreground window, idle time or lock state, so sampling from the service tick (Tasks 3 and 4 as written above) cannot work. It was reworked: a per-user `focus-helper sampler` process (started at sign-in from an HKLM Run entry written by install, removed by uninstall) calls `foreground::sample()` every 5 s and sends `ReportForeground { exe, title, idle_secs, day }` over the pipe; the service keeps all accounting (first report anchors, reports less than 4 s apart are ignored, at most 15 s per report, stems from active block windows) and `Status.usage_tracking` is true only while a report arrived in the last 15 s. `Platform::foreground`/`usage_tracking` no longer exist. Design and exact values: `.superpowers/sdd/2026-11-11-focus-analytics/task-4b-brief.md`.

---

### Task 5: Client method and pure stats (`stats.js`)

**Files:**
- Modify: `src/modules/focus/helper-client.js` (add `getUsage: (fromDay, toDay) => send({ type: 'GetUsage', from_day: fromDay, to_day: toDay })`)
- Create: `src/modules/focus/stats.js`
- Test: `tests/focus-stats.test.js`; extend `tests/focus-client.test.js`

**Interfaces:**
- Produces (all pure, no Date.now):
  - `dayKey(ms, tzOffsetAt) -> 'YYYY-MM-DD'` and `addDays(day, n) -> day`.
  - `rangeFor(period, today) -> { from, to, days }` where `period` is `'day'|'week'|'month'|'year'` and `today` is a day key; week starts Monday, month and year are calendar; `to` is the end of the period (may be after `today`).
  - `previousRange(period, range) -> range`.
  - `shiftRange(period, range, n) -> range` (for the arrows).
  - `summarize(days, range, today) -> { total, dailyAverage, activeDays, topApp, topSite, perDay: [{day,total,apps,sites}], perWeekday: number[7] (Mon..Sun average seconds), topApps: [{name,secs,share}], topSites: [{name,secs,share}], otherBrowsing }` where the average divides by the days in the range up to and including `today` (never future days), and days with no rows count as zero.
  - `deltaVs(previousTotal, currentTotal) -> { pct: number|null, direction: 'up'|'down'|'same'|'none' }` (`none` when previous is 0).
  - `formatDuration(secs) -> '3h 12m'` (`'0m'`, `'45s'` under a minute, `'12m'`).

- [ ] **Step 1: Write the failing tests** in `tests/focus-stats.test.js`: `rangeFor('week','2026-11-11')` is `2026-11-09`..`2026-11-15` (7 days); a Sunday `today` stays in the same week; `rangeFor('month','2024-02-10')` has 29 days; `rangeFor('year','2026-05-05')` has 365 days and a leap year 366; month/year boundaries (`2026-12-31`, `2027-01-01`); `previousRange('month', Jan)` is the previous December; `shiftRange` forward and back; `summarize` averages over elapsed days only (month with 10 of 30 days elapsed and 100 s total gives average 10 s... using exact numbers), empty input gives zeros and `topApp: null`, top lists sorted descending with shares summing to 1 (±1e-9), `perWeekday` ignores future days and averages by the number of that weekday in the elapsed span, `otherBrowsing` carried; `deltaVs` cases incl. previous 0; `formatDuration` cases `0`, `45`, `60`, `3600`, `11520` (`3h 12m`), `90061`.
  - Client test: `getUsage('2026-01-01','2026-01-31')` sends `{"type":"GetUsage","from_day":"2026-01-01","to_day":"2026-01-31"}`.

- [ ] **Step 2: Run to verify failure:** `node --test tests/focus-stats.test.js tests/focus-client.test.js`.

- [ ] **Step 3: Implement** `stats.js` with day arithmetic via `Date.UTC` on day keys (no time zone use inside), and the client method.

- [ ] **Step 4: Run to verify pass:** the two test files pass; `npm test` has no new failures.

- [ ] **Step 5: Commit:** `git add src tests && git commit -m "feat(focus): usage client method and pure stats logic"`

---

### Task 6: Charts (`ui/charts.js`) and styles

**Files:**
- Create: `src/modules/focus/ui/charts.js`
- Modify: `src/styles.css` (chart classes and CSS variables for light and dark)
- Test: `tests/focus-charts.test.js` (uses `tests/helpers/fake-dom.js`; extend the fake DOM with `createElementNS` if missing, minimal)

**Interfaces:**
- Consumes: `stats.js` shapes, `formatDuration`.
- Produces, each returning an SVG element (built with `createElementNS`, text set as text) carrying `role="img"` and an `aria-label` text summary:
  - `stackedDailyBars(perDay, { topN = 5 }) -> SVGElement` (one bar per day, top 5 apps plus `other`, a `<title>` per bar).
  - `rankedBars(items, { unit = 'time' }) -> HTMLElement` (horizontal bars with name, `formatDuration` and percent share).
  - `weekdayBars(perWeekday) -> SVGElement` (7 bars Mon..Sun).
  - `yearHeatmap(perDay, year) -> SVGElement` (53 columns by 7 rows, Monday first, intensity 0..4, `<title>` with date and time).
  - `dataTable(rows, columns) -> HTMLElement` (the table behind the toggle, plain `<table>`).
  - `chartColor(i) -> string` returning `var(--chart-<i>)` for 0..5.

- [ ] **Step 1: Write the failing tests:** element counts (`stackedDailyBars` with 7 days has 7 groups; `weekdayBars` 7 rects; `yearHeatmap` has 53*7 cells for a year with 371 grid cells minus out-of-year cells that are not drawn, test the drawn count equals the days in the year), empty data returns a valid element with zero bars and an `aria-label` that says there is no data, no attribute value anywhere contains `NaN` or `undefined` for zero, empty and single-day data, `rankedBars` percent text sums to about 100 and shows `3h 12m` for 11520 s, text with `<script>` in an app name is rendered as text (not an element).

- [ ] **Step 2: Run to verify failure:** `node --test tests/focus-charts.test.js`.

- [ ] **Step 3: Implement** the builders; keep layout math in small pure helpers (scale, bar geometry) so they can be tested without a DOM. Define `--chart-0..--chart-5` and `--chart-empty` under `:root` and the dark theme rules in `styles.css` with the same selectors the file already uses.

- [ ] **Step 4: Run to verify pass:** `node --test tests/focus-charts.test.js`; `npm test` no new failures.

- [ ] **Step 5: Commit:** `git add src tests && git commit -m "feat(focus): SVG chart builders for stats"`

---

### Task 7: Stats page, navigation and states

**Files:**
- Create: `src/modules/focus/ui/stats-page.js`
- Modify: `src/modules/focus/ui/home.js` (a Stats button in the header next to Helper details that calls `deps.openStats?.()`), `src/modules/focus/index.js` (render switches between home and stats), `src/styles.css`
- Test: `tests/focus-stats-page.test.js`, extend `tests/focus-ui-dom.test.js` for the header button

**Interfaces:**
- Consumes: `controller.state.helper` (kind and status incl. `usage_tracking`), a client `getUsage` via `controller.getUsage(fromDay, toDay)` (new thin controller method returning `{ ok, days }` or `{ ok:false, message }` and never throwing, outside the write queue), `stats.js`, `charts.js`, `makeTzOffsetAt`.
- Produces: `mountStatsPage(root, controller, deps) -> cleanup` where `deps = { onBack, now?, tzOffsetAt? }`. Layout: back button, title `Stats`, period switch (Day, Week, Month, Year) with previous/next arrows and the range label, summary cards (Total, Daily average, Most-used app, vs previous), charts (stacked daily bars, top apps, top sites labelled `Estimated from browser tab titles`, weekday averages, year heatmap in Year), a toggle `Show as table`.
  - States, each with its own text and no zeros: loading; empty (`No usage recorded yet for this period`); helper down with data last loaded (`Showing the last data from <time>. The helper isn't running.`); helper down with none (explains how to start the helper); `usage_tracking` false (`Usage tracking is off` with the reason that it runs only with the Windows helper); `GetUsage` failure with a Retry button.
  - Controller: `getUsage` added to `controller.js` return object.

- [ ] **Step 1: Write the failing tests** with a fake controller: each state above renders its text; switching period requests the right `from_day`/`to_day` (e.g. Week on `2026-11-11` requests `2026-11-09`..`2026-11-15` and also the previous week for the delta); the cards show `Total` formatted by `formatDuration`; the arrows move the range; Retry calls again; cleanup removes timers; the home header Stats button calls `deps.openStats` and is absent when it is not provided.

- [ ] **Step 2: Run to verify failure:** `node --test tests/focus-stats-page.test.js`.

- [ ] **Step 3: Implement** the page and wiring. `index.js` keeps a `view` variable (`'home'|'stats'`) and re-renders into the same root; unmount the previous view's cleanup first. The last successful result is kept per period key so helper-down shows it.

- [ ] **Step 4: Run to verify pass:** the new and existing UI tests pass; `npm test` green.

- [ ] **Step 5: Commit:** `git add src tests && git commit -m "feat(focus): Stats page with period switch, cards and charts"`

---

### Task 8: End to end, screenshots and docs

**Files:**
- Create: `tests/focus-analytics-e2e.test.js`
- Modify: `scripts/focus-steps.mjs` (stats steps for screenshots), `docs/superpowers/focus-room-windows-checklist.md` (check Task 4's section is complete)

**Interfaces:**
- Consumes: the real helper built with `--features test-clock` (skip otherwise, like `tests/focus-schedules-e2e.test.js`), `createStdioCall`, `createHelperClient`, `stats.js`.

- [ ] **Step 1: Write the end-to-end test:** seed three days with `AddUsage` through the bridge; `client.getUsage` over the range returns exactly those days with the same app/site numbers; `summarize` of the result gives the expected total and top app; a range with no seeded days returns `days: []` and `summarize` gives zeros; a reversed range rejects with code `bad-request`; restart the bridge on the same state and the seeded days are still returned. Skips with a clear message when the binary lacks `test-clock`.

- [ ] **Step 2: Run:** `cargo build --features test-clock` then `node --test tests/focus-analytics-e2e.test.js` passes (not skipped).

- [ ] **Step 3: Screenshots:** extend `scripts/focus-steps.mjs` with Stats in Day, Week, Month, Year, empty and helper-down, light and dark, using a fake client; run only the new steps (the full run is known to be flaky) and look at the images to confirm they render; report any that fail to render.

- [ ] **Step 4: Verify everything:** `npm test` (0 fail), `cargo test` and `cargo test --features test-clock` in `focus-helper` pass.

- [ ] **Step 5: Commit:** `git add tests scripts docs && git commit -m "test(focus): analytics end to end, screenshot steps and checklist"`
