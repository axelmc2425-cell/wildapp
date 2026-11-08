# Focus Room: design

Date: 2026-11-08. Status: draft, awaiting owner review.

## Purpose

The Focus Room is a MyBrain module (see `2026-11-08-mybrain-design.md`) that
blocks distracting websites and apps on the owner's Windows PC, on a timer or
a weekly schedule, with locks that cannot be undone without an accountability
partner.

It is a clean-room implementation of the behaviour that tools like Cold Turkey
publicly describe. It uses no code, binaries or assets from any existing
product. The code is the owner's to extend.

## Success criteria

- Block lists for websites and apps, enforced at system level (not a browser extension).
- One-off timed sessions and recurring weekly schedules.
- Three lock levels: `none`, `locked`, `frozen`.
- A `locked` or `frozen` block cannot be ended early by the owner alone. It can be ended early only with a token signed by the accountability partner.
- Allow-lists ("block everything except"), break timers and local usage stats.
- The rules and the unlock-token check are plain JavaScript with Node tests that run on Linux.

## Out of scope

- Mac, Linux and mobile enforcement.
- Cloud accounts, sync or remote management.
- Defeating a determined admin on their own machine. See "What this does not stop".

## Delivery order

This feature is split into sub-projects. Each gets its own plan and build.

1. Blocker engine plus enforcement helper. **This spec covers the design for both.**
2. Focus Room UI: lists, timed sessions, status (core blocking).
3. Schedules.
4. Lock modes UI: locked sessions, Frozen mode, partner unlock flow.
5. Extras: allow-lists, breaks, usage stats.

All of it depends on the MyBrain shell existing first.

## Architecture

The module follows the MyBrain module rules: its own folder, its own tables,
no imports from other modules.

- **`focus/engine` (pure JS, Node-tested).** Holds the rules and state: block lists, sessions, schedules, lock records. Its main function is `decide(state, now)`, which returns the exact set of sites and apps to block right now. It also verifies partner unlock tokens with Web Crypto (ECDSA P-256). It never touches Windows.
- **`focus/helper` (Rust, Windows service, elevated).** Reads the engine's decision and enforces it. Keeps its own copy of the lock state, so closing the app or editing the database does not release a lock.
- **`focus/ui`.** The screens. Talks to the helper over a local named pipe.
- **`partner-unlock.html`.** One offline page the partner opens in a browser to create their key pair and to sign unlock challenges.

## Data model

All tables live in MyBrain's SQLite database and are prefixed `focus_`.

- `focus_lists(id, name, mode)`: `mode` is `block` or `allow`.
- `focus_items(list_id, kind, value)`: `kind` is `site` (a domain, subdomains included) or `app` (an executable name).
- `focus_sessions(id, list_id, starts, ends, lock)`: `lock` is `none`, `locked` or `frozen`.
- `focus_schedules(id, list_id, weekdays, start_time, end_time, lock)`.
- `focus_usage(day, kind, value, seconds)`.
- `focus_partner(public_key, name)`: set once.

Every session and every schedule occurrence has an end time. No lock is indefinite.
Maximum durations: `locked` 7 days, `frozen` 24 hours. Both are configurable.

## Lock levels

- **`none`:** the owner can cancel at any time.
- **`locked`:** cannot be cancelled before its end time, except with a partner token.
- **`frozen`:** the whole PC is locked. Only an explicit allowed set of processes runs, behind a full-screen always-on-top window. Ends early only with a partner token.

## Partner unlock (signed challenge-response)

1. At setup the partner opens `partner-unlock.html`, which generates an ECDSA P-256 key pair in their browser. The partner keeps the private key. The owner enters the public key once, and it is stored in `focus_partner` and in the helper.
2. To unlock early, the app shows a one-time challenge: a random nonce plus the lock id.
3. The owner sends the challenge to the partner. The partner signs it in the page, which produces a token with a short expiry (default 10 minutes).
4. The owner types the token into the app. The helper accepts it only if the signature matches the stored public key, the challenge matches an open one, the lock id matches, and the token has not expired.
5. A challenge can be used once. A used or expired challenge is discarded.

Nothing on the owner's PC can forge a token, because only the public key is stored there.

## Lock lifecycle

1. The owner starts a locked session. The app writes it to the database.
2. The app also hands a copy to the helper, which stores it in its own protected state.
3. The helper enforces it until the end time or until a valid partner token ends it early.
4. The helper uses its own copy of the lock state. If the two disagree, the helper's copy wins.

## Helper enforcement

- **Websites:** write block entries to the hosts file (`0.0.0.0`), flush the DNS cache, and lock the file so only the helper can write to it.
- **Apps:** check running processes about once a second and terminate any that is on the active block list.
- **Frozen mode:** terminate every process outside the allowed set. The helper is a service, so the lock resumes after a reboot.
- **Self-protection (hard mode):** automatic restart on failure, a restrictive service ACL, and a watchdog process that restarts the helper if it dies.
- **Browser DNS:** set browser policies that disable encrypted DNS (DoH), since it bypasses the hosts file.
- **VPNs and proxies:** block common VPN and proxy apps while a block is active, as friction.

## Window model and first-build limits

Added while planning. These refine the sections above.

- **Windows, not rules, go to the helper.** The app expands sessions and schedules into concrete time windows (`id, starts, ends, lock, mode, sites, apps`) for the next 30 days and pushes them to the helper. The helper only compares windows to the clock, so locks and schedules keep working while the app is closed. The app re-pushes on every start and daily. A locked or frozen window already pushed cannot be removed or shortened except by a partner token; it may be extended within the maximum duration. A locked schedule is therefore enforced up to 30 days ahead and then needs a re-push.
- **Locks need a partner.** The helper rejects `locked` and `frozen` windows until a partner public key is set, and rejects changing the partner key while any lock is active.
- **Subdomains.** The hosts file cannot wildcard. The helper blocks the domain itself plus `www.` and `m.` for each listed domain. Other subdomains must be listed explicitly. (The engine's matching still treats subdomains as matches.)
- **Site allow-lists.** Hosts-file blocking cannot do "block everything except". The engine supports allow-mode windows, and the helper enforces them for apps only in the first build. Site allow-lists need a DNS sinkhole or firewall layer and belong to sub-project 5.
- **Clock.** The helper keeps a persisted high-water mark and a monotonic clock, and never lets time move backwards. Moving the clock forward across a reboot is not detectable offline and can end a lock early.
- **Never-kill list.** Frozen and app blocking never terminate Windows-critical processes, the helper, or MyBrain (and its WebView2).
- **Helper wins.** The helper's stored windows win over the app's database if they disagree.

## What this does not stop

This is friction, not a guarantee. These all still work against it:

- Encrypted DNS configured in ways the policies do not cover.
- VPNs and proxies the block list does not know about.
- Setting the system clock forward across a reboot.
- Safe Mode, and a different admin account removing the service.
- Booting from another operating system.

Hard mode makes bypassing take deliberate effort. It does not stop a determined admin on their own machine.

## Error handling

- If the helper is unreachable, the UI shows a clear banner and does not pretend a block is active.
- If the partner token is invalid, expired or already used, the app says which, and the lock stays.
- If the helper itself is broken, the lock still ends at its end time, because no lock is indefinite.
- If the hosts file cannot be written, the helper retries and reports the failure to the UI.

## Testing

- Node tests for: `decide(state, now)` across sessions, schedules, overlaps and lock levels; allow-list versus block-list logic; domain matching (subdomains); end-time and maximum-duration enforcement; token verification (valid, wrong key, wrong challenge, wrong lock id, expired, reused).
- The helper's logic that can be pure (diffing desired vs. current hosts entries, process matching) is tested in Rust unit tests that run on Linux.
- The Windows behaviour of the helper (service install, hosts lock, process killing, Frozen mode, reboot persistence, watchdog) can only be checked on Windows. It is covered by a manual checklist in the plan, run by the owner against the CI-built installer.

## Open items

- The exact allowed-process set for Frozen mode.
- The list of VPN and proxy apps to block.

Decided: an active lock may be extended (made longer, within the maximum duration) but never shortened except by a partner token.
