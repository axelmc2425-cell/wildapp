# Focus Room UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Focus Room screens (block lists, timed Normal sessions, live status, helper health banner) as a MyBrain module that works with or without the helper running.

**Architecture:** Logic is kept apart from the screens: `store.js` (database), `model.js` (pure rules), `controller.js` (orchestration with an injected helper client and clock), thin DOM views in `ui/`. Every change is saved to the database first, then `syncWindows` pushes the full window set to the helper. Plain ES modules, no framework, no build step.

**Tech Stack:** Vanilla JS ES modules, `node --test`, `node:sqlite` via the existing Node db adapter, the sub-project 1 helper client and sync, Playwright (already used by `scripts/shot.mjs`) for screenshots.

**Spec:** `docs/superpowers/specs/2026-11-09-focus-room-ui-design.md` (also read `2026-11-08-focus-room-design.md`).

## Global Constraints

- Vanilla JS ES modules; no framework, no front-end build step, no new npm dependencies; offline only.
- Modules never import each other. Focus code lives under `src/modules/focus/` and may import `src/core/*` and `src/shell/native.js` only.
- Tables are the existing `focus_lists`, `focus_items`, `focus_sessions` (lock is always `'none'` in this plan; lists are always mode `'block'`). All multi-statement writes go through one `db.batch`.
- `Db` is `{ all(sql, params?), run(sql, params?), batch(stmts) }`. Tests use `openNodeDb` on a temp file plus `migrate` and `migrateFocus`.
- The helper's wire protocol and `syncWindows(db, client, nowMs, tzOffsetAt) => { pushed, skipped }` are fixed (sub-project 1). `tzOffsetAt` returns minutes east of UTC.
- Entry validation reuses `normalizeDomain`, `normalizeApp` (`match.js`) and `validItem(kind, value)` (`limits.js`); the editor must never let through what the helper rejects.
- Custom block length is 1 to 1440 whole minutes. Presets: 25, 60, 120, 240.
- Frozen and Locked are not offered. Website blocking stays by listed name plus `www.` and `m.`.
- Node 22; `npm test` runs `node --test "tests/**/*.test.js"`; output must be warning-free.

## Review Focus

1. A block started while the helper is down is saved and later pushed exactly once; a resync is idempotent and never duplicates or loses blocks. (Tasks 4, 11)
2. Cancel when the helper is unreachable: the row is removed locally, the UI states the helper keeps enforcing until the end time and offers Retry; the retry succeeds once the helper is back. (Task 4)
3. Editing a list that is in a running block applies to that block on the next sync; deleting such a list is refused with the reason; finished sessions never block a delete. (Tasks 1, 4)
4. Hostile or odd input: pasted URLs with paths, ports, uppercase, `www.`; app names with spaces; duplicates; empty or 61-character names; over 512 items; whitespace-only entries. (Tasks 1, 3)
5. Time edge cases: a block that ends while the page is open flips to finished and stops being pushed; a countdown across a daylight-saving change; sessions with `ends <= nowMs` or absurd values in the database never crash the page. (Tasks 2, 4)

---

### Task 1: Store

**Files:**
- Create: `src/modules/focus/store.js`, `tests/focus-store.test.js`

**Interfaces:**
- Consumes: `Db`, `migrate`, `migrateFocus`; `checkEntry` from Task 3 is NOT used here (store re-validates with `normalizeDomain`/`normalizeApp`/`validItem` directly, so Task 1 has no dependency on Task 3).
- Produces (all take `db` first):
  - `ListRec = { id: number, name: string, mode: 'block', sites: string[], apps: string[] }`; `SessionRec = { id: number, listId: number, starts: number, ends: number, lock: 'none' }`.
  - `listLists(db) => Promise<ListRec[]>` sorted by lowercase name.
  - `saveList(db, input: { id?: number, name: string, sites: string[], apps: string[] }) => Promise<{ ok: true, id: number } | { ok: false, errors: { name?: string, sites?: { value: string, message: string }[], apps?: { value: string, message: string }[] } }>` — name trimmed, 1 to 60 chars, unique case-insensitively among other lists; each site goes through `normalizeDomain`, each app through `normalizeApp` then `validItem`; duplicates collapse; at most 512 items total; on success one batch replaces the list row and all its items.
  - `deleteList(db, id: number, nowMs: number) => Promise<{ ok: true } | { ok: false, reason: 'running' }>` — refuses when any session of the list has `ends > nowMs`; otherwise deletes the list, its items and its (finished) sessions in one batch.
  - `createSessions(db, args: { listIds: number[], starts: number, ends: number }) => Promise<number[]>` one `lock='none'` row per list, one batch; throws `Error('bad times')` when `ends <= starts`.
  - `setSessionsEnd(db, ids: number[], ends: number) => Promise<void>`, `deleteSessions(db, ids: number[]) => Promise<void>`, `listSessions(db) => Promise<SessionRec[]>`, `purgeFinished(db, nowMs: number, keepMs?: number) => Promise<number>` (deletes sessions that ended more than `keepMs`, default 86400000, ago; returns the count).

- [ ] **Step 1: Write failing tests** in `tests/focus-store.test.js`: `saveList stores normalized sites and apps and returns the id`; `saveList normalizes "https://www.Reddit.com/r/x?y=1" to "reddit.com" and keeps "League of Legends.exe"`; `saveList collapses duplicates after normalization`; `saveList rejects an empty name, a 61-character name and a duplicate name differing only by case`; `saveList reports each bad entry with its value and a message and saves nothing`; `saveList rejects more than 512 items`; `saveList with an id replaces items atomically (a failing second statement leaves the old items)`; `deleteList refuses while a session has ends > now and succeeds after it ended, removing sessions and items`; `createSessions writes one row per list and rejects ends <= starts`; `setSessionsEnd and deleteSessions change only the given ids`; `purgeFinished removes only sessions older than keepMs`.
- [ ] **Step 2: Run** `node --test tests/focus-store.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the signatures above in `store.js` using `db.batch`; error messages are plain English (e.g. "That doesn't look like a website address.").
- [ ] **Step 4: Run** the test file, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(focus-ui): store`.

### Task 2: Model (pure rules)

**Files:**
- Create: `src/modules/focus/model.js`, `tests/focus-model.test.js`

**Interfaces:**
- Consumes: `ListRec`, `SessionRec` (Task 1 shapes; plain objects, no import).
- Produces:
  - `formatCountdown(msLeft: number) => string` — `>= 1 h`: "2 h 14 min left" (omit minutes when 0: "2 h left"); `1 min .. < 1 h`: "14 min left" (rounded up); `< 60 s`: "45 s left"; `<= 0` or not finite: "Ending…".
  - `groupSessions(sessions: SessionRec[], lists: ListRec[], nowMs: number) => Block[]` where `Block = { key: string, ids: number[], listIds: number[], listNames: string[], starts: number, ends: number, state: 'running' | 'upcoming' | 'finished', progress: number }`; sessions sharing `starts`, `ends` and `lock` form one block; `key` is `starts + ':' + ends`; `progress` is clamped to 0..1; rows with non-finite or inverted times are dropped; unknown lists are named "(deleted list)"; sorted by `ends`.
  - `parseDuration(input: { preset?: number, custom?: string }) => { ok: true, minutes: number } | { ok: false, message: string }` — custom must be a whole number 1..1440.
  - `type HelperState = { kind: 'ok', status: Status } | { kind: 'not-running' } | { kind: 'unavailable' } | { kind: 'timeout' } | { kind: 'persist-failed', message: string } | { kind: 'unknown', message: string }` where `Status` is the helper's `Status` response.
  - `classifyHelperFailure(err: { code?: string, message?: string }) => HelperState` — `code 'persist-failed'` -> persist-failed; message containing "not running" -> not-running; "only available on Windows" or no Tauri transport -> unavailable; "did not answer in time" -> timeout; anything else -> unknown.
  - `bannerFor(h: HelperState) => { level: 'ok' | 'error' | 'warn' | 'muted', title: string, detail: string }` — ok without warnings: green "Helper running"; ok with `status.warnings` non-empty: amber (title "Helper running, with warnings", detail the first warning in plain words); not-running: red "Blocking is not active. The helper isn't running" with the fix line; persist-failed: red "A change is active but will be lost on restart"; unavailable: muted "Can't reach the helper here"; timeout: red "The helper didn't answer"; unknown: red with the message.
  - `describePushProblem(err, skipped: number, listNames: string[]) => string` — plain sentence naming the list when the helper's message includes one, plus "N items couldn't be sent" when `skipped > 0`.
  - `detailRows(status: Status | null) => { label: string, value: string }[]` — rows: Helper, Partner key (set / not set), Blocking now (e.g. "14 sites, 3 apps"), Windows held, Warnings (each verbatim), Helper clock.

- [ ] **Step 1: Write failing tests**: `formatCountdown(8040000) === "2 h 14 min left"`, `(7200000) === "2 h left"`, `(840000) === "14 min left"`, `(59000) === "59 s left"`, `(0) === "Ending…"`, `(NaN) === "Ending…"`; `groupSessions` groups two rows with equal times into one block with two list names, marks `running` / `upcoming` / `finished` by `nowMs`, clamps progress, drops an inverted row and a NaN row without throwing, names a missing list "(deleted list)"; `parseDuration({custom:"0"})`, `("1441")`, `("2.5")`, `("abc")` fail, `("90")` gives 90, `{preset:25}` gives 25; `classifyHelperFailure` maps each message/code above; `bannerFor` returns the right level and title for each kind including ok-with-warnings; a countdown computed across a US daylight-saving change from epoch millisecond differences is correct (the function must not use local-time arithmetic).
- [ ] **Step 2: Run** `node --test tests/focus-model.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** all of the above as pure functions with no DOM, no `Date.now()` and no imports.
- [ ] **Step 4: Run** the test file, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(focus-ui): model`.

### Task 3: Entry checking and starter lists

**Files:**
- Create: `src/modules/focus/entry.js`, `src/modules/focus/starters.js`, `tests/focus-entry.test.js`

**Interfaces:**
- Consumes: `normalizeDomain`, `normalizeApp` (`match.js`), `validItem` (`limits.js`).
- Produces:
  - `checkEntry(kind: 'site' | 'app', raw: string) => { ok: true, value: string, changed: boolean } | { ok: false, message: string }` — `value` is the normalized form saved; `changed` is true when it differs from the trimmed input (so the UI can show "will be saved as reddit.com"). Messages: empty -> "Type something first."; bad site -> "That doesn't look like a website address."; bad app -> "Use the program's file name, like steam.exe."
  - `STARTERS: { name: string, sites: string[], apps: string[] }[]` exactly: Social media (facebook.com, instagram.com, tiktok.com, x.com, reddit.com, snapchat.com; no apps), News (bbc.com, cnn.com, nytimes.com, theguardian.com; no apps), Games (steampowered.com, epicgames.com; apps steam.exe, epicgameslauncher.exe).

- [ ] **Step 1: Write failing tests**: `checkEntry('site',"https://www.Reddit.com/r/x?y=1:8080")` ok with value `reddit.com` and `changed: true`; `("site","reddit.com")` ok with `changed: false`; `("site","not a domain")`, `("site","localhost")`, `("site","10.0.0.1")`, `("site","")`, `("site","   ")` fail with the messages above; `("app","League of Legends.exe")` ok unchanged; `("app","C:\\Games\\Steam.EXE")` ok value `steam.exe`; `("app","a/b")` and `("app","x:y")` fail; every `STARTERS` entry passes `checkEntry` and none changes under it; the starter names are unique; the item vectors in `tests/fixtures/item-vectors.json` agree with `checkEntry` for every vector (valid vectors ok, invalid vectors not ok).
- [ ] **Step 2: Run** `node --test tests/focus-entry.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `entry.js` on top of the three helpers (a site passes when `normalizeDomain` returns non-null and `validItem('site', value)`; an app when `validItem('app', normalizeApp(raw))`), and `starters.js` as plain data.
- [ ] **Step 4: Run** the test file, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(focus-ui): entry checks and starter lists`.

### Task 4: Controller

**Files:**
- Create: `src/modules/focus/controller.js`, `tests/focus-controller.test.js`

**Interfaces:**
- Consumes: Task 1 store functions, Task 2 model functions, `syncWindows` and `createHelperClient` (sub-project 1). The client is injected, so tests pass a fake.
- Produces: `createController({ db, client, now, tzOffsetAt, onChange }) => Controller` where `now: () => number`, `onChange: () => void` is called after every state change, and `Controller` has:
  - `state` (getter): `{ lists: ListRec[], blocks: Block[], helper: HelperState, syncPending: boolean, lastSync: { pushed: number, skipped: number } | null, notice: string | null }`.
  - `load() => Promise<void>` — loads lists and sessions, purges sessions finished more than a day ago, computes blocks, then `resync()` and `refreshStatus()`.
  - `saveList(input) => Promise<SaveResult>` (the Task 1 result), then `resync()`; editing a list in a running block therefore updates that block.
  - `deleteList(id) => Promise<{ ok: true } | { ok: false, reason: 'running' }>`.
  - `startBlock({ listIds: number[], minutes: number }) => Promise<{ ok: true } | { ok: false, message: string }>` — validates with `parseDuration`-compatible minutes, writes sessions with `starts = now()`, `ends = now() + minutes*60000`, then resyncs; success of the database write is `ok: true` even when the sync fails (the block shows "saved, not yet enforced").
  - `extendBlock(key: string, addMinutes: number) => Promise<{ ok: boolean, message?: string }>` — `setSessionsEnd` for the block's ids (new end = old end + add, capped so the block never exceeds 1440 minutes in total), then resync.
  - `cancelBlock(key: string) => Promise<{ ok: true, helperStopped: boolean, enforcedUntil?: number }>` — deletes the rows, then resyncs; when the resync fails `helperStopped: false` and `enforcedUntil` is the old end.
  - `refreshStatus() => Promise<void>` — `client.status()`; success -> `helper = { kind: 'ok', status }`; failure -> `classifyHelperFailure(err)`; never throws.
  - `resync() => Promise<void>` — `syncWindows(db, client, now(), tzOffsetAt)`; success sets `lastSync`, clears `syncPending`; failure sets `syncPending = true`, `helper` from the failure, and `notice` from `describePushProblem`; never throws; concurrent calls are serialized (a second call waits for the first, then runs once more).

- [ ] **Step 1: Write failing tests** with a real temp db and a fake client recording `pushWindows` payloads: `load pushes current windows once and reads status`; `startBlock saves rows and pushes a window per list with the normalized items`; `startBlock while the client throws "not running" saves the rows, sets syncPending and a not-running banner state, and the next resync pushes the block exactly once` (Review Focus 1); `a second resync with no changes pushes the same set (idempotent) and creates no new rows`; `cancelBlock removes rows and pushes without the window`; `cancelBlock while the client is unreachable returns helperStopped:false with the old end, and a later resync succeeds` (Review Focus 2); `saveList on a list in a running block re-pushes the window with the new items` and `deleteList refuses while running, succeeds after the end` (Review Focus 3); `extendBlock caps the total at 1440 minutes`; `a block whose end passes between calls is not pushed and shows state finished` (Review Focus 5, use the injected clock); `persist-failed from the client sets the persist-failed banner state`; `refreshStatus never throws on any error`; `concurrent resync calls do not interleave pushes`.
- [ ] **Step 2: Run** `node --test tests/focus-controller.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `controller.js`. Keep a promise chain for resync serialization.
- [ ] **Step 4: Run** the test file, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(focus-ui): controller`.

### Task 5: Module registration and shell start hook

**Files:**
- Create: `src/modules/focus/index.js`, `src/modules/focus/tz.js`, `tests/focus-tz.test.js`
- Modify: `src/shell/modules.js`, `src/shell/builtin.js`, `src/main.js`, `tests/modules.test.js`

**Interfaces:**
- Consumes: `registerModule`, `listModules`; `createController`, `createHelperClient`, `createTauriHelperCall`.
- Produces:
  - `registerModule(def)` accepts an optional `onStart(ctx) => void | Promise<void>`; new export `runStartHooks(ctx) => Promise<void>` calls every module's `onStart` in module order, catching and `console.error`-ing each failure so one module cannot stop another.
  - `src/modules/focus/index.js` registers `{ id: 'focus', name: 'Focus Room', icon: '🎯', ready: true, render(root, ctx), onStart(ctx) }`; `onStart` creates the controller and runs `load()` once (with `createTauriHelperCall()` when `window.__TAURI__` exists, otherwise a client whose call rejects with an error whose message contains "only available in the desktop app"); `render(root, ctx)` mounts the home view (Task 7) and returns a cleanup function that stops polling. Until Task 7 lands, `render` shows the page title only.
  - `builtin.js` no longer lists `focus` in the `soon` array; `main.js` imports `./modules/focus/index.js` and calls `runStartHooks(ctx)` after the database is open and before the first `route()`.
  - `makeTzOffsetAt(timeZone?: string) => (utcMs: number) => number` in `tz.js` — minutes east of UTC at that instant for the given IANA zone (default: the system zone from `Intl.DateTimeFormat().resolvedOptions().timeZone`), computed with `Intl.DateTimeFormat(..., { timeZone, hourCycle: 'h23', year, month, day, hour, minute, second }).formatToParts`; `index.js` passes `makeTzOffsetAt()` to `createController`.

- [ ] **Step 1: Write failing tests** in `tests/focus-tz.test.js`: `makeTzOffsetAt('UTC')(0) === 0`; `makeTzOffsetAt('America/New_York')` gives `-300` for `Date.UTC(2026,0,15,12)` and `-240` for `Date.UTC(2026,6,15,12)`; `makeTzOffsetAt('Asia/Kolkata')` gives `330`; the offset changes from `-300` to `-240` across `Date.UTC(2026,2,8,6,59)` and `Date.UTC(2026,2,8,7,1)` (US spring-forward); with no argument it returns a finite number. Then in `tests/modules.test.js`: `runStartHooks calls each onStart in module order`; `a throwing onStart is logged and does not stop later hooks`; `registering the focus module twice still throws duplicate`; `the sidebar lists Focus Room as ready (not soon)`.
- [ ] **Step 2: Run** `node --test tests/focus-tz.test.js tests/modules.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the hook, `tz.js`, the registration and the `builtin.js` / `main.js` edits.
- [ ] **Step 4: Run** `npm test`. Expected: PASS (all existing tests still pass).
- [ ] **Step 5: Commit** `feat(focus-ui): register module and add start hook`.

### Task 6: Screenshot harness with the real helper

**Files:**
- Create: `scripts/helper-bridge.mjs`
- Modify: `scripts/shot.mjs`, `tests/focus-stdio.test.js`

**Interfaces:**
- Produces: `createStdioCall(binPath: string, statePath: string) => { call(requestLine: string): Promise<string>, close(): Promise<void> }` in `scripts/helper-bridge.mjs` — spawns `binPath stdio --state statePath`, writes one line per call, resolves with the next stdout line, rejects on exit; `shot.mjs` gains `--helper <binPath>` which creates a bridge (state file in its temp dir) and makes the harness's `__db` handler answer `focus_helper_call` with `{ request }` by calling the bridge; `--helper-down` makes `focus_helper_call` reject with `"The Focus Room helper service is not running"`; the steps file's third argument gains `bridge`. `tests/focus-stdio.test.js` imports `createStdioCall` instead of its inline copy.

- [ ] **Step 1: Write the failing check:** update `tests/focus-stdio.test.js` to import `createStdioCall` from `../scripts/helper-bridge.mjs`; run it. Expected: FAIL (module missing) when the helper binary is built (`cargo build --manifest-path focus-helper/Cargo.toml` first).
- [ ] **Step 2: Implement** `helper-bridge.mjs` and the `shot.mjs` flags.
- [ ] **Step 3: Run** `node --test tests/focus-stdio.test.js` and `npm test`. Expected: PASS.
- [ ] **Step 4: Verify the harness** with a throwaway steps file outside the repo that loads `#/focus`, checks via `page.evaluate` that `window.__TAURI__` exists and that invoking `focus_helper_call` with `{"type":"GetStatus"}` returns a `Status` line, and prints OK. Run `node scripts/shot.mjs /tmp/focus-shots --helper target/debug/focus-helper --steps <file>`. Expected: prints OK and "no console errors".
- [ ] **Step 5: Commit** `test(focus-ui): screenshot harness talks to the real helper`.

### Task 7: Home view

**Files:**
- Create: `src/modules/focus/ui/dom.js`, `src/modules/focus/ui/dialog.js`, `src/modules/focus/ui/home.js`
- Modify: `src/modules/focus/index.js`, `src/styles.css` (new `.fr-*` classes appended)

**Interfaces:**
- Consumes: Controller (Task 4), `bannerFor`, `formatCountdown` (Task 2).
- Produces: `h(tag, props?, ...kids)` in `dom.js` (same behaviour as the Second Brain helper, kept private to the Focus module); `openDialog({ title, body: HTMLElement, onClose? }) => { close(): void }` in `dialog.js` (modal overlay, focus moves into the dialog and is trapped, Esc and the overlay click close, focus returns to the opener); `mountHome(root: HTMLElement, controller: Controller, ctx) => () => void` in `home.js` — renders the banner, one card per running block (names, countdown updating every second, progress bar, Extend and Cancel buttons that call the controller; `aria-live` announcement once a minute), the "No block running" state with a Start a block button, the lists section (name, chips, Edit, Delete disabled with the reason while running), the first-run welcome card with the three starters and a blank option, and a collapsed "Helper details" area (filled by Task 10). It polls `controller.refreshStatus()` every 5 s and `controller.resync()` every 30 s while `syncPending`, and returns a cleanup that clears all timers. Edit, Start and the starter buttons call `openListEditor` / `openStartDialog` from Tasks 8 and 9 (stubs that throw "not built yet" until then are NOT allowed: wire them as no-ops guarded by `typeof === 'function'` and finish the wiring in those tasks).

- [ ] **Step 1: Implement** `dom.js`, `dialog.js`, `home.js` and the CSS using the app's existing variables (`--panel`, `--border`, `--accent`, `--muted`, `--hover`, `--code`) so light and dark both work; no inline colors except the green/amber/red banner pairs defined as CSS variables for both themes.
- [ ] **Step 2: Verify with screenshots:** write `scripts/focus-steps.mjs` (a harness steps file; exports the default function used later by Task 12) whose first scenarios are: first run with no lists; then via `page.evaluate` insert a list and a running session into the harness db and reload; helper running (use `--helper`); helper down (`--helper-down`). Run `node scripts/shot.mjs /tmp/focus-shots --helper target/debug/focus-helper --steps scripts/focus-steps.mjs` and `--dark`. Look at each PNG and confirm: banner color and text per state, countdown text, lists with chips, welcome card with three starters, nothing overflowing at 1280x800. Expected: "no console errors".
- [ ] **Step 3: Run** `npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(focus-ui): home view`.

### Task 8: List editor

**Files:**
- Create: `src/modules/focus/ui/list-editor.js`
- Modify: `src/modules/focus/ui/home.js` (wire Edit, New list, starters), `src/styles.css`

**Interfaces:**
- Consumes: `checkEntry`, `STARTERS` (Task 3), `controller.saveList`, `openDialog`.
- Produces: `openListEditor({ controller, list?: ListRec, preset?: { name, sites, apps }, onDone?: () => void }) => void` — dialog with a name input, a Websites chip input and an Apps chip input (Enter or comma adds; Backspace on an empty input removes the last chip); each added entry runs `checkEntry`, shows "will be saved as <value>" when `changed`, and shows the error message inline for a bad one (not added); duplicates collapse silently; a hint beside Websites: "Add each address you want blocked. www. and m. are included."; Save is disabled until the name is valid and there is at least one entry; on a `{ ok:false }` result the per-entry and name errors are shown and the dialog stays open with input intact; on success it closes and calls `onDone`.

- [ ] **Step 1: Implement** the editor and wire the buttons.
- [ ] **Step 2: Verify with screenshots** (extend `scripts/focus-steps.mjs`): open the editor; type `https://www.Reddit.com/r/x`, press Enter and assert the chip reads `reddit.com` and the "will be saved as" note shows; type `not a domain` and assert the inline error and no chip; add `League of Legends.exe` as an app; try a 61-character name and assert Save is disabled or the error shows; save and assert the list appears on Home with chips; edit it again and remove a chip. Capture light and dark PNGs and look at them. Expected: assertions pass, "no console errors".
- [ ] **Step 3: Run** `npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(focus-ui): list editor`.

### Task 9: Start dialog and block actions

**Files:**
- Create: `src/modules/focus/ui/start-dialog.js`
- Modify: `src/modules/focus/ui/home.js`, `src/styles.css`

**Interfaces:**
- Consumes: `parseDuration`, `controller.startBlock`, `extendBlock`, `cancelBlock`, `openDialog`.
- Produces: `openStartDialog({ controller, onDone?: () => void }) => void` — checkboxes for each list (none selected by default; Start disabled until one is), duration chips 25 min, 1 h, 2 h, 4 h and a custom minutes input validated with `parseDuration` (inline message), the line "Normal: you can cancel any time.", a greyed non-interactive "🔒 Locked, coming soon" option, a summary "Ends at 5:00 PM" computed from the clock, and a Start button; Home wires Extend (+15 min, +1 h, custom) and Cancel (a confirm dialog "Stop blocking now?"), showing the controller's notices: "Saved, not yet enforced" when the sync failed, and "Couldn't tell the helper to stop. It will stop by <time> at the latest." with a Retry button (calls `controller.resync()`) when `cancelBlock` returns `helperStopped: false`.

- [ ] **Step 1: Implement** the dialog and the wiring.
- [ ] **Step 2: Verify with screenshots** (extend `scripts/focus-steps.mjs`): with the real helper, start a 25-minute block on one list and assert via `page.evaluate` that a `GetStatus` call shows the list's sites in `decision.blockSites` and that Home shows a countdown near "25 min left"; extend by 15 minutes and assert the countdown grows; cancel and assert the helper's `decision.blockSites` becomes empty; then repeat start and cancel with `--helper-down` semantics (launch a second run) and assert the "saved, not yet enforced" and "Couldn't tell the helper to stop" messages appear. Capture PNGs (start dialog with a custom-minutes error, running block, helper-down notices) in light and dark and look at them. Expected: assertions pass, "no console errors".
- [ ] **Step 3: Run** `npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(focus-ui): start dialog and block actions`.

### Task 10: Helper details panel

**Files:**
- Create: `src/modules/focus/ui/helper-details.js`
- Modify: `src/modules/focus/ui/home.js`, `src/styles.css`

**Interfaces:**
- Consumes: `detailRows`, `bannerFor`, the controller's `state.helper`.
- Produces: `mountHelperDetails(container: HTMLElement, controller: Controller) => { update(): void }` — a `<details>` element titled "Helper details" listing `detailRows(status)` as label/value pairs; when the helper is not reachable it shows the banner's detail text and the fix line instead; warnings are listed verbatim, one per line; `update()` re-renders from `controller.state` (called by Home on every state change without collapsing an open panel).

- [ ] **Step 1: Implement** the panel and the Home wiring.
- [ ] **Step 2: Verify with screenshots**: expanded details with the real helper (partner key "not set", windows held, blocking counts after starting a block), and with the helper down; confirm an open panel stays open across the 5-second poll (take a screenshot after waiting 6 s). Expected: "no console errors".
- [ ] **Step 3: Run** `npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(focus-ui): helper details panel`.

### Task 11: End-to-end test with the real helper

**Files:**
- Create: `tests/focus-ui-e2e.test.js`

**Interfaces:**
- Consumes: `createController`, `createHelperClient`, `createStdioCall` (Task 6), the helper binary `target/debug/focus-helper(.exe)`.
- Produces: nothing new; skips cleanly when the binary is absent (same skip rule as `tests/focus-stdio.test.js`).

- [ ] **Step 1: Write the test** with a temp db, a real stdio helper and the controller: `startBlock pushes a window and the helper reports the list's sites in decision.blockSites`; `extendBlock moves the end in both the db and the helper`; `cancelBlock makes the helper drop the window` (the helper replaces `none` windows with the pushed set); `a block started while the helper process is not yet running is pushed after the bridge starts` (start the controller with a call that rejects, then swap in the bridge and `resync`; the helper then lists it exactly once; a second `resync` leaves exactly one window — Review Focus 1); `a 1-minute block started with an injected clock far in the past is not pushed` (helper never sees it); `editing a list during a running block changes the helper's blocked sites after the resync` (Review Focus 3).
- [ ] **Step 2: Run** `cargo build --manifest-path focus-helper/Cargo.toml` then `node --test tests/focus-ui-e2e.test.js`. Expected: PASS (and SKIP when the binary is missing).
- [ ] **Step 3: Run** `npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `test(focus-ui): end-to-end with the real helper`.

### Task 12: Final screenshots, checklist and docs

**Files:**
- Modify: `scripts/focus-steps.mjs`, `docs/superpowers/focus-room-windows-checklist.md`, `README.md`

**Interfaces:**
- Produces: a documented screenshot run: `node scripts/shot.mjs <dir> --helper target/debug/focus-helper --steps scripts/focus-steps.mjs [--dark]` producing the named states from the spec (first run, lists, running block, helper down, helper warnings, editor with errors, start dialog; light and dark); README gains a short "Focus Room screens" note with that command; the Windows checklist gains a new section "Focus Room screens (sub-project 2)" with one `- [ ] action — Expected: result` line each: start a block from the UI and confirm a listed site stops loading and resumes after Cancel; stop the `MyBrainFocus` service (when no lock exists) and confirm the red banner appears within 10 s and returns to green after it restarts; start a block while the service is stopped, start the service, and confirm the site is blocked without touching the UI; a list edit during a running block changes what is blocked; an app with spaces in its name (e.g. a game launcher) is closed while blocked; the first-run starters create editable lists; the Frozen/Locked option is greyed and does nothing.

- [ ] **Step 1: Finish** the scenario file so one run produces all states in both themes.
- [ ] **Step 2: Run** the screenshot command in light and dark, look at every PNG, and fix any visual defect found (overflow, contrast, clipped chips) in the earlier tasks' files. Expected: "no console errors".
- [ ] **Step 3: Update** the checklist and README.
- [ ] **Step 4: Run** `npm test`, `cargo test --manifest-path focus-helper/Cargo.toml` and confirm the repo's CI-parity checks (`node scripts/gen-decide-vectors.js`, `node scripts/gen-item-vectors.js`, `node scripts/build-partner-page.js` then `git diff --exit-code` on their outputs). Expected: all green, no diff.
- [ ] **Step 5: Commit** `docs(focus-ui): screenshots, checklist and README`.
