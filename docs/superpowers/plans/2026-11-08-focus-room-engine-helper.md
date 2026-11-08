# Focus Room: Engine + Enforcement Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Focus Room's pure-JS blocker engine, the partner unlock tokens, and the elevated Windows helper that enforces website and app blocks with partner-only early unlock.

**Architecture:** The app expands sessions and schedules into concrete time windows and pushes them to a Rust Windows service. The service keeps its own protected copy, compares windows to a never-backwards clock, edits the hosts file, kills blocked processes, and ends a lock early only for a valid partner-signed token. The JS engine and the Rust helper share JSON test vectors so both sides agree on decisions and tokens.

**Tech Stack:** Vanilla JS ES modules, `node --test`, Web Crypto (ECDSA P-256); Rust (`serde`, `p256`, `base64`, `sysinfo`, `windows-service`, `tokio`); GitHub Actions (ubuntu + windows).

**Spec:** `docs/superpowers/specs/2026-11-08-focus-room-design.md` (read the "Window model and first-build limits" section first).

**Prerequisite:** MyBrain plan Tasks 1-2 (scaffold, CI, `Db` interface, `migrate`) are done. `Db` is `{ all(sql, params?), run(sql, params?), batch(stmts) }` as defined there.

## Global Constraints

- Windows desktop only; offline only: no network calls anywhere in this plan.
- No framework and no front-end build step. The only generated artifact is `partner-unlock.html` (Task 6), built by a dev script and committed.
- Module tables are prefixed `focus_`; modules never import each other.
- Signatures: ECDSA P-256, SHA-256, raw `r||s` (64 bytes); public key is raw uncompressed SEC1 (65 bytes), both base64url without padding.
- Max durations: `locked` 7 days, `frozen` 24 hours. Default token expiry 10 minutes. Challenge valid 1 hour. No indefinite locks: every window has an end time.
- Hosts entries point at `0.0.0.0`. Process check about once a second.
- Pure logic has Node tests (Node 22+) or Rust unit tests that run on Linux CI. Only service install, ACLs, registry, DNS flush and pipe behaviour need a real Windows machine (Task 14 checklist).

## Review Focus

1. Frozen mode and app blocking never kill Windows-critical processes, the helper, MyBrain or WebView2; a frozen window with an empty allow list leaves the PC usable. (Tasks 5, 11)
2. A rolled-back system clock does not end or extend a lock while the helper runs or after a restart. (Task 8)
3. Overlapping windows: block beats allow; when a `none` and a `locked` window overlap, cancelling the `none` one does not release the `locked` one. (Tasks 5, 8)
4. A 22:00-02:00 schedule crosses midnight; a 02:30 start on a spring-forward day still yields one window. (Task 4)
5. The hosts file keeps the user's own entries (CRLF, comments, no trailing newline, missing file) and loses only the managed block when nothing is active, including after a crash mid-write. (Tasks 7, 10)

---

### Task 1: Focus module schema

**Files:**
- Create: `src/modules/focus/schema.js`, `tests/focus-schema.test.js`

**Interfaces:**
- Consumes: `Db` (MyBrain Task 2).
- Produces: `migrateFocus(db: Db) => Promise<void>`, idempotent, tracked by a `focus_meta(key, value)` row `schema_version`. Creates `focus_lists(id INTEGER PK, name, mode CHECK IN ('block','allow'))`, `focus_items(list_id, kind CHECK IN ('site','app'), value)`, `focus_sessions(id INTEGER PK, list_id, starts, ends, lock CHECK IN ('none','locked','frozen'))`, `focus_schedules(id INTEGER PK, list_id, weekdays /* JSON [0-6], Sunday=0 */, start_time /* 'HH:MM' */, end_time, lock)`, `focus_usage(day, kind, value, seconds)`, `focus_partner(public_key, name)`.

- [ ] **Step 1: Write failing tests** `migrateFocus creates all six tables`, `migrateFocus is idempotent when run twice`, `inserting a list with mode 'nope' is rejected`, `inserting a session with lock 'weird' is rejected`.
- [ ] **Step 2: Run** `node --test tests/focus-schema.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement `migrateFocus`** with `CREATE TABLE IF NOT EXISTS`; add `migrateFocus` to the shell's module-registration call.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(focus): schema`.

### Task 2: Site and app matching

**Files:**
- Create: `src/modules/focus/match.js`, `tests/focus-match.test.js`

**Interfaces:**
- Produces:
  - `normalizeDomain(input: string) => string | null` — lowercase; strips scheme, path, query, port, leading `www.`, trailing dot; `null` when there is no dot, there are spaces, or it is an IP address.
  - `hostMatches(host: string, domain: string) => boolean` — equal, or `host` ends with `"." + domain`.
  - `normalizeApp(name: string) => string` — lowercase basename, `.exe` appended when missing.
  - `appMatches(processName: string, entry: string) => boolean` — `normalizeApp` equality.

- [ ] **Step 1: Write failing tests**: `normalizeDomain("https://WWW.Reddit.com/r/x?y=1") === "reddit.com"`; `normalizeDomain("localhost") === null`; `normalizeDomain("a b.com") === null`; `normalizeDomain("10.0.0.1") === null`; `hostMatches("old.reddit.com","reddit.com") === true`; `hostMatches("notreddit.com","reddit.com") === false`; `normalizeApp("C:\\Games\\Steam.EXE") === "steam.exe"`; `normalizeApp("chrome") === "chrome.exe"`; `appMatches("Chrome.exe","chrome") === true`.
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement. Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(focus): domain and app matching`.

### Task 3: Window model, limits and extension

**Files:**
- Create: `src/modules/focus/limits.js`, `tests/focus-limits.test.js`

**Interfaces:**
- Produces:
  - `Window = { id: string, starts: number, ends: number, lock: 'none'|'locked'|'frozen', mode: 'block'|'allow', sites: string[], apps: string[] }` (times are epoch ms; `id` is unique per window).
  - `MAX_DURATION_MS = { locked: 604800000, frozen: 86400000 }`
  - `validateWindow(w: Window) => { ok: true } | { ok: false, reason: 'bad-times'|'bad-lock'|'too-long' }` — `ends > starts` and finite; `lock` known; duration within `MAX_DURATION_MS[lock]` (`none` has no cap).
  - `extendWindow(w: Window, newEnds: number) => Window` — throws `Error("cannot shorten")` when `newEnds <= w.ends`, `Error("exceeds maximum duration")` when beyond the cap measured from `w.starts`.

- [ ] **Step 1: Write failing tests**: locked 7 days exactly is ok, 7 days + 1 ms is `too-long`; frozen 24 h ok, 24 h + 1 ms `too-long`; `ends === starts` is `bad-times`; `NaN` ends is `bad-times`; `extendWindow` to a later end returns a new object and leaves the input unchanged; to the same or an earlier end throws "cannot shorten"; past the cap throws "exceeds maximum duration".
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement. Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(focus): window validation and extension`.

### Task 4: Sessions and schedules to windows

**Files:**
- Create: `src/modules/focus/expand.js`, `tests/focus-expand.test.js`

**Interfaces:**
- Consumes: `Window` (Task 3), `normalizeDomain`, `normalizeApp` (Task 2).
- Produces:
  - `List = { id: number, mode: 'block'|'allow', items: { kind: 'site'|'app', value: string }[] }`
  - `sessionToWindow(session: { id: number, starts: number, ends: number, lock: string }, list: List) => Window` — id `"s" + session.id`; sites and apps normalized and de-duplicated.
  - `expandSchedule(schedule: { id: number, weekdays: number[], start_time: string, end_time: string, lock: string }, list: List, fromMs: number, horizonMs: number, tzOffsetAt: (utcMs: number) => number) => Window[]` — `tzOffsetAt` returns minutes east of UTC. Weekday is the local day the occurrence starts (Sunday = 0). `end_time <= start_time` means the occurrence ends the next day. Includes occurrences that overlap `[fromMs, fromMs + horizonMs)`, including one already running. Id `"c" + schedule.id + "@" + startsMs`. A local time inside a spring-forward gap resolves to the instant after the gap; an ambiguous fall-back time resolves to its first occurrence.

- [ ] **Step 1: Write failing tests** (use a `tzOffsetAt` built from `Intl.DateTimeFormat` for `America/New_York`): weekday 1-5 09:00-17:00 over one week yields 5 windows; 22:00-02:00 on Friday yields one window of 4 hours ending Saturday 02:00; an occurrence in progress at `fromMs` is included; on 2026-03-08 a 02:30-03:30 schedule yields exactly one window; on 2026-11-01 a 01:30-02:30 schedule yields one window; `sessionToWindow` normalizes `"https://www.X.com/a"` to `"x.com"` and de-duplicates.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** both. For each local date in range convert local wall time to UTC with `utc = localMs - tzOffsetAt(guess) * 60000` where `guess = localMs - tzOffsetAt(localMs) * 60000`.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(focus): expand sessions and schedules into windows`.

### Task 5: decide and block queries

**Files:**
- Create: `src/modules/focus/decide.js`, `tests/focus-decide.test.js`, `tests/fixtures/decide-vectors.json`, `scripts/gen-decide-vectors.js`

**Interfaces:**
- Consumes: `Window`, `hostMatches`, `appMatches`.
- Produces:
  - `CRITICAL_APPS: string[]` — `system, system idle process, registry, smss.exe, csrss.exe, wininit.exe, winlogon.exe, services.exe, lsass.exe, svchost.exe, dwm.exe, explorer.exe, fontdrvhost.exe, sihost.exe, taskhostw.exe, ctfmon.exe, conhost.exe, runtimebroker.exe, searchhost.exe, startmenuexperiencehost.exe, shellexperiencehost.exe, audiodg.exe, spoolsv.exe, msedgewebview2.exe, mybrain.exe, focus-helper.exe`
  - `Decision = { blockSites: string[], blockApps: string[], allow: { sites: string[], apps: string[] } | null, frozen: boolean, locks: { id: string, lock: string, ends: number }[] }` — arrays sorted and unique.
  - `decide(windows: Window[], nowMs: number) => Decision` — a window is active when `starts <= now < ends`. `blockSites/blockApps` are the union of active `block` windows. `allow` is the union of active `allow` windows' items, or `null` when there are none. `frozen` is true when any active window is `frozen`. `locks` lists active windows with `lock != 'none'`.
  - `isBlockedSite(d: Decision, host: string) => boolean` — blocked when it matches `blockSites`, or `allow` is non-null and the host matches nothing in `allow.sites`.
  - `isBlockedApp(d: Decision, processName: string) => boolean` — never true for `CRITICAL_APPS`; otherwise blocked when it matches `blockApps`, or `allow` is non-null and it is not in `allow.apps`, or `d.frozen` and it is not in `allow.apps` (an empty allow set when `allow` is null).
- Vectors: `scripts/gen-decide-vectors.js` writes `tests/fixtures/decide-vectors.json`, an array of `{ name, windows, now, decision, probes: [{ kind: 'site'|'app', value, blocked }] }`. Rust (Task 7) must produce identical output.

- [ ] **Step 1: Write failing tests**: no windows gives all-empty decision with `allow: null`; window active at `starts` and inactive at `ends`; block and allow windows overlapping — a site in both is blocked (block wins); allow windows union their items; a frozen window with no allow list gives `isBlockedApp(d,"notepad.exe") === true` and `isBlockedApp(d,"explorer.exe") === false` and `isBlockedApp(d,"MyBrain.exe") === false`; `isBlockedSite(d,"old.reddit.com")` true for blocked `reddit.com`; every `CRITICAL_APPS` entry is unblocked under a frozen window and under an allow-list that omits it; the vectors file matches what `decide` produces.
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement** and write the generator with at least 10 vectors covering the cases above. **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(focus): decide and block queries with shared vectors`.

### Task 6: Partner unlock tokens and partner page

**Files:**
- Create: `src/modules/focus/unlock.js`, `scripts/gen-unlock-vectors.js`, `scripts/build-partner-page.js`, `src/modules/focus/partner-unlock.html` (generated, committed), `tests/focus-unlock.test.js`, `tests/fixtures/unlock-vectors.json`

**Interfaces:**
- Produces (all constants and functions exported from `unlock.js`):
  - `DEFAULT_TOKEN_TTL_MS = 600000`, `CHALLENGE_TTL_MS = 3600000`
  - `generatePartnerKeys() => Promise<{ publicKey: string, privateKeyJwk: object }>` — `publicKey` is base64url raw SEC1.
  - `createChallenge(windowId: string, nowMs: number) => { code: string, nonce: string, windowId: string, issued: number, used: false }` — `nonce` is 16 random bytes base64url; `code` is base64url of JSON `{"n":nonce,"w":windowId}`.
  - `signUnlock(privateKeyJwk: object, challengeCode: string, nowMs: number, ttlMs?: number) => Promise<string>` — token is `base64url(JSON {"n","w","exp"}) + "." + base64url(signature over the payload bytes)`.
  - `verifyUnlock(publicKey: string, token: string, challenge: { nonce: string, windowId: string, issued: number, used: boolean }, nowMs: number) => Promise<{ ok: true } | { ok: false, reason: 'bad-format'|'bad-signature'|'wrong-challenge'|'wrong-lock'|'used'|'challenge-expired'|'expired' }>` — checked in that order.
- `scripts/gen-unlock-vectors.js` writes a fixed-key fixture: public key, one valid case and one case per failure reason, each `{ name, publicKey, token, challenge, now, expect }`. Rust (Task 8) must agree.
- `scripts/build-partner-page.js` inlines `generatePartnerKeys` and `signUnlock` into one self-contained page: step 1 creates a key, shows the public key to send to the owner and offers a "Download my key file" button; step 2 loads the key file, takes a pasted challenge code and shows the token. No network references.

- [ ] **Step 1: Write failing tests**: round trip `signUnlock` then `verifyUnlock` is `ok`; a token signed by a second key is `bad-signature`; payload edited after signing is `bad-signature`; `"garbage"` is `bad-format`; a token for another challenge is `wrong-challenge`; another window id is `wrong-lock`; `used: true` is `used`; a challenge issued over an hour ago is `challenge-expired`; a token past its `exp` is `expired`; `createChallenge` twice gives different nonces; the committed `partner-unlock.html` equals what the build script produces and contains no `http://`, `https://` or `fetch(`; the vectors fixture matches the generator when re-run with its fixed key.
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement** with `crypto.subtle` (`ECDSA`, `P-256`, `SHA-256`). **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(focus): partner unlock tokens and offline partner page`.

### Task 7: Rust helper crate, decide, hosts and process rules

**Files:**
- Create: `focus-helper/Cargo.toml`, `focus-helper/src/lib.rs`, `focus-helper/src/model.rs`, `focus-helper/src/decide.rs`, `focus-helper/src/hosts.rs`, `focus-helper/tests/vectors.rs`

**Interfaces:**
- Consumes: `tests/fixtures/decide-vectors.json` (Task 5).
- Produces:
  - `model::{Window, Decision}` (`serde`, field names identical to the JS shapes, camelCase for `Decision`).
  - `decide::decide(windows: &[Window], now_ms: i64) -> Decision`, `decide::is_blocked_app(d: &Decision, name: &str) -> bool`, `decide::CRITICAL_APPS: &[&str]` (same list as Task 5).
  - `hosts::render(existing: &str, sites: &[String]) -> String` — removes any existing block between `# BEGIN MYBRAIN-FOCUS` and `# END MYBRAIN-FOCUS`, then, when `sites` is non-empty, appends a block with `0.0.0.0 d`, `0.0.0.0 www.d`, `0.0.0.0 m.d` per domain. Keeps every other line byte-for-byte and keeps the file's line ending (CRLF or LF); idempotent.

- [ ] **Step 1: Write failing tests**: `vectors.rs` loads the JSON and asserts `decide` equals each `decision` and each probe (`isBlockedApp` only; site probes use `hosts` matching by suffix helper `decide::host_matches`); `hosts::render` on empty input, on CRLF input, on input with no trailing newline, with user entries and comments preserved, twice in a row (idempotent), and with an empty `sites` removing the block.
- [ ] **Step 2: Run** `cargo test --manifest-path focus-helper/Cargo.toml`. Expected: FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(helper): decide, hosts rendering and shared vectors`.

### Task 8: Lock store, token verification and clock

**Files:**
- Create: `focus-helper/src/lockstore.rs`, `focus-helper/src/unlock.rs`, `focus-helper/src/clock.rs`, `focus-helper/tests/unlock_vectors.rs`

**Interfaces:**
- Consumes: `model::Window`, `tests/fixtures/unlock-vectors.json` (Task 6).
- Produces:
  - `unlock::verify(public_key_b64: &str, token: &str, challenge: &Challenge, now_ms: i64) -> Result<(), UnlockError>` where `UnlockError` has the same seven reasons as the JS (`BadFormat, BadSignature, WrongChallenge, WrongLock, Used, ChallengeExpired, Expired`), using `p256` and `base64` (URL-safe, no pad). `Challenge { nonce: String, window_id: String, issued: i64, used: bool }`.
  - `clock::EffectiveClock { high_water_ms: i64, .. }` with `new(persisted_high_water_ms: i64) -> Self` and `now(&mut self, wall_ms: i64, mono_ms: i64) -> i64` = `max(wall_ms, high_water + (mono_ms - mono_at_high_water))`; updates the high-water mark; never decreases.
  - `lockstore::LockStore { windows, partner_key: Option<String>, challenges, high_water_ms }` (`serde`) with:
    - `push(&mut self, incoming: Vec<Window>, now_ms: i64) -> Result<PushReport, PushError>` — a window with `lock != none` is rejected (`NoPartner`) when no partner key is set; invalid windows rejected with the Task 3 reasons; existing active `locked`/`frozen` windows are retained and, when the incoming copy has the same id, only `ends` may grow (within the cap); other fields of an existing locked window are ignored; `none` windows are replaced by the incoming set; finished windows are dropped.
    - `set_partner(&mut self, public_key_b64: &str) -> Result<(), PartnerError>` — rejected (`LockActive`) while any `locked`/`frozen` window is active.
    - `request_challenge(&mut self, window_id: &str, now_ms: i64, nonce: [u8; 16]) -> Result<String, ChallengeError>` — only for an existing active locked/frozen window; returns the code (same format as JS).
    - `submit_token(&mut self, token: &str, now_ms: i64) -> Result<String, UnlockError>` — finds the matching open challenge, verifies, marks it used and sets that window's `ends` to `now_ms`; returns the window id.

- [ ] **Step 1: Write failing tests**: `unlock_vectors.rs` runs every vector and expects the same `expect` as JS; clock: wall clock set back 1 hour leaves `now` unchanged; wall clock forward advances; a fresh `EffectiveClock::new(hw)` never returns below `hw`; lock store: `locked` push without partner is rejected; cancelling by pushing an empty set leaves an active `locked` window in place; pushing the same id with a later `ends` extends, with an earlier `ends` keeps the old end; `none` window replaced and removed by an empty push; `set_partner` rejected while a lock is active and allowed otherwise; a valid token ends only its own window; the same token twice gives `Used`; overlapping `none` and `locked` windows — removing the `none` one leaves the lock.
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement. Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(helper): lock store, token verification and monotonic clock`.

### Task 9: IPC handler and persistence

**Files:**
- Create: `focus-helper/src/ipc.rs`, `focus-helper/src/persist.rs`, `focus-helper/tests/ipc.rs`, `focus-helper/tests/persist.rs`

**Interfaces:**
- Consumes: `LockStore`, `decide` (Tasks 7-8).
- Produces:
  - `ipc::Request` (`serde`, `{"type": ...}` tagged): `PushWindows{windows}`, `GetStatus`, `RequestChallenge{window_id}`, `SubmitToken{token}`, `SetPartner{public_key}`.
  - `ipc::Response`: `Ok`, `Status{decision, windows, partner_set, now_ms}`, `Challenge{code}`, `Error{code, message}` with stable `code` strings (`no-partner`, `lock-active`, `bad-window`, one per `UnlockError`).
  - `ipc::handle(store: &mut LockStore, clock: &mut EffectiveClock, req: Request, wall_ms: i64, mono_ms: i64, nonce: [u8; 16]) -> Response`.
  - `persist::save(path: &Path, store: &LockStore) -> io::Result<()>` — writes `path.tmp`, fsyncs, renames over `path`, after copying the previous file to `path.bak`; `persist::load(path: &Path) -> LockStore` — main file, else `.bak`, else default; never deletes a file it cannot parse.

- [ ] **Step 1: Write failing tests**: each request/response pair via `handle` including `Error` codes; JSON round trip of every `Request`; `save` then `load` returns an equal store; a truncated main file loads from `.bak`; both corrupt loads default and leaves the corrupt files in place; a crash simulated between tmp write and rename leaves the old state loadable.
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement. Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(helper): ipc handler and atomic persistence`.

### Task 10: Hosts file writer and browser DNS policy

**Files:**
- Create: `focus-helper/src/hosts_io.rs`, `focus-helper/src/win/mod.rs`, `focus-helper/src/win/dns.rs`, `focus-helper/tests/hosts_io.rs`

**Interfaces:**
- Consumes: `hosts::render` (Task 7).
- Produces:
  - `hosts_io::apply(path: &Path, sites: &[String]) -> io::Result<bool>` — reads (missing file = empty), renders, writes `path.focus-tmp`, fsyncs and renames over `path`; returns whether the content changed; no write when unchanged. Cross-platform.
  - `win::dns::lock_hosts() -> io::Result<()>` (denies write to `Users` via `icacls`, `cfg(windows)`), `unlock_hosts()`, `flush_dns()` (runs `ipconfig /flushdns`), `set_doh_off()` writing `DnsOverHttpsMode="off"` under `HKLM\SOFTWARE\Policies\Google\Chrome` and `...\Microsoft\Edge`, and `DNSOverHTTPS` `Enabled=0, Locked=1` under `HKLM\SOFTWARE\Policies\Mozilla\Firefox`; `clear_doh_off()` removes only the values this helper wrote.

- [ ] **Step 1: Write failing tests** against a temp file: creates a missing file; keeps user entries, CRLF and comments; second `apply` with the same sites returns `false`; `apply(path, &[])` removes only the managed block; a leftover `path.focus-tmp` from a crash is overwritten, not read as hosts content; the temp file is gone after success.
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement** `hosts_io` (portable) and the `cfg(windows)` functions. **Step 4: Run, verify PASS** (the Windows-only functions are exercised by the Task 14 checklist).
- [ ] **Step 5: Commit** `feat(helper): atomic hosts writer and browser DoH policy`.

### Task 11: Process enforcement

**Files:**
- Create: `focus-helper/src/enforce.rs`, `focus-helper/src/win/procs.rs`, `focus-helper/tests/enforce.rs`

**Interfaces:**
- Consumes: `Decision`, `is_blocked_app`.
- Produces:
  - `enforce::Proc { pid: u32, name: String }`, trait `ProcessTable { fn list(&self) -> Vec<Proc>; fn kill(&self, pid: u32) -> bool; }`.
  - `enforce::VPN_APPS: &[&str]` — `openvpn.exe, nordvpn.exe, expressvpn.exe, protonvpn.exe, windscribe.exe, mullvad-vpn.exe, surfshark.exe, tor.exe, psiphon3.exe, cloudflare-warp.exe`.
  - `enforce::enforce_once(d: &Decision, table: &dyn ProcessTable, self_pid: u32) -> Vec<Proc>` — kills (and returns) every listed process that `is_blocked_app` says is blocked, plus any `VPN_APPS` process when the decision has any active block window; never kills `self_pid` or any `CRITICAL_APPS` entry.
  - `win::procs::SysinfoTable` implementing `ProcessTable` with `sysinfo` and `TerminateProcess` (`cfg(windows)`).

- [ ] **Step 1: Write failing tests** with a fake `ProcessTable`: a blocked app is killed and a neighbour is not; match is case-insensitive; frozen with an empty allow set kills `notepad.exe` and `chrome.exe` and spares every `CRITICAL_APPS` entry and `self_pid`; frozen with allow `{"code.exe"}` spares `code.exe`; a VPN app is killed only while some block window is active; an empty decision kills nothing; a failed `kill` is not reported as killed.
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement. Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(helper): process enforcement with never-kill list`.

### Task 12: Service, pipe, watchdog and installer

**Files:**
- Create: `focus-helper/src/main.rs`, `focus-helper/src/win/service.rs`, `focus-helper/src/win/pipe.rs`, `focus-helper/src/win/install.rs`
- Modify: `src-tauri/tauri.conf.json` (bundle `focus-helper.exe` and add an NSIS installer hook that runs `focus-helper.exe install` on install and `focus-helper.exe uninstall` on uninstall)

**Interfaces:**
- Consumes: everything above.
- Produces: CLI `focus-helper install|uninstall|service|watchdog|stdio --state <path>`; services `MyBrainFocus` and `MyBrainFocusWatchdog` (auto-start, restart on failure, each starts the other if it is found stopped, checked every 5 s); named pipe `\\.\pipe\mybrain-focus` speaking one JSON `Request` per line and one `Response` per line; state at `%ProgramData%\MyBrainFocus\state.json`.
- Main loop (every 1 s): effective now, `decide`, `enforce_once`; on a change of `blockSites`, `hosts_io::apply`, `flush_dns`, `lock_hosts`, `set_doh_off`; when no windows are active, remove the managed block and `clear_doh_off`. Persist after every request and every 30 s (high-water mark).
- `install` sets a restrictive service security descriptor (`sc sdset`: SYSTEM full control, Administrators query only). `uninstall` refuses while any `locked`/`frozen` window is active. `stdio` mode serves the same `ipc::handle` over stdin/stdout lines, for tests on any OS.

- [ ] **Step 1: Write failing test** `focus-helper/tests/stdio.rs`: spawn `focus-helper stdio --state <tmp>`, send `SetPartner` then `PushWindows` with a locked window then `GetStatus`; expect `partner_set: true` and the window listed; send `PushWindows` with an empty list and expect the locked window still listed.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement `main.rs` and the `stdio` mode first**, then the `cfg(windows)` service, pipe, watchdog and install code (`windows-service` crate; `tokio` named pipe).
- [ ] **Step 4: Run** `cargo test --manifest-path focus-helper/Cargo.toml`. Expected: PASS on Linux; `cargo build --release --target x86_64-pc-windows-msvc` is exercised by CI (Task 14).
- [ ] **Step 5: Commit** `feat(helper): service, pipe, watchdog and installer hook`.

### Task 13: App-side client and window sync

**Files:**
- Create: `src/modules/focus/helper-client.js`, `src/modules/focus/sync.js`, `src-tauri/src/focus.rs`, `tests/focus-client.test.js`, `tests/focus-sync.test.js`, `tests/focus-stdio.test.js`
- Modify: `src-tauri/src/main.rs` (register the command)

**Interfaces:**
- Consumes: `expandSchedule`, `sessionToWindow` (Task 4), `Db`, the helper protocol (Task 9).
- Produces:
  - Rust command `focus_helper_call(request: String) -> Result<String, String>`: writes one line to the named pipe and returns the reply line (`cfg(windows)`; returns an error elsewhere).
  - `createHelperClient(call: (json: string) => Promise<string>) => { pushWindows(windows: Window[]), status(), requestChallenge(windowId: string), submitToken(token: string), setPartner(publicKey: string) }` — each returns the parsed `Response`; a `{type:"Error"}` response rejects with `Error(message)` carrying `code`.
  - `syncWindows(db: Db, client, nowMs: number, tzOffsetAt: (utcMs: number) => number) => Promise<{ pushed: number }>` — loads lists, items, sessions and schedules, builds windows for the next 30 days, drops finished ones, pushes.
- `tests/focus-stdio.test.js` skips when the helper binary is not built; otherwise it uses a `call` that talks to `focus-helper stdio` and replays a Task 9 conversation, proving the JS and Rust agree on the wire format.

- [ ] **Step 1: Write failing tests**: with a fake `call`, each client method sends the exact JSON request and parses the reply; an `Error` reply rejects with its `code`; `syncWindows` on a db with one list, one session and one weekly schedule pushes the expected window count and ids; finished sessions are not pushed; an empty db pushes an empty array.
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement.** **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(focus): helper client and window sync`.

### Task 14: CI and Windows checklist

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `docs/superpowers/focus-room-windows-checklist.md`

**Interfaces:**
- Produces: CI job `linux` runs `npm test`, regenerates the three fixtures and fails on a diff, runs `cargo test` and builds `focus-helper`; job `windows` runs `cargo test` and `cargo build --release` for `focus-helper`, builds the installer and uploads it as an artifact.

- [ ] **Step 1: Update `ci.yml`** as above.
- [ ] **Step 2: Write the checklist**, one checkable line each, with the expected result: service installed and set to auto-start; a blocked site fails to load in Chrome, Edge and Firefox; DoH is off in each browser's policy page; a blocked app closes within 2 s of launch; Frozen mode leaves Explorer, the taskbar and MyBrain working; a reboot during a lock restores it; stopping `MyBrainFocus` in Services is denied, and killing it from Task Manager is undone by the watchdog within 10 s; the system clock moved back 1 h does not end a lock; uninstall is refused during a lock; the partner-page challenge/token round trip unlocks exactly one window; with no active windows the hosts file has no managed block and DoH policies are gone.
- [ ] **Step 3: Push and confirm both CI jobs are green.**
- [ ] **Step 4: Commit** `ci: helper tests, windows build and checklist`.
