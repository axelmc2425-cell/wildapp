# Focus locks, sub-project 4a: Locked blocks, partner setup, early unlock

Date: 2026-11-09. Status: draft, awaiting owner review.

Builds on `2026-11-08-focus-room-design.md` (engine, helper, partner unlock) and
`2026-11-09-focus-room-ui-design.md` (the Focus Room screens). Read those first.

## Purpose

Let the owner start a Locked block that they cannot cancel alone, and give them
two ways out early: a signed code from the accountability partner, or a waiting
period fixed when the lock was started. This is 4a. Frozen mode (the whole PC
locked down) is 4b, with its own spec, and reuses these screens and the same
unlock paths.

## Owner decisions

- Locked and Frozen are both wanted; Frozen follows as 4b.
- Early exit is either the partner's signed code (instant) or a waiting period. The owner picks the waiting period when starting the lock (default 24 hours); it cannot be shortened afterwards.
- Partner key held by the partner; challenge-response tokens (design option C); "Hard" tamper resistance.

## Scope

In: Locked sessions (one-off, not schedules), partner key setup, the unlock dialog (partner code and waiting period), the helper's delayed-unlock request, database and sync changes, screens, tests, checklist.

Out: Frozen mode and its overlay (4b), locked schedules (sub-project 3 builds the schedule UI; it will reuse the lock choice), allow-lists, breaks, stats (5).

## Success criteria

- The owner can start a Locked block of 1 minute to 7 days, and has no way to cancel it from the app.
- A valid partner token ends it at once; a started waiting period ends it when the wait passes; a cancelled wait leaves the lock untouched.
- Editing or deleting data in the app database cannot weaken a lock already accepted by the helper.
- The UI never claims a block is locked unless the helper accepted it, and never claims an unlock worked unless the helper confirmed it.
- Plain-JavaScript and Rust logic is covered by tests; the real-helper end-to-end test runs on Linux; Windows-only behaviour is on the manual checklist.

## Helper changes (Rust)

- `Window` gains optional `unlock_delay_ms` (only meaningful for `locked`). Validation: for a locked window it is required, at least 1 hour and at most 7 days (hard minimum enforced by the helper, because the app is not trusted). Other locks must not carry it (`bad-window`).
- New requests: `RequestDelayedUnlock { window_id }` and `CancelDelayedUnlock { window_id }`.
  - Request: the window must exist and be `locked`. The helper stores `unlock_at = effective_now + unlock_delay_ms`, persisted in its state. A second request for the same window is a no-op that returns the existing time. Errors: `no-such-lock`, `not-delayable` (not a locked window).
  - Cancel: removes the pending request. Error `no-pending-unlock`.
  - When effective time reaches `unlock_at` (or the window's end, whichever is first) the window is removed and a tombstone with its original end is kept, exactly like a partner-token unlock. A later push of the same id with the same or an earlier end is skipped.
- A partner token submitted while a request is pending still works at once and clears the request.
- `Status` reports, per window, `unlock_at` when pending. The helper's own state version is bumped (missing field defaults to none).
- The wait uses the helper's effective clock (`max(wall, high_water + monotonic)`), so moving the system clock back does not shorten it; moving it forward can, which is the existing documented limit.
- Push semantics for an existing locked id: the helper keeps its stored sites, apps and delay; a push may only extend `ends` (existing rule). A push that changes items of an accepted locked window is applied as "same window, items ignored", so the helper's copy wins.
- Test-only: a cargo feature `test-clock` adds an `AdvanceClock { ms }` request so end-to-end tests can pass a delay without waiting. It is not compiled into the release binary or the installer.

## App changes (JavaScript)

- Schema v2: `focus_sessions` gains `unlock_delay_ms INTEGER` (null for normal). Migration runs once and leaves existing rows alone; `focus_meta.schema_version` becomes 2.
- `limits.js`: delay bounds (1 hour to 7 days), locked duration cap already 7 days; the Start dialog's custom field uses the lock's cap.
- `store.js`: sessions can be created with `lock: 'locked'` and a delay; reading returns them. Deleting or ending a locked session through the normal cancel path is refused; only the unlock paths (below) remove it.
- `sync.js` / `expand.js`: all sessions of one locked block (same `starts`, `ends`, `lock`) become ONE window with a stable id derived from `starts`, `ends` and the sorted list ids, whose sites and apps are the union of the lists. This way the partner signs one challenge per block, not one per list. Normal blocks stay one window per list.
- `controller.js` gains `startLockedBlock`, `requestPartnerChallenge`, `submitPartnerToken`, `startDelayedUnlock`, `cancelDelayedUnlock`, `setPartner`. All run through the existing serialized queue. After any status poll the controller reconciles: a locked session whose window is no longer held by the helper before its end is treated as unlocked and its rows are deleted.
- A list that belongs to a running locked block cannot be edited or deleted (disabled with the reason), in addition to the helper's own copy being authoritative.
- A locked start requires the helper to be reachable and to accept the push. If the push fails the rows are deleted again and the dialog says nothing was locked.

## Screens

- **Start a block:** Normal and Locked are both selectable.
  - Locked: duration up to 7 days, waiting period (1 hour, 6 hours, 24 hours default, custom hours up to 168), and a confirmation checkbox beside this text: "You can't cancel this. Only your partner's code, or the waiting period, ends it early."
  - With no partner key set, the Locked option shows "Set up your partner first" and opens the partner setup.
  - The helper must be running; otherwise Locked is disabled with the reason.
- **Partner setup (dialog from the Locked option and from Helper details):** step 1 a button downloads the offline partner page; step 2 the partner creates a key there and sends the public key; step 3 the owner pastes it, enters the partner's name and saves (`SetPartner`, then name stored in `focus_partner`). The helper's refusals (`lock-active`, `bad-key`) are shown in plain words.
- **Locked block card:** lock label, "Locked until <time>", progress and countdown as before, no Cancel button. Extend (only longer, never past 7 days) and **Unlock early** remain. While a wait is pending the card says "Unlocks at <time> unless you cancel".
- **Unlock early dialog:**
  - Ask my partner: "Get a code" (`RequestChallenge`), copy button, a field for the token, Submit (`SubmitToken`). Errors say which of wrong key, expired, already used or wrong block it was.
  - Wait it out: a button starts the wait (`RequestDelayedUnlock`) and shows the unlock time; while pending, a Cancel request button (`CancelDelayedUnlock`).
- Helper details lists locked windows' pending unlock times.

## Errors

The rule stays: data saved first, and the UI never pretends something worked.

- Locked start with the helper down or rejecting: nothing is locked, rows removed, clear message.
- Partner token failures: the lock stays; the message names the reason.
- Unlock or wait request while the helper is unreachable: "Not sent. The lock is unchanged."
- Partner key change refused during a lock: shown as the helper words it.
- `frozen-unavailable` remains until 4b.

## Testing

- Rust unit tests: delay validation, request, cancel, expiry with tombstone, persistence across a restart, clock moved back, token during a wait, items-change push ignored, `unlock_delay_ms` on a non-locked window rejected.
- JS tests: schema migration v1 to v2, store, the block-to-window merge, controller flows with a fake client (start, helper rejects, token errors, wait, cancel wait, reconcile), model text.
- End-to-end with the real helper (skips without the binary; the helper is built with `test-clock` for these tests): start a lock, confirm cancel is impossible, unlock with a real signed token, unlock via wait using `AdvanceClock`, cancel a wait.
- Screenshots in light and dark for: Start dialog with Locked, partner setup, locked card, unlock dialog (both options), pending-wait card, error states.
- Windows checklist additions: a locked block survives closing the app and a reboot; uninstalling the service is refused during a lock; a wait unlocks on time; clock-back does not shorten a wait; partner token unlock; partner key change refused during a lock.

## Decisions and limits

- Locked schedules arrive with sub-project 3.
- One partner key at a time; changing it needs no active or pending lock (helper rule).
- The waiting period is a convenience exit, not a second secret: anyone who can run the app can start it. That is by design (the owner asked for a way out when the partner is unreachable).
- Moving the system clock forward while the helper runs can still end locks and waits early (existing documented limit).

## Open items

None.
