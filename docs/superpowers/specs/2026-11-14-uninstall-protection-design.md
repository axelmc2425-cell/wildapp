# Focus Room uninstall protection (sub-project 6c)

Date: 2026-11-14. Status: built (end to end test and Windows checklist section 20 added). Approved by the owner's "build the rest"; the owner's earlier decision stands: **uninstalling always needs the partner's code or a waiting period**, even when no block is running. Calls marked (call) are the controller's.

Builds on `2026-11-09-focus-locks-design.md` (partner key, challenge tokens, waiting periods, tombstones) and the helper install/uninstall code (`focus-helper/src/win/install.rs`, `service_logic.rs`, `src-tauri/installer-hooks.nsh`).

## Intent

The owner wants the app to be hard to remove in a weak moment. Today uninstall is refused only while a Locked or Frozen block is pending. It should always need a deliberate step: the accountability partner's signed code, or a waiting period the owner cannot shorten.

## Goals

- `focus-helper uninstall` (run by the MyBrain uninstaller) is refused unless an **uninstall permit** is active (and, as today, no locked or frozen window is pending).
- A permit is granted by (a) a valid partner token for the fixed target `uninstall`, instantly, or (b) a waiting period: the owner asks to uninstall in the app; after the waiting period the helper grants a permit.
- A permit is valid for 60 minutes (call) after it is granted by waiting, or 30 minutes (call) after a partner code, and is cleared when the uninstall completes. An expired permit needs a new request.
- The waiting period defaults to 24 hours (call) and can be 1 hour to 7 days. Making it longer is free; making it shorter, like all weakening, needs a permit (partner code or the waiting period itself). Without a partner the waiting period is the only way.
- The Windows service Stop control (already refused during locks) is also refused unless a permit is active, so the service cannot be stopped from the Services panel in a weak moment.
- The Focus Room shows an "Uninstall protection" section: protected/unprotected state, the waiting period and how to change it, a pending request with a countdown and a cancel button, an active permit with its expiry, and the partner-code route (reusing the unlock dialog).
- The uninstaller's refusal message says exactly what to do (open MyBrain, Focus Room, Uninstall protection; ask the partner or start the waiting period; run the uninstaller again).
- Upgrades by installing a newer MyBrain keep working under today's rules (refused only while a lock is pending); they never need a permit.

## Non-goals

Protection against an Administrator who takes ownership of the services or install folder (documented friction, as today), preventing manual file deletion with the helper stopped, an off switch (protection is always on), protecting the app files when the helper is already missing, remote/partner notification, notifications when a request starts (the partner is told by the owner).

## Anti-goals

- No path that grants a permit from the app database alone: the app is untrusted and everything is decided by the helper.
- Moving the system clock backwards must not shorten a waiting period or revive an expired permit (existing effective clock). Moving forward can shorten it (existing documented limit).
- A bug here must never leave the helper impossible to remove by an Administrator with a documented manual recovery.

## Constraints

- Helper state is the authority; old state files without these fields load as "protected, default wait, nothing pending".
- Existing protocol, windows, locks, partner unlock and limits keep working. Additions only.
- Windows-only code cannot run in CI. Portable decision logic is tested with fake clocks; Windows wiring is checked by reading, by `cargo check --target x86_64-pc-windows-gnu` if that target can be installed here (the builder tries; if not, it says so), and by the manual checklist.

## Approaches considered

1. **Permit in the helper state (chosen).** The uninstall command reads the state file like it already does for locks, and refuses without a valid permit. Same tamper resistance as locks.
2. **Prompt inside the uninstaller** (a password or code typed into the NSIS dialog). Rejected: the helper would have to verify offline-signed tokens inside the installer, and the waiting period needs the helper anyway.
3. **Treat uninstall as a Locked block that never ends until unlocked.** Rejected: confusing UI, interacts with schedules and block counts.

## Design

### Helper (Rust)

- **State** (`lockstore.rs`, new fields default for old files): `uninstall_wait_ms: i64` (default 86,400,000; bounds 3,600,000 to 604,800,000), `uninstall_pending: Option<{ unlock_at: i64 }>`, `uninstall_permit: Option<{ granted_at: i64, expires_at: i64 }>`.
- **Partner route:** `RequestChallenge { window_id: "uninstall" }` is valid at any time (the reserved id `uninstall` cannot be used as a window or limit id: validation rejects it); `SubmitToken` for it grants a permit expiring 30 minutes later, clears any pending wait, and the challenge is used once.
- **Waiting route:** `RequestUninstallDelay` stores `unlock_at = effective_now + uninstall_wait_ms` (a repeat returns the existing time); `CancelUninstallDelay` clears it; on every tick/request `expire_pending` turns a due request into a permit expiring 60 minutes later. Answers: `UninstallPending { unlock_at }`, `Ok`.
- **Wait setting:** `SetUninstallWait { wait_ms }`: increasing is applied at once; decreasing is refused (`needs-permit`) unless a permit is active, in which case it applies and the permit stays. Out-of-bounds is `bad-request`.
- **Status:** new field `uninstall: { wait_ms, pending_at: Option<i64>, permit_until: Option<i64> }` (default when missing).
- **Gate:** `pub fn uninstall_gate(store: &LockStore, now_ms: i64) -> Result<(), String>`: Err with the lock message when a window is pending (existing text), else Err with the how-to message when no valid permit, else Ok. `stop_allowed` additionally requires a valid permit or no helper protection state... it requires a valid permit whenever the service Stop is requested (a stop with no permit is refused), keeping the lock rule.
- **Windows wiring (cannot be compiled in CI):** `uninstall()` uses `uninstall_gate` at both of its checks; a successful removal clears the permit (state is purged when `purge_state`, otherwise the permit is cleared and saved); the pipe/service Stop handling calls the updated `stop_allowed`; `install` (upgrade) keeps `uninstall_decision` (locks only). NSIS: exit code 1 message updated to the how-to text.

### App (JavaScript)

- Client: `requestUninstallDelay()`, `cancelUninstallDelay()`, `setUninstallWait(ms)`; `Status.uninstall` handled in the controller state; the unlock dialog works for the target `uninstall` (partner code) and for the waiting route.
- Pure logic: formatting of the countdown and permit expiry, validation of the wait (1 h to 7 days), is-weakening for the wait.
- UI: "Uninstall protection" section on the Focus Room home: status line, waiting period control, buttons "Ask for a partner code" and "Start the waiting period (24 h)", pending countdown with Cancel, active permit text ("You can uninstall until 14:20"), and short instructions. States: helper down (no controls, "Enforcement is not running"), no partner (explains that the wait is the only way and links to partner setup).

## Errors

- `needs-permit` shows "Shortening the wait needs your partner's code or a finished waiting period".
- Helper down: section shows saved text only; nothing claims protection is active.
- Permit expired: the uninstaller message is the same how-to text.

## Testing

- Rust: default load of old state; challenge for `uninstall` anytime; token grants a 30-minute permit and is single use, wrong token or wrong target rejected; waiting route creates, repeats, cancels, becomes a permit at `unlock_at` on the effective clock, permit expires after 60 minutes, clock moved back never shortens; wait setting increase/decrease rules and bounds; reserved id rejected for windows and limits; `uninstall_gate` messages for each case incl. lock pending plus permit; `stop_allowed` with and without a permit; status field; persistence round trip.
- JS: client messages, controller state, pure logic, section states and flows with fake controller, unlock dialog for the `uninstall` target.
- End to end with the real helper over stdio using test-clock `AdvanceClock`: request challenge, delay route to a permit, permit expiry, wait setting rules.
- Windows checklist: uninstaller refused without a permit with the how-to message; partner code then uninstall works; waiting period then uninstall works; permit expiry; Stop from the Services panel refused then allowed with a permit; upgrade install still works with no permit; recovery steps for an Administrator (documented).

## Left to the builder

Exact JSON field names beyond those given, dialog layout, where in the Focus Room home the section sits, the documented manual recovery text.

## Calls made without the owner (change if wrong)

30-minute permit after a partner code, 60 minutes after a wait, default wait 24 hours (1 hour to 7 days), service Stop also gated, upgrades exempt, no off switch.
