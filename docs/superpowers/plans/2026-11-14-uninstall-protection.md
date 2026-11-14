# Uninstall protection (6c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uninstalling the helper (and stopping its service) always needs a permit: the partner's signed code or a finished waiting period; the app shows and drives the process.

**Architecture:** New permit/pending/wait fields in the helper's `LockStore`, reusing the existing challenge/token and delayed-unlock machinery with the reserved target id `uninstall`. A portable `uninstall_gate` replaces the lock-only check in the Windows `uninstall` command and gates the service Stop control. The app adds client calls, controller state and an "Uninstall protection" section.

**Tech Stack:** Rust (existing crate), vanilla JS ES modules, `node --test`, NSIS hook text.

**Spec:** `docs/superpowers/specs/2026-11-14-uninstall-protection-design.md`

**Order:** run this plan after the time limits plan (`2026-11-14-focus-time-limits.md`) is merged: both change `lockstore.rs` challenge/unlock code.

## Global Constraints

- Reserved target id `uninstall`: validation rejects it as a window id and as a limit id.
- Permit: 30 minutes after a valid partner token for target `uninstall` (single-use challenge), 60 minutes after a finished waiting period; cleared on a completed uninstall; expiry judged on the effective clock (`max(wall, high_water + monotonic)`); clock moved back never shortens a wait or revives a permit.
- Waiting period `uninstall_wait_ms`: default 86,400,000; bounds 3,600,000 to 604,800,000; increasing applies at once, decreasing is `needs-permit` unless a permit is active; out of bounds is `bad-request`.
- Protocol additions: `RequestUninstallDelay` -> `UninstallPending { unlock_at }`; `CancelUninstallDelay` -> `Ok` (error `no-pending-uninstall`); `SetUninstallWait { wait_ms }` -> `Ok`; `RequestChallenge { window_id: "uninstall" }` valid at any time; `Status.uninstall = { wait_ms, pending_at, permit_until }` (`#[serde(default)]`). Old state files load as protected, default wait, nothing pending.
- `uninstall_gate(store, now_ms) -> Result<(), String>`: lock-pending message first (existing text), else the how-to message when no valid permit: "Uninstall is protected. Open MyBrain, then Focus Room, then Uninstall protection, ask your partner for a code or start the waiting period, then run the uninstaller again."
- `stop_allowed` requires a valid permit in addition to the existing lock rule. Upgrades (`install`) over a RUNNING helper need a permit too (same gate as `uninstall`, refused early with exit code 1 and the how-to message; first installs and installs with no running service need none); `uninstall` with no helper service installed skips the gate. A partner key set less than one waiting period ago cannot approve an uninstall (`partner-too-new`; `Status.uninstall.partner_ready_at`); `ResetClock` is refused while an uninstall wait or permit exists.
- Windows-only code cannot be run in CI; keep it minimal and read-checked; try `cargo check --target x86_64-pc-windows-gnu` (install the target with `rustup target add` if possible) and report honestly if it cannot be done.
- Titles/keys never logged; vanilla JS, light/dark via existing CSS variables; every subagent runs on Sonnet.

## Review Focus

- No path grants a permit without a valid token or a completed wait; a token for another target or reused challenge is rejected: Task 1.
- A permit can never be extended or revived by clock changes; expired permit refuses again with the same how-to text: Task 1 and 2.
- A pending lock still blocks uninstall even with a permit; upgrades over a running helper need a permit (a first install or none-running install does not), and an uninstall with no helper installed needs none: Task 1 and 3.
- Helper down shows no claim that protection is active; old state loads: Task 4 and 5.
- A bug cannot leave the service unstoppable with no documented recovery: Task 3 and 6 (checklist recovery text).

---

### Task 1: Permit, pending and wait in the lock store (portable)

**Files:**
- Modify: `focus-helper/src/lockstore.rs`, `focus-helper/src/service_logic.rs`, `focus-helper/src/unlock.rs` only if challenge code binding needs it
- Test: `focus-helper/tests/lockstore.rs`, `focus-helper/tests/unlock_vectors.rs`, `focus-helper/src/service_logic.rs` unit tests

**Interfaces:**
- Produces: `LockStore.uninstall_wait_ms: i64` (serde default 86_400_000), `uninstall_pending: Option<UninstallPending { unlock_at: i64 }>`, `uninstall_permit: Option<UninstallPermit { granted_at: i64, expires_at: i64 }>` (all `#[serde(default)]`); `pub const UNINSTALL_ID: &str = "uninstall"; PARTNER_PERMIT_MS = 1_800_000; WAIT_PERMIT_MS = 3_600_000; MIN_UNINSTALL_WAIT_MS = 3_600_000; MAX_UNINSTALL_WAIT_MS = 604_800_000`; methods: `request_challenge` accepts `UNINSTALL_ID` at any time; `submit_token` for that challenge grants a partner permit and clears pending (single use); `request_uninstall_delay(now_ms) -> i64`, `cancel_uninstall_delay() -> bool`, `set_uninstall_wait(wait_ms, now_ms) -> Result<(), SetWaitError>` (`BadValue`, `NeedsPermit`), `permit_valid(now_ms) -> bool`, `expire_pending` also turns a due uninstall wait into a permit and drops an expired permit; `clear_permit()`; window/limit validation rejects id `uninstall`; service_logic: `pub fn uninstall_gate(store: &LockStore, now_ms: i64) -> Result<(), String>` and `stop_allowed(windows, now_ms)` gains a permit parameter via a new `stop_allowed_with_permit(windows, permit_valid, now_ms)` (keep the old function as a thin wrapper used by existing tests).

- [ ] **Step 1: Write failing tests:** old JSON without the fields loads protected/default; challenge for `uninstall` with no windows succeeds; valid token (existing vector style, challenge bound to `uninstall`) grants a permit expiring in exactly 30 minutes, second submit of the same token fails, a token signed for a window challenge does not grant a permit and a token for `uninstall` does not end a window; wait route: request returns `now + wait`, repeat returns the same, cancel clears, at `unlock_at` `expire_pending` yields a permit with `expires_at = unlock_at_time + 60 min`, permit expires and is dropped after; clock moved back (effective clock) does not shorten; `set_uninstall_wait`: raise ok, lower without permit `NeedsPermit`, lower with permit ok, 3,599,999 and 604,800,001 `BadValue`; pushing a window or limit with id `uninstall` is rejected; `uninstall_gate`: no permit Err(how-to), permit Ok, permit plus pending locked window Err(lock message), expired permit Err; `stop_allowed_with_permit`: lock pending + permit false, no lock + no permit false, no lock + permit true.
- [ ] **Step 2: Run** `cd focus-helper && cargo test`; expect FAIL.
- [ ] **Step 3: Implement.** Reuse the delayed-unlock and token verification code; keep window/limit behavior and shared vectors unchanged.
- [ ] **Step 4: Run** `cargo test` and `cargo test --features test-clock`; PASS.
- [ ] **Step 5: Commit** `feat(helper): uninstall permit, waiting period and gate`.

### Task 2: Protocol, daemon and status

**Files:**
- Modify: `focus-helper/src/ipc.rs`, `focus-helper/src/daemon.rs`, `focus-helper/src/persist.rs` (version/defaults only if needed), `focus-helper/src/main.rs` (stdio mode routes the new requests)
- Test: `focus-helper/tests/ipc.rs`, `focus-helper/tests/daemon.rs`, `focus-helper/tests/persist.rs`, `focus-helper/tests/stdio.rs`

**Interfaces:**
- Consumes: Task 1 store methods.
- Produces: requests/responses and `Status.uninstall` per Global Constraints; `Daemon::stop_allowed` uses `stop_allowed_with_permit`; a permit/pending change is persisted at once; `UninstallPending { unlock_at }` response; errors `no-pending-uninstall`, `needs-permit`, `bad-request`.

- [ ] **Step 1: Write failing tests:** each request's happy path and error through `handle_line`; `GetStatus` includes `uninstall` with exact numbers on a test clock; pending becomes `permit_until` after `AdvanceClock` (test-clock) and then drops after the permit window; token route end to end through `RequestChallenge {window_id:"uninstall"}` + `SubmitToken`; persistence round trip and restart keep pending and permit; `stop_allowed` flips with the permit; `ResetClock`/partner-change interplay unchanged.
- [ ] **Step 2: Run** `cargo test`; FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test`, `cargo test --features test-clock`, `cargo build --features test-clock`; PASS.
- [ ] **Step 5: Commit** `feat(helper): uninstall protection requests and status`.

### Task 3: Windows wiring and installer text

**Files:**
- Modify: `focus-helper/src/win/install.rs` (the two `uninstall_decision` checks inside `uninstall` use `uninstall_gate`; `install` unchanged), `focus-helper/src/win/pipe.rs` / `win/service.rs` only if the Stop gating needs the updated `stop_allowed` (it already calls `daemon.stop_allowed`), `src-tauri/installer-hooks.nsh` (exit code 1 message becomes the how-to text), `docs` recovery text in Task 6
- Test: unit tests in `service_logic.rs` for any new pure helper; no new Windows-only logic beyond small calls

**Interfaces:**
- Consumes: Task 1 `uninstall_gate`, `clear_permit`, persistence save function.
- Produces: `uninstall()` refuses without a permit (exit code 1 with the gate message printed to stderr and the install log); after a successful removal the permit is cleared and saved when state is kept (`purge_state` false), and the state is purged otherwise.

- [ ] **Step 1: Write failing tests** for any new pure helper (for example a function deciding the post-uninstall state change); otherwise write the test that `uninstall_gate`'s messages match the NSIS text constants if you introduce shared constants.
- [ ] **Step 2: Implement** the wiring: replace both `uninstall_decision(&store.windows, now)` calls in `uninstall()` with `uninstall_gate(&store, now)`; keep `install()` using `uninstall_decision`. Update the NSIS `$0 = 1` message to: `Uninstall is protected by MyBrain Focus Room. Open MyBrain, then Focus Room, then Uninstall protection, ask your partner for a code or start the waiting period, then run the uninstaller again.`
- [ ] **Step 3: Try** `rustup target add x86_64-pc-windows-gnu && cd focus-helper && cargo check --target x86_64-pc-windows-gnu` (and `--tests` if it works); report the exact outcome. If the target or linker is unavailable, say so and read the Windows diff twice for type and borrow errors.
- [ ] **Step 4: Run** `cargo test`, `cargo test --features test-clock`; PASS.
- [ ] **Step 5: Commit** `feat(helper): gate Windows uninstall and Stop on the uninstall permit`.

### Task 4: App client, controller and pure logic

**Files:**
- Modify: `src/modules/focus/helper-client.js`, `src/modules/focus/controller.js`, `src/modules/focus/lock-logic.js` (or a new `src/modules/focus/uninstall-logic.js`)
- Test: `tests/focus-client.test.js`, `tests/focus-controller.test.js`, `tests/focus-lock-logic.test.js` (or `tests/focus-uninstall-logic.test.js`)

**Interfaces:**
- Produces: client `requestUninstallDelay()`, `cancelUninstallDelay()`, `setUninstallWait(waitMs)`, `requestUninstallChallenge()` (= `RequestChallenge {window_id:'uninstall'}`), `submitUninstallToken(token)` (= `SubmitToken`); controller `state.uninstall = { waitMs, pendingAt, permitUntil, known }` from `Status.uninstall` (`known:false` when the helper is down or the field is missing); methods `uninstallRequestDelay()`, `uninstallCancelDelay()`, `uninstallSetWait(ms)`, `uninstallChallenge()`, `uninstallSubmitToken(token)` returning `{ok,...}`/`{ok:false,message,code}`; pure `uninstallStatusText(state, nowMs, helperKind, partnerSet) -> { headline, detail, tone }`, `validateWait(ms) -> {ok, reason}` (1 h to 7 days), `isWaitWeakening(oldMs, newMs)`, `formatCountdown(ms)` (`'23h 59m'`, `'4m 05s'`).

- [ ] **Step 1: Write failing tests:** message shapes; state mapping incl. missing field and helper down (`known:false`, never "active"); text for each case (protected no pending, pending with countdown, permit active with expiry clock, no partner hint, helper down); wait bounds and weakening; countdown formats; errors `needs-permit` and `no-pending-uninstall` mapped to the messages in the spec.
- [ ] **Step 2: Run** the three test files with `node --test`; FAIL.
- [ ] **Step 3: Implement.** Follow how delayed unlock is wired in the controller.
- [ ] **Step 4: Run** them and `npm test`; PASS.
- [ ] **Step 5: Commit** `feat(focus): uninstall protection client, controller and logic`.

### Task 5: Uninstall protection UI

**Files:**
- Create: `src/modules/focus/ui/uninstall-section.js`
- Modify: `src/modules/focus/ui/home.js` (mount the section), `src/modules/focus/ui/unlock-dialog.js` (support target `uninstall` for the partner route: no block, challenge for `uninstall`, success text "Your partner's code was accepted. You can uninstall for the next 30 minutes."), `src/styles.css`
- Test: `tests/focus-uninstall-ui.test.js`, extend `tests/focus-ui-e2e.test.js` if it mounts the home

**Interfaces:**
- Consumes: Task 4 controller methods/state and logic; existing dialog helpers.
- Produces: `mountUninstallSection(root, controller, deps) -> cleanup`; buttons `data-fk` `un-partner`, `un-wait`, `un-cancel`, `un-setwait`; the wait control (hours select 1 h to 7 days) where lowering opens the partner/wait dialog instead of saving.

- [ ] **Step 1: Write failing tests** (fake controller and DOM): protected state text and buttons; pending shows countdown and Cancel; permit active shows "You can uninstall until HH:MM"; no partner shows the explanation and no partner button; helper down shows "Enforcement is not running" and no controls; raising the wait calls `uninstallSetWait`; lowering opens the dialog and saves nothing; partner route calls challenge then submit and shows the success text; errors shown inline; no `undefined`/NaN text; cleanup stops timers.
- [ ] **Step 2: Run** `node --test tests/focus-uninstall-ui.test.js`; FAIL.
- [ ] **Step 3: Implement,** following the structure of the existing sections; refresh via the controller's status subscription.
- [ ] **Step 4: Run** the test and `npm test`; PASS.
- [ ] **Step 5: Commit** `feat(focus): Uninstall protection section`.

### Task 6: End to end, screenshots, docs, checklist

**Files:**
- Create: `tests/focus-uninstall-e2e.test.js`; Modify: `scripts/focus-steps.mjs`, `docs/superpowers/focus-room-windows-checklist.md`, the 6c spec Status

**Interfaces:**
- Consumes: everything above; helper built with `--features test-clock`.

- [ ] **Step 1: Write the e2e test** (same harness as `tests/focus-detail-e2e.test.js`): status shows default wait and nothing pending; `RequestUninstallDelay` then `AdvanceClock` past the wait gives `permit_until`, past the permit window drops it; `SetUninstallWait` raise/lower rules; partner token route using the existing partner key helpers in the locks e2e test; `RequestChallenge {window_id:"uninstall"}` works with no windows; restart keeps pending.
- [ ] **Step 2: Run** with the helper built; implement any gap; PASS.
- [ ] **Step 3: Screenshots** of the section in each state (protected, pending, permit active, no partner, helper down; light, dark, phone) via `scripts/focus-steps.mjs` into the scratchpad `shots` folder (not committed); look at them and report layout problems; fix only tiny obvious ones.
- [ ] **Step 4: Docs:** Windows checklist section (uninstaller refused without a permit with the how-to message; partner code then uninstall works; waiting period then uninstall works; permit expiry; Stop from Services refused then allowed with a permit; upgrade install over a running helper needs a permit; recovery for an Administrator: boot, take ownership of the service and install folder, `sc config MyBrainFocus start= disabled`, delete; also what happens if the app cannot reach the helper), accepted limits (Administrators can still remove it; clock forward can shorten a wait; permit windows; locked limits are covered because uninstall always needs a permit; upgrades over a running helper need a permit; a new partner key waits one waiting period), spec Status set to built.
- [ ] **Step 5: Run** `npm test`, `cd focus-helper && cargo test && cargo test --features test-clock && cargo build --features test-clock`; PASS; commit `test/docs: uninstall protection end to end, checklist`.
