# Focus Room daily and weekly time limits (sub-project 6b)

Date: 2026-11-14. Status: approved by the owner's "build the rest"; the calls marked (call) are the controller's and can be changed.

Builds on `2026-11-08-focus-room-design.md` (helper, blocking), `2026-11-09-focus-locks-design.md` (locks, partner/waiting unlock) and `2026-11-13-focus-detailed-analytics-design.md` (usage tracking, which this reuses).

## Intent

The owner wants to cap how long they spend on distracting apps and sites: "no more than 1 hour a day on YouTube and games". When the cap is reached the items are blocked until the period ends. A limit can be locked so the owner cannot loosen it in a weak moment.

## Goals

- A **time limit** has: a name, a set of apps (program names) and sites (domains), a period (**daily** or **weekly**), a cap, and a lock choice (none or locked with a waiting period).
- All items of one limit share one pool of time (call): "1 hour on YouTube + Reddit" means 1 hour in total.
- Time is counted by the helper from the same usage it already records (programs by exe name; sites by the website label matched from browser titles, so site limits are approximate, as site statistics are).
- When the pool is used up the helper blocks every item of the limit until the period ends, with the same enforcement as a focus block (processes ended, sites blocked in the hosts file). Daily ends at local midnight. Weekly ends at the start of Monday (local).
- The Focus Room shows each limit with time used, time left and a bar; limits that are used up are marked blocked until a stated time.
- **Locked limits** cannot be weakened by the app alone. Weakening means: deleting the limit, raising the cap, removing items, changing the period or switching off the lock. Tightening (lower cap, more items) is always allowed. Weakening a locked limit needs the partner's signed code (instant) or the waiting period chosen when the limit was locked (default 24 hours), exactly like unlocking a Locked block.
- Unlocked limits are freely editable in the app.
- The enforcement keeps working when the app is closed and cannot be weakened by editing the app database.

## Non-goals

Notifications when a limit is nearly used (shown in the app only), per-item separate caps inside one limit, limits by app category, "extra time" requests, allow-list limits, mobile, a different cap per weekday, limits counting only within a schedule.

## Anti-goals

- A limit must never block anything before its pool is actually used up.
- Using a limit's time must not be possible to reset by changing the system clock backwards (use the helper's existing effective clock and the sampler's reported local day; a day string that goes backwards never lowers the used time of the current period).
- The app must never claim a limit is locked or removed unless the helper confirmed it.

## Constraints

- The helper is authoritative: limits live in the helper's state, are pushed by the app, and are validated by the helper (the app is untrusted), like windows.
- Existing protocol, windows, locks, partner unlock and usage keep working unchanged. Additions only; old state files without limits load as no limits.
- Windows enforcement is untestable in CI; portable decision logic is covered by tests with fake clocks and fake usage, Windows behaviour goes on the manual checklist.
- Vanilla JS ES modules, SQLite for the app copy, the same sync pattern as schedules.

## Approaches considered

1. **Helper-side limits (chosen).** The helper stores limits, computes used time from its usage store on every tick, and merges the exceeded limits into the decision it already enforces. Works with the app closed and cannot be altered through the app database.
2. **App-side limits** that push a plain block window when exceeded. Rejected: the app would have to be running to notice, and the database could be edited.
3. **Limits inside focus windows.** Rejected: windows have fixed times, limits depend on usage.

## Design

### Helper (Rust)

- **Model** (`limits.rs`, portable): `Limit { id, name, apps: Vec<String>, sites: Vec<String>, period: Daily|Weekly, cap_secs: u64, lock: None|Locked, unlock_delay_ms: Option<i64> }`. Validation in the helper: up to 64 limits, 1 to 100 items each, items validated like window items (`good_item`), cap from 60 seconds to 24 hours (daily) or 168 hours (weekly), locked limits need a delay from 1 hour to 7 days, unlocked ones must not have a delay, ids are bounded strings.
- **Storage:** a `limits` list in the lock store's state with a new field `limits` (default empty), a stored `unlock_at` for limits with a pending waiting period, and tombstones like windows for recently unlocked/removed locked limits so a stale app copy cannot re-add a weaker version.
- **Used time:** `used_secs(limit, usage, current_day) -> u64`: for Daily the seconds of that day; for Weekly the sum of days from the Monday of `current_day` to `current_day`. Apps match by lowercase exe name (normalised like `normalize_app`); sites match a usage site label whose lowercase equals the stem of one of the limit's domains or a canonical site name whose domain is in the limit (call: use the same matching as `match_site` with the limit's domains as extra stems, so the numbers equal what Stats shows). `current_day` is the day string of the latest accepted report; when a report has not arrived today, the period is whichever the last report said (no unblocking from silence).
- **Enforcement:** in `apply`, after `decide(windows, now)`, every limit with `used >= cap` adds its apps and sites to the decision's block lists (limit blocks are independent of windows and never relax an allow-list window). A decision field `limit_blocks: [{ id, until_day }]` is omitted when empty so existing vectors stay unchanged.
- **Protocol:** `PushLimits { limits }` (replaces the set; rules below), `GetLimits` answered by `Limits { limits, status: [{ id, used_secs, cap_secs, blocked, period_ends_day }], pending_unlocks }`. `Status` stays as is.
- **Push rules (the app is untrusted):** for an unlocked limit anything goes. For a locked limit already known to the helper, a push that deletes it or weakens it is ignored for that limit (the stored copy wins) and reported in the push reply (`kept_locked: [ids]`); tightening is applied. A new limit may be pushed locked.
- **Unlocking a locked limit:** reuse the unlock machinery: `RequestChallenge`/`SubmitToken` and `RequestDelayedUnlock`/`CancelDelayedUnlock` accept a limit id as well as a window id (builder decides the minimal change). A successful unlock removes the lock (the limit becomes unlocked and is then editable or deletable) and leaves a tombstone preventing an older locked copy from returning.
- **Periods and the clock:** the weekly boundary is Monday of the sampler's `current_day`. A report whose `day` is earlier than `current_day` is accepted for usage as today (existing behaviour) but never moves `current_day` backwards by more than the existing `MAX_DAY_SKEW` rule allows and never lowers used time.
- Limits are evaluated every tick (about once a second) from in-memory usage; no extra disk work.

### App (JavaScript)

- **Database:** v5 migration adds `focus_limits` (id, name, period, cap_secs, lock, unlock_delay_ms, enabled) and `focus_limit_lists` (limit id, list id) or direct apps/sites like schedules; follow the schedule tables' pattern and the existing list picker so a limit can pick saved lists, apps, folders-excluded and sites.
- **Pure logic** (`limit-logic.js`): validation mirroring the helper, formatting ("1h 20m left"), choosing the status text, and diffing weakening vs tightening (for confirming dialogs).
- **Sync:** the sync module pushes all enabled limits with `PushLimits` after any change and on start, handling `kept_locked` by reloading the helper's copy and telling the owner.
- **UI:** a "Time limits" section on the Focus Room home under Schedules: list with name, items summary, period and cap, used/left bar, blocked badge with the time it ends, lock badge; an editor dialog (name, period, cap with hours and minutes, items via the existing picker, lock choice with the waiting period, default 24 h); a weakening attempt on a locked limit opens the existing unlock dialog (partner code or wait) instead of saving. States: helper down (last known numbers with a notice), loading, empty.
- Stats page: no change.

## Errors

- Helper down: the limits list shows saved limits with "Enforcement is not running" and no numbers.
- `bad-limit` from the helper shows the reason beside the editor; nothing is saved to the database that the helper rejected (the helper is asked first for locked limits).
- A limit whose items all disappear is rejected (at least one item required).

## Testing

- Rust: validation bounds, used_secs for daily and weekly (Monday boundary, month and year boundaries, a missing day counts zero), exceeded-limit decision, independence from allow windows, push rules (tighten ok, weaken ignored with `kept_locked`, delete ignored, new locked ok), unlock by token and by waiting period for a limit id, tombstone, persistence and old-state load, protocol shapes and bounds, clock-back never lowers used time.
- JS: validation, status text, weaken/tighten diff, DB migration and CRUD, sync with `kept_locked`, home section states, editor dialog states, unlock flow.
- End to end with the real helper over stdio using the test-clock `AddUsage`: push a limit, add usage, `GetLimits` reports blocked and the decision lists its items; weekly rollover with `AdvanceClock`.
- Screenshots (light, dark, phone). Windows checklist: a real app is ended when its limit is used up; a site is blocked; a limit lifts at local midnight; weekly lifts Monday; locked limit cannot be deleted from the app; partner code and waiting period unlock it.

## Left to the builder

Exact JSON field names beyond those given, DB column layout, dialog layout, how `current_day` is stored, and the minimal change that lets the unlock requests address a limit id.

## Calls made without the owner (change if wrong)

Shared pool per limit; Monday-start weeks; no notifications; site limits approximate; 64 limits maximum; cap bounds above; default lock wait 24 hours.
