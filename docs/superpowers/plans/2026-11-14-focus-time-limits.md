# Focus Room time limits (6b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daily and weekly time limits on apps and sites, counted by the helper from recorded usage, enforced by blocking until the period ends, with optional locks that need the partner's code or a waiting period to weaken.

**Architecture:** A portable `limits.rs` (model, validation, used-time, period math) feeds a new `limits` field in the helper's `LockStore` (push rules, tombstones, unlock by id). `Daemon::apply` merges exceeded limits into the decision it already enforces. The app stores limits in SQLite, pushes them with `PushLimits`, and shows a Time limits section with an editor and the existing unlock dialog.

**Tech Stack:** Rust (existing crate, serde), vanilla JS ES modules, SQLite via the existing db layer, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-14-focus-time-limits-design.md`

## Global Constraints

- Limit: `{ id, name, apps[], sites[], period: "daily"|"weekly", cap_secs, lock: "none"|"locked", unlock_delay_ms? }`. Up to 64 limits; 1 to 100 items each (items validated like window items with `good_item`); cap 60 s to 24 h (daily) or 168 h (weekly); locked needs `unlock_delay_ms` from 3,600,000 to 604,800,000 (default 24 h in the UI), unlocked must not carry one.
- All items of one limit share one pool. Apps match by lowercase exe name; sites match like the usage site labels do (same matching as `match_site` with the limit's domains as extra stems), so numbers equal Stats.
- Daily period ends at local midnight; weekly at the start of Monday (local). `current_day` is the day string of the latest accepted report; a day that goes backwards never lowers used time; silence never unblocks.
- Enforcement = the existing block enforcement (processes ended, sites in the hosts file). A limit blocks only when `used >= cap`; limit blocks never relax allow-list windows. Decision gains `limit_blocks: [{id, until_day}]`, omitted when empty so existing shared decide vectors stay byte-identical.
- Protocol: `PushLimits { limits }`, `GetLimits` -> `Limits { limits, status: [{id, used_secs, cap_secs, blocked, period_ends_day}], pending_unlocks }`; push reply lists `kept_locked: [ids]`. Both daemon-only for status numbers; shapes additive; old state files load with no limits.
- Locked limits: weakening (delete, raise cap, remove items, change period, drop the lock) is ignored by the helper and reported in `kept_locked`; tightening applies; a new locked limit may be pushed. Unlocking reuses `RequestChallenge`/`SubmitToken` and `RequestDelayedUnlock`/`CancelDelayedUnlock` with a limit id; a tombstone stops an older locked copy from returning.
- The app never claims a limit is locked or removed unless the helper confirmed it; helper rejects (`bad-limit`) are shown beside the editor.
- Vanilla JS ES modules, light and dark via existing CSS variables, phone-friendly layout; titles never stored; every subagent runs on Sonnet.

## Review Focus

- A limit must not block before its pool is used up; exactly `used == cap` blocks: pinned in Task 1 and 3.
- Clock moved back or a day string going backwards never lowers used time; the weekly Monday boundary across month and year ends: pinned in Task 1 and 3.
- A stale app copy cannot weaken, delete or re-add a locked limit (including after an unlock, via tombstone): pinned in Task 2.
- Helper down: limits list shows saved limits with "Enforcement is not running", never zeros or "0m left" as fact: pinned in Task 6.
- Old state files and shared decide vectors unchanged: pinned in Task 2 and 3.

---

### Task 1: Limit model, validation, used time (`limits.rs`)

**Files:**
- Create: `focus-helper/src/limits.rs`; Modify: `focus-helper/src/lib.rs` (`pub mod limits;`)
- Test: `focus-helper/tests/limits.rs`

**Interfaces:**
- Produces: `pub enum Period { Daily, Weekly }` (serde lowercase); `pub struct Limit { id: String, name: String, apps: Vec<String>, sites: Vec<String>, period: Period, cap_secs: u64, lock: Lock, unlock_delay_ms: Option<i64> }` (serde, Clone, PartialEq, Eq, Debug; `lock` reuses `model::Lock` restricted to None/Locked); `pub fn validate_limit(l: &Limit) -> Result<(), String>` (reason codes `bad-id`, `bad-name`, `no-items`, `too-many-items`, `bad-item`, `bad-cap`, `bad-delay`, `bad-lock`); `pub const MAX_LIMITS: usize = 64;` `pub fn weekday_monday_based(day: &str) -> Option<u8>` (0 = Monday); `pub fn period_days(period: Period, current_day: &str) -> Option<(String, String)>` inclusive `(from_day, to_day)`; `pub fn period_ends_day(period: Period, current_day: &str) -> Option<String>` (the first day on which the limit lifts); `pub fn used_secs(l: &Limit, days: &[DayUsage]) -> u64`; `pub fn is_weaker(old: &Limit, new: &Limit) -> bool` (true if the change deletes nothing but raises cap, removes any item, changes period, or drops the lock); `pub fn is_exceeded(l: &Limit, days: &[DayUsage]) -> bool` (`used_secs >= cap_secs`).

- [ ] **Step 1: Write failing tests** in `tests/limits.rs`: validation table (each reason code once, boundaries 59/60 s, 24 h and 24 h + 1 s daily, 168 h weekly, delay 3,599,999 and 3,600,000 and 604,800,001, unlocked with a delay is `bad-delay`, 0 items and 101 items); `period_days(Weekly, "2026-11-14")` is `("2026-11-09","2026-11-14")` (Saturday), `period_days(Weekly, "2026-11-09")` is a single day, month boundary `period_days(Weekly,"2026-12-02")` -> `("2026-11-30","2026-12-02")`, year boundary `period_days(Weekly,"2027-01-01")` -> `("2026-12-28","2027-01-01")`, a leap day `("2024-02-26" for 2024-02-29)`; `period_ends_day(Daily,"2026-11-14")` is `"2026-11-15"`, `(Weekly,"2026-11-14")` is `"2026-11-16"`, end-of-year rolls to `2027-01-01`; `used_secs` sums apps (lowercase match; `Chrome.EXE` in limit matches `chrome.exe` row) and sites (label `YouTube` matches domain `youtube.com`; label `youtube` too; `Other browsing` never matches; a site whose label merely contains the stem does not match), only days inside the period, missing days count zero, an item listed both as app and site counts each once; `is_weaker`: raise cap true, lower cap false, remove an item true, add an item false, change period true, `lock Locked -> None` true, rename only false, identical false; `is_exceeded` at cap-1, cap, cap+1.
- [ ] **Step 2: Run** `cd focus-helper && cargo test --test limits`; expect FAIL.
- [ ] **Step 3: Implement** the signatures. Reuse `usage::day_number`/`parse_day`/`days_from_civil` helpers (make `pub(crate)` as needed), `lockstore::good_item`, and `sites::stems_from_domains` for site matching.
- [ ] **Step 4: Run** `cargo test --test limits` then `cargo test`; expect PASS.
- [ ] **Step 5: Commit** `feat(helper): time limit model, validation and used time`.

### Task 2: Limits in the lock store (push rules, unlock by id, persistence)

**Files:**
- Modify: `focus-helper/src/lockstore.rs`, `focus-helper/src/persist.rs`, `focus-helper/src/ipc.rs` (types only here), `focus-helper/src/model.rs` (only if needed)
- Test: `focus-helper/tests/lockstore.rs`, `focus-helper/tests/persist.rs`, `focus-helper/tests/unlock_vectors.rs` (extend only if its vectors cover token binding)

**Interfaces:**
- Consumes: Task 1 `Limit`, `validate_limit`, `is_weaker`, `MAX_LIMITS`.
- Produces: `LockStore.limits: Vec<Limit>` (`#[serde(default)]`), `LockStore.limit_tombstones` (same shape and retention as window tombstones, default empty); `pub struct LimitPushReport { pub kept_locked: Vec<String>, pub applied: usize }`; `pub fn push_limits(&mut self, incoming: Vec<Limit>, now_ms: i64) -> Result<LimitPushReport, PushError>` (whole-push validation errors reuse `PushError`/`Invalid`-style reasons prefixed `bad-limit`; duplicate ids rejected; rules: unlocked limits replaced freely; for a locked stored limit a missing/weaker incoming copy is ignored and its id listed in `kept_locked`; tightening applies; a tombstoned locked id arriving locked is skipped; a new locked limit stored as is); unlock paths: `request_challenge`, `submit_token`, `request_delayed_unlock`, `cancel_delayed_unlock`, `expire_pending` accept a limit id wherever they accept a window id (a limit unlock makes the stored limit `lock: None`, clears `unlock_delay_ms`, adds a tombstone, clears pending); partner key cannot change while a locked limit exists (existing rule extended); `uninstall_decision`/`stop_allowed`/`lock_pending` also count locked limits as pending locks.

- [ ] **Step 1: Write failing tests:** push validation (64/65 limits, duplicate ids, bad cap) leaves the store unchanged; unlocked replace/delete freely; locked: a push omitting it, raising cap, removing an item, changing period, dropping the lock all keep the stored copy and list `kept_locked`; lowering cap and adding an item apply; a new locked limit is stored; token unlock (existing test vector style: challenge for the limit id, valid signature) unlocks it; delayed unlock completes at `unlock_at` on the effective clock and cannot be shortened or cancelled into a no-op; after unlock a stale locked copy pushed back is skipped (tombstone), an unlocked edit is accepted; store with no `limits` key in JSON loads empty (old state); round trip persists limits, tombstones, pending unlocks; locked limit makes `stop_allowed` false and `uninstall_decision` Err, an unlocked limit does not; partner change refused with a locked limit present.
- [ ] **Step 2: Run** `cargo test`; expect FAIL.
- [ ] **Step 3: Implement.** Keep window behavior and shared vectors untouched; share the unlock code by factoring on an "id kind" lookup rather than duplicating it.
- [ ] **Step 4: Run** `cargo test` and `cargo test --features test-clock`; PASS.
- [ ] **Step 5: Commit** `feat(helper): limits in the lock store with locked-limit rules`.

### Task 3: Daemon enforcement and protocol

**Files:**
- Modify: `focus-helper/src/daemon.rs`, `focus-helper/src/ipc.rs`, `focus-helper/src/decide.rs`, `focus-helper/src/model.rs` (Decision `limit_blocks`), `focus-helper/src/main.rs` (stdio mode `PushLimits`/`GetLimits` pass-through if requests are routed there; test-only helpers behind `test-clock` already exist)
- Test: `focus-helper/tests/daemon.rs`, `focus-helper/tests/ipc.rs`, `focus-helper/tests/usage_protocol.rs`, `focus-helper/tests/vectors.rs` (assert existing decide vectors unchanged)

**Interfaces:**
- Consumes: Tasks 1 and 2; `UsageStore::range(from, to)`.
- Produces: `Request::PushLimits { limits: Vec<Limit> }` answered by `Response::LimitsPushed { applied: usize, kept_locked: Vec<String> }`; `Request::GetLimits` answered by `Response::Limits { limits: Vec<Limit>, status: Vec<LimitStatus>, pending_unlocks: Vec<PendingUnlock> }` with `LimitStatus { id, used_secs, cap_secs, blocked, period_ends_day }`; `Decision.limit_blocks: Vec<LimitBlock { id, until_day }>` (`skip_serializing_if` empty); `Daemon` keeps `current_day: Option<String>` from accepted reports (never moves back by more than the existing skew rule, ignoring earlier days for period selection); in `apply`, exceeded limits (used from the usage store for `period_days`) add their apps and sites to the block lists of the decision after `decide`; `block_folders` untouched.

- [ ] **Step 1: Write failing tests:** pushing an unlocked daily limit (cap 3,600 s on `game.exe`) then reports totalling 3,599 s: decision has no block; 3,600 s: `game.exe` in `block_apps`, `limit_blocks` lists the id with `until_day` the next day; a new day report (`current_day` +1) lifts it; weekly across a Monday boundary lifts on Monday; sites: label `YouTube` seconds against limit domain `youtube.com` block `youtube.com` in `block_sites`; a limit never removes an allow-list window's allow; clock-back: a later report with an earlier day does not lower used time or lift a block; no reports yet -> no block; `GetLimits` status numbers and `blocked` flag; push shape/`kept_locked`; limits survive restart; a Status call is unchanged; existing decide vectors byte-identical (vectors test passes unchanged); a locked limit blocks `stop_allowed`.
- [ ] **Step 2: Run** `cargo test`; FAIL.
- [ ] **Step 3: Implement** as described; evaluate limits from in-memory usage each tick with no extra disk work (cache `used_secs` per limit and recompute when usage or `current_day` changed).
- [ ] **Step 4: Run** `cargo test`, `cargo test --features test-clock`, `cargo build --features test-clock`; PASS.
- [ ] **Step 5: Commit** `feat(helper): enforce time limits and PushLimits/GetLimits`.

### Task 4: App data layer and pure logic

**Files:**
- Modify: `src/modules/focus/schema.js` (v5 migration), `src/modules/focus/store.js`, `src/modules/focus/helper-client.js`
- Create: `src/modules/focus/limit-logic.js`
- Test: `tests/focus-schema.test.js`, `tests/focus-store.test.js`, `tests/focus-client.test.js`, `tests/focus-limit-logic.test.js`

**Interfaces:**
- Produces: tables `focus_limits(id INTEGER PRIMARY KEY, name TEXT NOT NULL, period TEXT NOT NULL, cap_secs INTEGER NOT NULL, lock TEXT NOT NULL DEFAULT 'none', unlock_delay_ms INTEGER, enabled INTEGER NOT NULL DEFAULT 1)` and `focus_limit_items(limit_id INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL)` (kind `app`|`site`); store: `listLimits(db) -> [{id,name,period,capSecs,lock,unlockDelayMs,enabled,apps[],sites[]}]`, `saveLimit(db, limit) -> id`, `deleteLimit(db, id)`, `setLimitEnabled(db, id, enabled)`; client: `pushLimits(limits)`, `getLimits()`; `limit-logic.js` exports: `validateLimit(l) -> {ok,errors:{name?,items?,cap?,delay?}}` mirroring helper bounds, `toWire(l) -> helper Limit` (id as `limit-<id>`), `isWeakening(oldL, newL)` mirroring `is_weaker`, `formatLeft(usedSecs, capSecs) -> '1h 20m left' | 'Used up'`, `statusText(limit, status, helperKind) -> { text, tone }` (`'Enforcement is not running'` when the helper is down), `capParts(secs) -> {hours, minutes}` and `partsToCap({hours,minutes})`.

- [ ] **Step 1: Write failing tests:** migration from v4 creates both tables and leaves schedule data; CRUD round trip incl. items; delete removes items; `validateLimit` bounds like the helper (59 s, 60 s, 24 h/168 h, delay bounds, 0 items, 101 items, name empty); `toWire` shape; `isWeakening` table equal to the Rust cases; `formatLeft(0,3600)` `'1h 0m left'`... (use the same compact style as `formatDuration`: `'1h 0m left'`, `'59m left'`, `'Used up'` at used>=cap); `statusText` with helper down never claims numbers; client message shapes.
- [ ] **Step 2: Run** `node --test tests/focus-limit-logic.test.js tests/focus-schema.test.js tests/focus-store.test.js tests/focus-client.test.js`; FAIL.
- [ ] **Step 3: Implement.** Follow the schedule tables' migration and CRUD pattern in `schema.js`/`store.js`.
- [ ] **Step 4: Run** the same command and `npm test`; PASS.
- [ ] **Step 5: Commit** `feat(focus): time limit storage and pure logic`.

### Task 5: Controller, sync and unlock for limits

**Files:**
- Modify: `src/modules/focus/controller.js`, `src/modules/focus/sync.js` (or a new `limit-sync.js` if cleaner), `src/modules/focus/unlock.js` and `ui/unlock-dialog.js` only where the unlock target type is assumed to be a window
- Test: `tests/focus-controller.test.js`, `tests/focus-sync.test.js`, `tests/focus-unlock.test.js`

**Interfaces:**
- Consumes: Task 4 store, logic and client.
- Produces: controller methods `saveLimit(limit)`, `deleteLimit(id)`, `setLimitEnabled(id, enabled)`, `refreshLimits()`, `limitsState` in `controller.state` (`{ limits, status, pendingUnlocks, loaded }`); a locked or weakening change: saves nothing to the DB unless the helper accepted it (new locked limit: ask the helper first and persist only on accept; weakening a locked limit returns `{ ok:false, needsUnlock: true, limitId }` so the UI opens the unlock dialog); unlock completion (token or delay done) removes the lock locally; sync: after any change and at start `PushLimits` of all enabled limits, on `kept_locked` reload from `GetLimits`, set a notice "<name> is locked and was kept", and resync never deletes a locked limit locally unless the helper confirms it is gone; helper down: state keeps saved limits, `enforcement: false`.

- [ ] **Step 1: Write failing tests** with a fake client: new unlocked limit saved and pushed; new locked limit pushed first and persisted only after acceptance (rejection `bad-limit` returns `errors`); weakening a locked limit returns `needsUnlock` and writes nothing; tightening applies; `kept_locked` reply reloads and sets the notice; delete of an unlocked limit works; delete of a locked one needs unlock; partner token and delayed unlock both complete for a limit id and then deletion succeeds; helper-down keeps limits and shows no numbers; push failure sets `syncPending` like windows.
- [ ] **Step 2: Run** `node --test tests/focus-controller.test.js tests/focus-sync.test.js tests/focus-unlock.test.js`; FAIL.
- [ ] **Step 3: Implement,** reusing the schedule write path (`scheduleWrite`) pattern.
- [ ] **Step 4: Run** the same command and `npm test`; PASS.
- [ ] **Step 5: Commit** `feat(focus): controller and sync for time limits`.

### Task 6: Time limits UI

**Files:**
- Create: `src/modules/focus/ui/limit-list.js`, `src/modules/focus/ui/limit-editor.js`
- Modify: `src/modules/focus/ui/home.js` (new "Time limits" section under Schedules), `src/modules/focus/index.js` only if routing needs it, `src/styles.css`
- Test: `tests/focus-limit-ui.test.js`, `tests/focus-ui-e2e.test.js` (extend)

**Interfaces:**
- Consumes: Task 5 controller state/methods, Task 4 logic, the existing list picker/dialog helpers used by `schedule-editor.js`.
- Produces: `mountLimitList(root, controller, deps)` (rows: name, items summary, period, cap, used/left bar `role="progressbar"` with text, blocked badge with end time, lock badge, enable switch, edit button) and `openLimitEditor(controller, limit|null, deps)` (name, period radio, cap hours+minutes, apps/sites via the existing item picker, lock choice with waiting period default 24 h, Save/Delete; weakening a locked limit opens the existing unlock dialog for the limit id).

- [ ] **Step 1: Write failing tests** (fake DOM): empty state text; rows render exact "1h 20m left", "Used up · blocked until <time>", lock badge; helper down shows "Enforcement is not running" and no numbers; editor validation messages (no items, cap 0, cap over 24 h daily); saving calls `controller.saveLimit` with the expected object; helper `bad-limit` error shown beside the field; weakening a locked limit opens the unlock dialog and does not save; delete asks for confirmation; no NaN or `undefined` text; focus restore on re-render.
- [ ] **Step 2: Run** `node --test tests/focus-limit-ui.test.js`; FAIL.
- [ ] **Step 3: Implement** following `schedule-list.js` and `schedule-editor.js` structure; CSS with existing variables, phone width friendly.
- [ ] **Step 4: Run** the test and `npm test`; PASS.
- [ ] **Step 5: Commit** `feat(focus): Time limits section and editor`.

### Task 7: End to end, screenshots, docs, checklist

**Files:**
- Create: `tests/focus-limits-e2e.test.js`; Modify: `scripts/focus-steps.mjs`, `docs/superpowers/focus-room-windows-checklist.md` (append a section), the 6b spec Status line

**Interfaces:**
- Consumes: everything above; the helper built with `--features test-clock` (`AddUsage`, `AdvanceClock`).

- [ ] **Step 1: Write the e2e test** (same harness as `tests/focus-detail-e2e.test.js`): push a daily limit over stdio, `AddUsage` below then at the cap, `GetLimits` reports `blocked` false then true and `GetStatus` decision lists the items; weekly rollover; a locked limit survives a weakening push (`kept_locked`), unlocks with the delayed-unlock path via `AdvanceClock`; restart keeps limits.
- [ ] **Step 2: Run** with the helper built; implement any gap; PASS.
- [ ] **Step 3: Extend** `scripts/focus-steps.mjs` with limits screenshots (list with several states, editor, blocked, locked, helper down; light, dark, phone) into the scratchpad `shots` folder (not committed); look at them and report layout problems; fix only tiny obvious ones.
- [ ] **Step 4: Docs:** Windows checklist section (real app ended at cap, site blocked, lifts at local midnight and Monday, locked limit cannot be deleted or weakened from the app, partner code and waiting-period unlock, limits survive reboot and app closed), accepted limits (site limits approximate; silence never unblocks until the first report of the new day; no notifications; clock forward can lift a day early like locks), spec Status set to built.
- [ ] **Step 5: Run** `npm test`, `cd focus-helper && cargo test && cargo test --features test-clock && cargo build --features test-clock`; PASS; commit `test/docs: time limits end to end, checklist`.
