# Focus Room UI (sub-project 2): design

Date: 2026-11-09. Status: draft, awaiting owner review.

Builds on `2026-11-08-focus-room-design.md` (engine, helper, partner unlock) and
`2026-11-08-mybrain-design.md` (the shell). Read those first.

## Purpose

The screens that let the owner use the Focus Room from inside MyBrain: manage
block lists, start timed blocks, see what is being enforced, and see whether
the helper is working. This is sub-project 2 in the delivery order.

## Scope

In scope: block lists (sites and apps), timed sessions with lock level
`none` only, live status, helper health, starter lists, sync of windows to the
helper.

Out of scope (later sub-projects): weekly schedules (3); locked sessions, the
partner key setup and the unlock flow, Frozen mode (4); allow-lists, breaks,
usage stats (5). The Start dialog shows a greyed "Locked, coming soon" option
so the roadmap is visible; it does nothing.

## Success criteria

- The owner can create and edit lists, start a block for N minutes, watch it count down, extend it, and cancel it, all from the app.
- The module works without the helper installed: lists and sessions are saved, and a clear red banner says blocking is not active (decision: option 1).
- Anything saved while the helper was down reaches it later, without the owner doing anything.
- The UI never claims something worked when it did not (see Errors).
- The logic is plain JavaScript with Node tests, including an end-to-end test against the real helper binary. Every screen is checked with headless screenshots in light and dark themes.

## Architecture

All in `src/modules/focus/`, following the Second Brain pattern: plain ES
modules, no framework, no build step. Modules never import each other.

- `store.js`: save and load `focus_lists`, `focus_items`, `focus_sessions` (tables from sub-project 1). Atomic writes through `db.batch`. Tested against a temp SQLite file.
- `model.js`: pure rules: countdown text, session state (running, finished), helper banner level and text from a helper status or a failure, grouping of sessions that share start and end into one card, duration limits.
- `controller.js`: orchestrates `loadState`, `saveList`, `deleteList`, `startSession`, `extendSession`, `cancelSession`, `refreshStatus`, `resync`. Takes `{ db, client, now, tzOffsetAt }` so tests inject a fake client and clock.
- `ui/`: DOM views only: `home.js`, `list-editor.js`, `start-dialog.js`, `helper-details.js`, `dialog.js` (focus trap, Esc to close).
- `starters.js`: three starter lists (Social media, News, Games) as plain data, editable before saving.
- `index.js`: registers the module with `registerModule`, and replaces the "coming soon" placeholder in `src/shell/builtin.js`.

Shell change (small): `registerModule` accepts an optional `onStart(ctx)`; `src/main.js` calls it for every module once the database is ready. The Focus module uses it to run one sync at app start, whether or not the owner opens the Focus Room.

Helper access: the Tauri bridge `createTauriHelperCall()` and `createHelperClient()` from sub-project 1. `syncWindows(db, client, now, tzOffsetAt)` builds and pushes windows.

## Data flow

1. Every change is written to the database first, then synced.
2. Sync = `syncWindows`, which pushes the whole current set of windows. The helper replaces its `none` windows with the pushed set, so cancelling a normal session is "delete the row, then sync".
3. While the Focus Room is open: `GetStatus` every 5 s for the banner and details; if the last sync failed, a retry every 30 s. At app start: one sync.
4. `tzOffsetAt` is built from `Intl.DateTimeFormat` for the system time zone (minutes east of UTC, the opposite sign to `Date.getTimezoneOffset()`).

A session row is one list. Starting a block on several lists writes one row per list with identical start and end; the UI groups them into one card and cancel or extend applies to the whole group.

## Screens

**Home.**
- Banner (one of): green "Helper running"; red "Blocking is not active. The helper isn't running" with a short fix line (the installer, or `focus-helper install` as Administrator); amber for warnings the helper reports, shown in plain words and verbatim in the details; grey "Can't reach the helper here" (non-Windows or development).
- One card per running block: list names, live countdown, progress bar, Extend (+15 min, +1 h, custom) and Cancel. With none running: "No block running" and a Start a block button.
- Lists: name, chips for sites and apps, Edit, Delete. Delete is disabled with the reason while the list is in a running block.
- First run (no lists): a welcome card with the three starter lists and a blank option.

**List editor (dialog).** Name; Websites and Apps as separate chip inputs (Enter adds). Entries are validated as typed, using the sub-project 1 rules (`normalizeDomain`, `normalizeApp`, and the shared item rules including spaces in app names): pasting `https://www.Reddit.com/r/x` shows it will be saved as `reddit.com`; a bad entry shows a plain reason; duplicates collapse. Save is disabled until the list is valid and has a name.

**Start a block (dialog).** One or more lists; duration 25 min, 1 h, 2 h, 4 h, or custom minutes (1 to 1440; the UI caps normal blocks at 24 hours for sanity, the helper has no cap for `none`). A line says "Normal: you can cancel any time." The greyed Locked option is informational only.

**Helper details (collapsible).** The helper's own report in plain language: running, partner key set or not, how many sites and apps are blocked right now, windows held, warnings word for word, and the helper's clock.

Accessibility: labelled inputs, dialogs trap focus and close on Esc, the countdown updates visually every second but is announced to screen readers once a minute.

## Errors

The rule: data is saved first, and the UI never pretends something worked.

- Database write fails: the dialog stays open with the input intact and shows the error.
- Helper unreachable (error code `unreachable`): red banner; sessions stay saved; automatic retry every 30 s while open and at the next start.
- Helper rejects a push (`bad-window`, `too-many`, `allow-needs-apps`, `frozen-unavailable`): a message names the list and says how many items were not sent. Editor validation should make this rare.
- `persist-failed`: the banner says the change is active but will be lost on restart.
- Cancel when the helper cannot be reached: the row is deleted locally; the UI says "Couldn't tell the helper to stop. It will stop by <end time> at the latest" with a Retry button.
- Sync after start fails: the block is shown as "saved, not yet enforced".

## Testing

- Node tests: `store` (CRUD, atomicity, delete protection, grouping), `model` (countdown formatting, session state, banner mapping, duration limits including edge cases: ends in the past, zero length, huge values), `controller` with a fake client and a real temp database (start, extend, cancel, helper down, each error mapping, retry), starter lists pass the item validators.
- End-to-end Node test with the real `focus-helper stdio` binary (skips when not built, like `focus-stdio.test.js`): start a block, helper status shows the sites in `decision.blockSites`; cancel, helper no longer lists it; extend moves the end.
- Screenshots: extend `scripts/shot.mjs` with a Focus scenario. The harness serves `src/`; a small shim implements `window.__TAURI__.core.invoke('focus_helper_call')` by forwarding to a `focus-helper stdio` process, so screenshots reflect real helper responses. States: first run, lists, a running block, helper down, helper warnings, list editor with errors, start dialog; light and dark. The executor checks each image and sends them to the owner.
- CI: unchanged jobs; the new tests run in `npm test`. Screenshots are not part of CI.
- Not provable here: the real Tauri window on Windows and real enforcement. Add to the Windows checklist: start and cancel a block from the UI and confirm the site stops and resumes loading; the helper-down banner appears when the service is stopped; a block saved while the service was stopped is enforced after it starts.

## Decisions and limits

- Lists are always `block` mode in this sub-project (the `mode` column stays for sub-project 5).
- Starter list contents are plain data in `starters.js`: Social media (facebook.com, instagram.com, tiktok.com, x.com, reddit.com, snapchat.com), News (bbc.com, cnn.com, nytimes.com, theguardian.com), Games (steampowered.com, epicgames.com, steam.exe, epicgameslauncher.exe).
- Website blocking is still by listed name plus `www.` and `m.`; the editor says so beside the Websites input ("Add each address you want blocked").
- Frozen and Locked are not offered; the helper rejects frozen windows.
- Sessions and lists are not yet searchable in the Ctrl+K palette (no search provider for the Focus module in this sub-project).

## Open items

None. The exact wording of messages is settled in the plan.
