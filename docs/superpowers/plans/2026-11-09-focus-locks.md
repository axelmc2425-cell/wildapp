# Focus locks (4a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Locked blocks (up to 7 days) that cannot be cancelled alone, partner key setup, and early unlock by a partner token or a waiting period fixed at lock time.

**Architecture:** The Rust helper gains a per-window `unlock_delay_ms`, persisted pending-unlock requests and two new requests; the JS app gains schema v2, a locked-block-to-one-window merge in sync, controller actions, and dialogs. The helper's copy of a lock always wins; the app database never weakens it.

**Tech Stack:** Rust (focus-helper, serde, p256), vanilla JS ES modules, `node --test` (Node 22), `node:sqlite`, Playwright harness (`scripts/shot.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-09-focus-locks-design.md` (read it first; it also builds on `2026-11-08-focus-room-design.md` and `2026-11-09-focus-room-ui-design.md`).

## Global Constraints

- Locked max duration 7 days (`MAX_LOCKED_MS` = 604800000); Frozen stays rejected by the helper (`frozen-unavailable`) in this plan.
- `unlock_delay_ms`: required for `locked`, minimum 3600000 (1 hour), maximum 604800000 (7 days), must be absent for other locks; enforced by the helper (the app is not trusted). Default offered in the UI: 24 hours; presets 1 h, 6 h, 24 h; custom hours up to 168.
- No new JS dependencies; no build step; no inline colors (`.fr-*` classes with app CSS variables, light and dark); user text only via `h()`, never `innerHTML`.
- Existing rules stay: helper wins over the database; pushes are rejected whole if any window is invalid; the controller serializes every write and push through one queue; actions never throw.
- Test-only clock request `AdvanceClock` exists only with cargo feature `test-clock`; it must never be compiled into the release binary or installer build.
- Commit messages end with the two attribution lines from the session's reminder.

## Review Focus

- A locked start while the helper is down or rejecting must leave NOTHING locked and no rows behind (Task 8 test).
- Two blocks with the same lists and same start/end but different lock level must not merge into one window (Task 6 test).
- A `none` push or an items-changing push for an existing locked id must not alter the helper's stored lock (Task 2 test).
- A pending wait must survive a helper restart and must not be shortened by moving the wall clock back (Task 2 test).
- A partner token submitted during a wait must end the lock and clear the wait (Task 2 test).
- A list inside a running locked block must not be editable or deletable (Task 5 test).
- Hostile or garbage partner key / token text must produce a message and never throw (Task 8 test).

---

## File structure

- Rust: `focus-helper/src/model.rs` (Window field), `lockstore.rs` (validation, pending unlocks, `end_early`), `ipc.rs` (requests, responses, status field), `daemon.rs` (tick expiry), `main.rs` (test-clock), `Cargo.toml` (feature); tests in `focus-helper/tests/`.
- JS: `schema.js`, `limits.js`, `store.js`, `expand.js`, `sync.js`, `helper-client.js`, `model.js`, `controller.js`, new `lock-logic.js` (pure text and validation for the lock dialogs), UI in `ui/start-dialog.js`, new `ui/partner-setup.js`, new `ui/unlock-dialog.js`, `ui/home.js`, `ui/helper-details.js`; tests in `tests/`.

---

### Task 1: Helper window field and validation

**Files:** Modify `focus-helper/src/model.rs`, `focus-helper/src/lockstore.rs`; Test `focus-helper/tests/lockstore.rs`.

**Interfaces:**
- Produces: `Window.unlock_delay_ms: Option<i64>` (`#[serde(default, skip_serializing_if = "Option::is_none")]`); `pub const MIN_UNLOCK_DELAY_MS: i64 = 3_600_000; pub const MAX_UNLOCK_DELAY_MS: i64 = 604_800_000;` in `lockstore.rs`; `Invalid::BadDelay` with reason `"bad-delay"`.

- [ ] **Step 1: Write failing tests** in `tests/lockstore.rs`: `locked_window_requires_delay` (push locked with `None` → `Err(PushError::Invalid(Invalid::BadDelay))`), `delay_below_one_hour_rejected`, `delay_above_seven_days_rejected`, `delay_on_none_window_rejected`, `valid_delay_accepted_and_stored` (stored window keeps `Some(86_400_000)`), `existing_locked_window_ignores_pushed_item_and_delay_changes` (push locked, push same id with different sites/apps/delay → stored copy unchanged).
- [ ] **Step 2:** Run `cargo test --manifest-path focus-helper/Cargo.toml lockstore` → compile errors / FAIL.
- [ ] **Step 3:** Add the field and constants; extend `validate_window` to check the delay rule (`Locked` requires `Some` within bounds; others require `None`). Add `unlock_delay_ms: None` to every existing `Window { .. }` literal in src and tests (the compiler lists them). Map `BadDelay` in `ipc.rs` as `bad-window` with message `bad-delay`.
- [ ] **Step 4:** `cargo test --manifest-path focus-helper/Cargo.toml` → all pass (decide vectors unchanged because the field is skipped when `None`).
- [ ] **Step 5:** Commit `feat(helper): per-window unlock delay`.

### Task 2: Pending unlocks in the lock store, protocol and daemon

**Files:** Modify `focus-helper/src/lockstore.rs`, `ipc.rs`, `daemon.rs`; Test `focus-helper/tests/lockstore.rs`, `tests/ipc.rs`, `tests/persist.rs`, `tests/daemon.rs`.

**Interfaces:**
- Produces in `lockstore.rs`: `pub struct PendingUnlock { pub window_id: String, pub unlock_at: i64 }` (Serialize, Deserialize, Clone, PartialEq, Eq); `LockStore.pending_unlocks: Vec<PendingUnlock>` (serde default); `STORE_VERSION = 2`; `pub enum DelayError { NoSuchLock, NotDelayable }`; `pub fn request_delayed_unlock(&mut self, window_id: &str, now_ms: i64) -> Result<i64, DelayError>` (returns `unlock_at`; repeat call returns the existing one); `pub fn cancel_delayed_unlock(&mut self, window_id: &str) -> bool`; `pub fn expire_pending(&mut self, now_ms: i64) -> bool` (true if anything changed); private `end_early(&mut self, window_id, now_ms)` shared with `submit_token` (sets `ends = min(ends, now)`, writes the tombstone, removes pending for that window).
- Produces in `ipc.rs`: `Request::RequestDelayedUnlock { window_id }`, `Request::CancelDelayedUnlock { window_id }`; `Response::UnlockPending { unlock_at: i64 }`; `Response::Status` gains `#[serde(default)] pending_unlocks: Vec<PendingUnlock>`; error codes `no-such-lock`, `not-delayable`, `no-pending-unlock`.

- [ ] **Step 1: Write failing tests** (lockstore): `request_sets_unlock_at_now_plus_delay`, `second_request_returns_same_time`, `request_on_unknown_or_none_window_errors` (`NoSuchLock` / `NotDelayable`), `expiry_ends_window_and_writes_tombstone` (after `expire_pending(unlock_at)` the window's `ends <= now`, a re-push of the same id with the same end is tombstoned), `cancel_removes_pending_and_second_cancel_returns_false`, `partner_token_clears_pending`, `pending_survives_save_and_load` (persist.rs), `wall_clock_moved_back_does_not_shorten_wait` (clock test through `ipc::handle` with an `EffectiveClock`), `expiry_when_window_ends_first_just_ends_normally`. ipc tests: JSON round trip of the two requests and `UnlockPending`, `Status` carries `pending_unlocks`. daemon test: `tick_expires_pending_and_saves`.
- [ ] **Step 2:** Run `cargo test --manifest-path focus-helper/Cargo.toml` → FAIL.
- [ ] **Step 3:** Implement. Call `store.expire_pending(now)` at the top of `ipc::handle` (after `now` is computed) and in `Daemon::tick` (save when it returns true). `ResetClock` clears `pending_unlocks` when it succeeds. Old state files load with an empty list.
- [ ] **Step 4:** `cargo test --manifest-path focus-helper/Cargo.toml` and `cargo check --manifest-path focus-helper/Cargo.toml --target x86_64-pc-windows-gnu --all-targets` (if the target is installed; otherwise rely on CI) → pass.
- [ ] **Step 5:** Commit `feat(helper): delayed unlock requests`.

### Task 3: Test-only clock, CI and guard

**Files:** Modify `focus-helper/Cargo.toml`, `focus-helper/src/main.rs`, `.github/workflows/ci.yml`; Test `focus-helper/tests/stdio.rs`, `tests/stage-helper.test.js`.

**Interfaces:**
- Produces: cargo feature `test-clock = []`; with it, the `stdio` mode answers `{"type":"AdvanceClock","ms":N}` with `{"type":"Ok"}` and adds `N` to the wall time it passes to the daemon from then on (cumulative). Without the feature the same line is `bad-request` (existing behaviour).

- [ ] **Step 1: Write failing tests:** in `stdio.rs` (`#[cfg(feature = "test-clock")]`): `advance_clock_moves_effective_time` (GetStatus `now_ms` increases by at least the advance); `#[cfg(not(feature = "test-clock"))] advance_clock_is_rejected_without_feature`. In `tests/stage-helper.test.js`: `release build command has no test-clock feature` (reads `.github/workflows/build.yml` and asserts it does not contain `test-clock`).
- [ ] **Step 2:** Run both → FAIL.
- [ ] **Step 3:** Add the feature and the `stdio` interception (`#[cfg(feature = "test-clock")]`). In `ci.yml` build the debug binary with `--features test-clock` and run `cargo test --features test-clock` as well as the plain `cargo test`.
- [ ] **Step 4:** `cargo test --manifest-path focus-helper/Cargo.toml --features test-clock`, `cargo test --manifest-path focus-helper/Cargo.toml`, `node --test tests/stage-helper.test.js` → pass.
- [ ] **Step 5:** Commit `feat(helper): test-only clock advance`.

### Task 4: Schema v2 and limits

**Files:** Modify `src/modules/focus/schema.js`, `limits.js`; Test `tests/focus-schema.test.js`, `tests/focus-limits.test.js`.

**Interfaces:**
- Produces: `focus_sessions.unlock_delay_ms INTEGER` (nullable); `schema_version` `'2'`; in `limits.js`: `MIN_UNLOCK_DELAY_MS = 3600000`, `MAX_UNLOCK_DELAY_MS = 604800000`, `validateUnlockDelay(lock, delayMs) -> {ok:true}|{ok:false,reason:'bad-delay'}` (locked requires a number in range; other locks require null/undefined); `validateForPush(w)` also fails a window whose `unlock_delay_ms` breaks that rule.

- [ ] **Step 1: Write failing tests:** update `migrateFocus is idempotent` to expect `'2'`; add `migrates a v1 database to v2 keeping existing rows` (create V1 by inserting `schema_version = 1` with the six tables plus one session, run `migrateFocus`, the row survives and `unlock_delay_ms` is null); limits tests for `validateUnlockDelay` boundaries (3599999 fails, 3600000 ok, 604800000 ok, 604800001 fails, locked without delay fails, `none` with a delay fails) and `validateForPush` with a locked window.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement a V2 step in `migrateFocus` (`ALTER TABLE focus_sessions ADD COLUMN unlock_delay_ms INTEGER`, version bump in one `db.batch`); a fresh database runs V1 then V2.
- [ ] **Step 4:** `node --test tests/focus-schema.test.js tests/focus-limits.test.js` → pass.
- [ ] **Step 5:** Commit `feat(focus): schema v2 and unlock delay limits`.

### Task 5: Store support for locked sessions

**Files:** Modify `src/modules/focus/store.js`; Test `tests/focus-store.test.js`.

**Interfaces:**
- Produces: `createSessions(db, { listIds, starts, ends, lock = 'none', unlockDelayMs = null })`; `listSessions(db)` returns `{ id, listId, starts, ends, lock, unlockDelayMs }`; `deleteSessions(db, ids)` throws `Error('locked')` if any row is not `none` (the normal cancel path); new `endLockedSessions(db, ids)` (deletes rows; used only by unlock/reconcile); `saveList(db, input, nowMs)` returns `{ ok:false, errors:{ name:'That list is part of a locked block until <…>' } }` shape consistent with its existing errors when the list belongs to a locked session with `ends > nowMs`; `deleteList` already refuses while any session is running.

- [ ] **Step 1: Write failing tests:** `creates a locked session with its delay and reads it back`, `deleteSessions refuses locked rows and deletes none rows`, `endLockedSessions removes locked rows`, `saveList refuses editing a list in a running locked block`, `saveList allows editing after the locked block ended`, `a normal running block does not block editing` (current behaviour).
- [ ] **Step 2:** Run `node --test tests/focus-store.test.js` → FAIL.
- [ ] **Step 3:** Implement; every multi-statement write stays in one `db.batch`. Existing callers of `saveList` in the controller pass `now()`.
- [ ] **Step 4:** `node --test tests/focus-store.test.js tests/focus-controller.test.js` → pass.
- [ ] **Step 5:** Commit `feat(focus): store locked sessions`.

### Task 6: Sync merges a locked block into one window

**Files:** Modify `src/modules/focus/expand.js`, `sync.js`; Test `tests/focus-expand.test.js`, `tests/focus-sync.test.js`.

**Interfaces:**
- Produces in `expand.js`: `lockedBlockToWindow(sessions, listsById) -> Window` where `sessions` share `starts`, `ends`, `lock`, `unlockDelayMs`; id is `'b' + starts + '-' + ends + '-' + sortedListIds.join('.')`; sites and apps are the de-duplicated union of the lists' targets; `unlock_delay_ms` is set. `sessionToWindow` is unchanged for `none`.
- `syncWindows` groups sessions with `lock === 'locked'` by `starts:ends:unlockDelayMs` and emits one window per group; `none` sessions still produce one window per list.

- [ ] **Step 1: Write failing tests:** `two lists in one locked block become one window with the union of items`, `window id is stable across calls and independent of row order`, `same lists and times but lock none stay separate windows from a locked block` (Review Focus 2), `locked windows carry unlock_delay_ms`, `sync pushes the merged window and counts it once`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the grouping in `sync.js` using `lockedBlockToWindow`; invalid windows are skipped and counted as today.
- [ ] **Step 4:** `node --test tests/focus-expand.test.js tests/focus-sync.test.js` → pass.
- [ ] **Step 5:** Commit `feat(focus): one helper window per locked block`.

### Task 7: Client methods and pure lock logic

**Files:** Modify `src/modules/focus/helper-client.js`, `model.js`; Create `src/modules/focus/lock-logic.js`; Test `tests/focus-client.test.js`, `tests/focus-model.test.js`, `tests/focus-lock-logic.test.js`.

**Interfaces:**
- Produces in `helper-client.js`: `requestDelayedUnlock(windowId)` (returns the response with `unlock_at`), `cancelDelayedUnlock(windowId)`.
- `groupSessions` blocks gain `lock` and `unlockDelayMs` (block key already includes the lock; the delay is added to the group key).
- `lock-logic.js`: `UNLOCK_DELAY_PRESETS_H = [1, 6, 24]`; `resolveDelayHours({preset, custom}) -> {ok:true,hours}|{ok:false,message}` (whole hours 1..168, message names the range); `lockedWarning(delayHours)` returns the exact confirmation sentence from the spec with the hours; `describeUnlockError(err) -> string` mapping helper error codes `bad-signature`, `expired`, `wrong-challenge`, `wrong-lock`, `already-used`/reuse code (read the codes in `focus-helper/src/unlock.rs` `UnlockError::reason`), `no-partner`, `no-such-lock`, `lock-active`, `bad-key`, `not-delayable`, `no-pending-unlock`, `unreachable` to plain sentences (unknown code → the helper's message); `windowIdForBlock(block)` mirroring `lockedBlockToWindow`'s id; `pendingUnlockFor(status, windowId) -> number|null`.

- [ ] **Step 1: Write failing tests:** client sends the right JSON for both new methods; `describeUnlockError` for each code above and for a garbage object (must not throw); `resolveDelayHours` bounds (0, 1, 168, 169, '2.5', ''); `lockedWarning(24)` contains "24 hours"; `windowIdForBlock` equals the id `lockedBlockToWindow` builds for the same block; `pendingUnlockFor` with missing/malformed status returns null.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `node --test tests/focus-client.test.js tests/focus-model.test.js tests/focus-lock-logic.test.js` → pass.
- [ ] **Step 5:** Commit `feat(focus): lock client methods and pure lock logic`.

### Task 8: Controller lock actions

**Files:** Modify `src/modules/focus/controller.js`; Test `tests/focus-controller.test.js`.

**Interfaces:**
- Consumes: Tasks 5-7 and the existing queue (`enqueue`), `doResync`, `reload`, `changed`.
- Produces (all return `{ ok: true, ... }` or `{ ok: false, message }`, never throw): `startLockedBlock({ listIds, minutes, delayHours })`; `setPartner({ publicKey, name })`; `requestPartnerChallenge(blockKey) -> { ok, code }`; `submitPartnerToken(blockKey, token)`; `startDelayedUnlock(blockKey) -> { ok, unlockAt }`; `cancelDelayedUnlock(blockKey)`. `extendBlock` allows locked blocks (longer only, cap 7 days for locked; message names the cap). `cancelBlock` returns `{ ok:false, message:'A locked block cannot be cancelled. Use Unlock early.' }` for a locked block. State gains `partner: { set: boolean, name: string|null }` derived from the latest status (`partner_set`) and `focus_partner`.
- Behaviour: `startLockedBlock` first calls `client.status()`; if unreachable or `partner_set` is false it fails with the plain reason and writes nothing. It writes the rows, pushes via `syncWindows`; if the push throws, it deletes the rows with `endLockedSessions` and returns `{ ok:false, message:'Nothing was locked. <reason>' }`. After every status poll `reconcile` runs: a locked block whose window id is absent from `status.windows` while `now < ends` is removed with `endLockedSessions`.

- [ ] **Step 1: Write failing tests** with a fake client: `locked start fails and writes nothing when the helper is down` (Review Focus 1), `locked start fails when no partner key`, `locked start rolls back rows when the push is rejected`, `locked start succeeds and the helper receives one merged window`, `cancelBlock refuses a locked block`, `extend only lengthens a locked block and caps at 7 days`, `token success removes the block after reconcile`, `each token error leaves the lock and returns the plain message` (loop over the codes from Task 7), `garbage token and garbage partner key never throw` (Review Focus 7), `delayed unlock request returns the unlock time; cancel clears it`, `request while helper unreachable says it was not sent`, `reconcile removes a locked block the helper no longer holds`, `setPartner stores the name and key only after the helper accepts`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `node --test tests/focus-controller.test.js` and `npm test` → pass.
- [ ] **Step 5:** Commit `feat(focus): controller lock actions`.

### Task 9: Start dialog Locked option and partner setup dialog

**Files:** Modify `src/modules/focus/ui/start-dialog.js`, `src/modules/focus/ui/home.js`, `src/modules/focus/index.js`, `src/styles.css`; Create `src/modules/focus/ui/partner-setup.js`; Test `tests/focus-ui-dom.test.js` (pure parts), screenshots via `scripts/focus-steps.mjs`.

**Interfaces:**
- Consumes: Task 7 `lock-logic.js`, Task 8 controller actions; `PARTNER_PAGE_SOURCE` from `unlock.js` for the partner page download.
- Produces: `openPartnerSetup({ controller, onDone }) -> { close() }` (dialog with the three steps from the spec: save page, paste key and name, save); Start dialog radio "Normal" / "Locked" (Locked shows duration up to 10080 minutes, the delay chips from `UNLOCK_DELAY_PRESETS_H` plus custom hours, the warning text and a required checkbox; with no partner it shows a "Set up your partner first" button that opens `openPartnerSetup`; with the helper not `ok` it is disabled with the reason). Dialog `canClose` honours `busy` as in Ruling 9. `deps.openPartnerSetup` is passed from `index.js` through `home.js` (Ruling 2 pattern).

- [ ] **Step 1: Write failing tests** for the pure helpers used by the dialogs (`canStartLocked({selectedIds, duration, delay, confirmed})` in `lock-logic.js`, with false for each missing piece) and add scenarios to `scripts/focus-steps.mjs`: Locked disabled with the reason when the helper is down; with no partner the setup button opens the dialog; a bad key shows the helper's refusal; with a partner set (fake key from `tests/fixtures/unlock-vectors.json`) a locked start succeeds and a card appears; the confirm checkbox gates Start; Esc is inert while pending.
- [ ] **Step 2:** `node --test tests/focus-lock-logic.test.js` → FAIL. **Step 3:** Implement. **Step 4:** run the screenshot scenarios (`node scripts/shot.mjs /tmp/lk1 --helper target/debug/focus-helper --steps scripts/focus-steps.mjs`, built with `--features test-clock`) in light and dark; view every new image; "no console errors". `npm test` passes.
- [ ] **Step 5:** Commit `feat(focus-ui): locked option and partner setup`.

### Task 10: Locked card, unlock dialog, helper details

**Files:** Modify `src/modules/focus/ui/home.js`, `ui/helper-details.js`, `model.js` (`detailRows` shows partner name and pending unlock times), `src/styles.css`; Create `src/modules/focus/ui/unlock-dialog.js`; screenshots via `scripts/focus-steps.mjs`.

**Interfaces:**
- Produces: `openUnlockDialog({ controller, block, onDone }) -> { close() }` with the two options from the spec; locked cards have a lock label, "Locked until <time>", no Cancel button, an **Unlock early** button, Extend (+15 min, +1 h, custom), and while a wait is pending "Unlocks at <time> unless you cancel". Lists that belong to a running locked block show Edit and Delete disabled with the reason.

- [ ] **Step 1:** Add scenarios: locked card has no Cancel button; Unlock early opens the dialog; Get a code shows a code and a copy button; a wrong token shows the plain reason and the lock stays; a correct token (signed with `signUnlock` from `unlock.js` using the fixture private key) removes the card; Wait it out shows the unlock time and a Cancel request button; cancelling leaves the card; the pending-wait card text; Helper details lists the pending unlock; list Edit/Delete disabled in a locked block; Esc inert while a request is pending.
- [ ] **Step 2:** Run the steps → the new scenarios FAIL. **Step 3:** Implement. **Step 4:** Run in light and dark, view every PNG, fix defects; "no console errors"; `npm test` passes.
- [ ] **Step 5:** Commit `feat(focus-ui): locked card and unlock dialog`.

### Task 11: End-to-end tests with the real helper

**Files:** Create `tests/focus-locks-e2e.test.js`; Modify `tests/focus-ui-e2e.test.js` only if its `setup` helper needs to expose the new client methods (extend its wrapper client; do not duplicate the setup).

**Interfaces:**
- Consumes: controller, client, `createStdioCall`, `signUnlock` and `generatePartnerKeys` from `unlock.js`, the helper built with `--features test-clock`. Tests probe support by sending `{"type":"AdvanceClock","ms":0}` and skip (with a clear reason) when the binary is missing or answers `bad-request`.

- [ ] **Step 1: Write the tests:** `start a locked block: helper holds one locked window with the delay`; `cancel is refused and the helper still holds the window`; `unlock with a real partner token ends the lock and a re-sync does not bring it back`; `wait it out: request, AdvanceClock past the delay, the window is gone and the controller removes the block`; `cancelling a wait keeps the lock after the delay passes`; `a wait survives restarting the helper bridge (same state file)`; `partner token during a wait ends the lock and clears the wait`; `locked start with the helper down leaves no rows` (Review Focus 1); `editing a list in a running locked block is refused`.
- [ ] **Step 2:** `cargo build --manifest-path focus-helper/Cargo.toml --features test-clock` then `node --test tests/focus-locks-e2e.test.js` → PASS (or FAIL on real defects; fix them in the owning task's files and note it).
- [ ] **Step 3:** `npm test` → pass; bridges closed and temp dirs removed in `t.after` so nothing hangs.
- [ ] **Step 4:** Commit `test(focus-locks): end-to-end with the real helper`.

### Task 12: Checklist, README, CI parity

**Files:** Modify `docs/superpowers/focus-room-windows-checklist.md`, `README.md`, `scripts/focus-steps.mjs` (final state coverage).

- [ ] **Step 1:** Add checklist section "Focus locks (sub-project 4a)" in the file's existing `- [ ] action — Expected: result` format: partner setup and refusal during a lock; a locked block survives closing the app and a reboot; stopping and uninstalling the service is refused during a lock; unlock with a partner token; unlock by waiting (use the shortest delay, 1 hour); clock moved back does not shorten a wait; cancelling a wait; locked start refused while the service is stopped.
- [ ] **Step 2:** README: a short "Focus locks" note with the build command for the test-clock helper (`cargo build --manifest-path focus-helper/Cargo.toml --features test-clock`) and the e2e test command.
- [ ] **Step 3:** Run the full screenshot pass in light and dark, view every PNG, fix defects; "no console errors".
- [ ] **Step 4:** Run `npm test`, `cargo test --manifest-path focus-helper/Cargo.toml --features test-clock`, `cargo test --manifest-path focus-helper/Cargo.toml`, the three CI-parity generators then `git diff --exit-code` on their outputs → all clean.
- [ ] **Step 5:** Commit `docs(focus-locks): checklist, README and final screenshots`.
