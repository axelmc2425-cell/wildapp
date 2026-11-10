# Focus Room file and folder pickers (5a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner add programs by browsing for `.exe` files and block whole folders by browsing for a directory; the helper blocks any process whose path is inside a blocked folder.

**Architecture:** Folders are a third item kind (`folders`) next to `sites` and `apps`, carried end to end: database (schema v3), store, window expansion and merge, the helper's `Window.app_folders`, `Decision.block_folders`, and a path match in process enforcement. The helper validates and refuses dangerous folders itself. The editor gets Browse buttons built on the Tauri dialog plugin, shown only in the desktop app.

**Tech Stack:** Vanilla JS ES modules (Node test runner), Rust (`focus-helper`), Tauri v2 dialog plugin via `window.__TAURI__`, SQLite.

**Spec:** `docs/superpowers/specs/2026-11-10-focus-pickers-design.md`

## Global Constraints

- Folders are block-mode only; allow-mode windows ignore `app_folders`.
- Folder values are absolute Windows paths with a drive letter (`C:\Games\Foo`); stored as picked (case kept, backslashes, no trailing `\`, no `.` segments, `..` refused).
- Forbidden (any drive letter, case-insensitive): the drive root; `X:\Windows` and anything below it; `X:\Program Files`, `X:\Program Files (x86)` and `X:\Users` themselves (subfolders allowed); `X:\Program Files\MyBrainFocus` and below. Wildcards (`* ? < > | "`) and control characters are malformed.
- Helper error codes: `bad-window` with reason `bad-folder` (malformed) or `forbidden-folder` (forbidden).
- Path match: ASCII-lowercase both sides, `/` to `\`, strip trailing `\`; match when equal or when the process path starts with the folder plus `\`. A process path of `None` never matches and is never killed for a folder rule.
- Items per window stay capped at 512 across sites, apps and folders (`MAX_ITEMS` in JS, `MAX_ITEMS_PER_WINDOW` in Rust).
- The existing never-kill guards (self pid, pid 0 and 4, `CRITICAL_APPS`, unreadable names) run before any folder match.
- `STORE_VERSION` becomes 3; a state file without `app_folders` loads with none. Focus schema version becomes 3.
- UI never uses innerHTML; `h()` from `ui/dom.js`; `.fr-*` CSS classes. Browse buttons exist only when `hasNative()` is true.
- Every subagent runs on Sonnet, never Opus.

## Review Focus

- A folder named like another (`C:\Games` vs `C:\GamesX`, `C:\Games\` with trailing slash, mixed case, forward slashes): only the real folder and its children match. Pinned in Task 2.
- A process with an unreadable path while a folder rule is active: it is skipped, never killed. Pinned in Task 2.
- A pushed folder such as `C:\`, `C:\Windows\System32`, `c:\program files\mybrainfocus` or one with `..`: refused by the helper even if the app is bypassed. Pinned in Task 1.
- An old helper state file or an old database with no folders: loads cleanly, nothing lost. Pinned in Tasks 1 and 4.
- Cancelling a dialog, or a pick that is a duplicate or invalid: no change, a plain message, no crash. Pinned in Task 5.

## File structure

- `tests/fixtures/folder-vectors.json` (new, Task 1): `{ "ok": [paths], "malformed": [paths], "forbidden": [paths] }`, read by both the Rust and JS tests.
- `focus-helper/src/lockstore.rs`, `model.rs`, `ipc.rs`: window field, validation, error codes.
- `focus-helper/src/decide.rs`, `enforce.rs`, `win/procs.rs`: decision, path match, enforcement.
- `src/modules/focus/folders.js` (new, Task 3): pure folder normalize/validate, mirrors the Rust rules.
- `src/modules/focus/entry.js`, `limits.js`: entry and push checks for folders.
- `src/modules/focus/schema.js`, `store.js`, `expand.js`, `sync.js`: v3, storage, window build.
- `src/shell/native.js`, `ui/list-editor.js`, `ui/editor-logic.js`, `model.js`, `src/styles.css`: pickers and UI.

---

### Task 1: Helper window field, validation and state version

**Files:**
- Create: `tests/fixtures/folder-vectors.json`
- Modify: `focus-helper/src/model.rs`, `focus-helper/src/lockstore.rs`, `focus-helper/src/ipc.rs`, and every `Window { .. }` literal in `focus-helper/src` and its tests (compiler errors list them)
- Test: unit tests in `lockstore.rs`

**Interfaces:**
- Produces: `Window.app_folders: Vec<String>` (`#[serde(default, skip_serializing_if = "Vec::is_empty")]`); `pub fn folder_problem(s: &str) -> Option<FolderProblem>` in `lockstore.rs`; `pub enum FolderProblem { Malformed, Forbidden }`; `PushError::BadFolder` and `PushError::ForbiddenFolder`; `STORE_VERSION = 3`.

- [ ] **Step 1: Write the fixture and failing tests.** `folder-vectors.json` holds at least: ok `C:\Games\Steam`, `d:\Apps\My Game`, `C:\Program Files\Some App`, `C:\Users\me\Games`; malformed `Games`, `\\server\share`, `C:Games`, `C:\a\..\b`, `C:\a\*`, `C:\a\u0007b`, empty; forbidden `C:\`, `c:\WINDOWS`, `C:\Windows\System32`, `C:\Program Files`, `C:\Program Files (x86)\`, `C:\Users`, `C:\Program Files\MyBrainFocus`, `C:\Program Files\MyBrainFocus\x`. Tests in `lockstore.rs`: `folder_vectors_match_fixture` (reads the file, asserts each class), `push_rejects_bad_folder` (`PushError::BadFolder`), `push_rejects_forbidden_folder` (`ForbiddenFolder`), `folders_count_toward_item_cap` (513 items across sites, apps and folders is `TooMany`), `old_state_without_app_folders_loads` (state JSON with version 2 and a window lacking `app_folders` loads with an empty vec), `locked_window_folders_ignored_on_repush` (re-pushing an accepted locked id with different folders keeps the stored ones).
- [ ] **Step 2: Run** `cargo test -p focus-helper lockstore` — expect compile failure, then test failures.
- [ ] **Step 3: Implement** `folder_problem` per the Global Constraints (normalize `/` to `\` and ASCII-lowercase for the forbidden comparison only); add the field to `Window`; validate folders in `push` after the item checks (malformed before forbidden); map new errors in `ipc.rs` to `bad-window` / `bad-folder` and `forbidden-folder`; bump `STORE_VERSION` to 3 and update the ipc doc comment listing codes.
- [ ] **Step 4: Run** `cargo test -p focus-helper` — expect all pass.
- [ ] **Step 5: Commit** `feat(helper): app_folders window field with validation`.

### Task 2: Helper decision, path match and enforcement

**Files:**
- Modify: `focus-helper/src/model.rs` (Decision), `focus-helper/src/decide.rs`, `focus-helper/src/enforce.rs`, `focus-helper/src/win/procs.rs`, and the fake process tables in tests
- Test: unit tests in `decide.rs` and `enforce.rs`

**Interfaces:**
- Consumes: Task 1 `Window.app_folders`.
- Produces: `Decision.block_folders: Vec<String>` (serialized `blockFolders`); `pub fn is_blocked_path(d: &Decision, path: &str) -> bool` in `decide.rs`; `Proc.path: Option<String>`.

- [ ] **Step 1: Write failing tests.** `decide.rs`: `block_folders_merged_sorted_deduped`, `allow_mode_folders_ignored`, `path_match_boundaries` (`C:\Games` matches `c:/games/x/y.exe`, `C:\Games\`, `C:\GAMES\a.exe`; does not match `C:\GamesX\a.exe` or `C:\Gam`). `enforce.rs` with a fake table that has paths: `kills_process_inside_blocked_folder`, `spares_sibling_folder`, `spares_process_with_unknown_path`, `critical_app_inside_blocked_folder_survives`, `folder_rule_alone_counts_as_active_window`.
- [ ] **Step 2: Run** `cargo test -p focus-helper decide enforce` — expect failures.
- [ ] **Step 3: Implement** `decide` to fill `block_folders` from block-mode windows; `is_blocked_path` per the match rule; `any_window_active` also true when `block_folders` is non-empty; in `enforce_once` add `|| p.path.as_deref().map_or(false, |x| is_blocked_path(d, x))` to the blocked condition, after the existing guards; in `win/procs.rs` fill `path` from the sysinfo process `exe()` (needs `ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet)`), `None` if absent. Keep `kill`'s identity re-check unchanged.
- [ ] **Step 4: Run** `cargo test -p focus-helper` — expect all pass; also `cargo check -p focus-helper --target x86_64-pc-windows-gnu` as CI does for the Windows type-check.
- [ ] **Step 5: Commit** `feat(helper): block processes running from a blocked folder`.

### Task 3: JS folder rules, entry and push validation

**Files:**
- Create: `src/modules/focus/folders.js`, `tests/focus-folders.test.js`
- Modify: `src/modules/focus/entry.js`, `src/modules/focus/limits.js`
- Test: `tests/focus-folders.test.js`, extend `tests/focus-limits.test.js`

**Interfaces:**
- Consumes: `tests/fixtures/folder-vectors.json` (Task 1).
- Produces: `normalizeFolder(raw: string): string | null` (backslashes, strip trailing `\`, drop `.` segments, `null` if not absolute-with-drive or malformed); `folderProblem(value: string): 'malformed' | 'forbidden' | null`; `checkEntry('folder', raw)` returning the existing `{ok, value, changed} | {ok:false, message}` shape; `validItem('folder', value)`; `Window.app_folders?: string[]` in the typedef.

- [ ] **Step 1: Write failing tests** `folder_vectors_match_rust_fixture` (every ok/malformed/forbidden entry classified as in the fixture, via `folderProblem(normalizeFolder(x) ?? x)`), `normalizeFolder` cases (`C:/Games/Foo/` becomes `C:\Games\Foo`; `C:\a\.\b` becomes `C:\a\b`; `C:\a\..\b` is null), `checkEntry('folder', ...)` messages (forbidden: "That folder is part of Windows and can't be blocked."; malformed: "Pick a folder with the Browse folder button."), and `validateItems` rejects a window whose `app_folders` has a bad value with `bad-item`.
- [ ] **Step 2: Run** `node --test tests/focus-folders.test.js tests/focus-limits.test.js` — expect failures.
- [ ] **Step 3: Implement** `folders.js` mirroring `folder_problem`; wire `checkEntry` and `validItem('folder')`; `validateItems` also checks `app_folders` when present and counts them toward `MAX_ITEMS_PER_WINDOW`.
- [ ] **Step 4: Run** `npm test` — expect all pass.
- [ ] **Step 5: Commit** `feat(focus): folder rules and entry checks`.

### Task 4: Schema v3, store, expand and sync

**Files:**
- Modify: `src/modules/focus/schema.js`, `store.js`, `expand.js`, `sync.js`, `controller.js` (saveList passthrough and its error key), `src/modules/focus/ui/lock-logic.js` (add `'forbidden-folder'` and `'bad-folder'` wording to the helper-error table)
- Test: `tests/focus-schema.test.js`, `focus-store.test.js`, `focus-expand.test.js`, `focus-sync.test.js`, `focus-controller.test.js`

**Interfaces:**
- Consumes: Task 3 `checkEntry('folder', ...)`, `validItem('folder', ...)`.
- Produces: `ListRec.folders: string[]`; `saveList(db, { id?, name, sites, apps, folders? })` (`folders` optional, default `[]`) with `errors.folders` in the same shape as `errors.apps`; `listTargets` returning `{ sites, apps, folders }`; windows carrying `app_folders` (omitted when empty, so existing window ids and vectors are unchanged).

- [ ] **Step 1: Write failing tests.** Schema: v2 database migrates to 3 keeping rows, a `'folder'` item can be inserted afterwards, version row is `'3'`. Store: folders round trip and are listed; an invalid folder gives `errors.folders`; a duplicate is collapsed; the 512 cap counts folders. Expand/sync: a list with a folder produces `app_folders` on the session window, on schedule windows and on the merged locked-block window (union across lists); a window with a forbidden folder is skipped and counted. Controller: `saveList` passes folders through; a helper `bad-window`/`forbidden-folder` rejection maps to the plain wording.
- [ ] **Step 2: Run** `npm test` — expect the new tests to fail.
- [ ] **Step 3: Implement.** `V3` rebuilds `focus_items` because SQLite cannot alter a CHECK: create `focus_items_new` with kind in `('site','app','folder')`, copy rows, drop the old table, rename, set `schema_version` to `'3'`, all in one `db.batch`. `listLists` puts `kind === 'folder'` rows in `folders`. `window` builders add `app_folders` only when non-empty.
- [ ] **Step 4: Run** `npm test` — expect all pass.
- [ ] **Step 5: Commit** `feat(focus): store and sync folders (schema v3)`.

### Task 5: Pickers and list editor

**Files:**
- Modify: `src/shell/native.js`, `src/modules/focus/ui/list-editor.js`, `ui/editor-logic.js`, `src/modules/focus/model.js` (details row), `src/styles.css`
- Test: `tests/focus-editor-logic.test.js`, `tests/focus-ui-dom.test.js`, `tests/focus-model.test.js`

**Interfaces:**
- Consumes: Task 3 `checkEntry('folder', ...)`, Task 4 `controller.saveList({ ..., folders })`.
- Produces: `pickExeFiles(title?: string): Promise<string[] | null>` in `native.js`, alongside the existing `pickFolder(title): Promise<string | null>`; `addEntries(state, 'folder', pieces)` support in `editor-logic.js` (`state` gains `folders`); folder chips with the full path in `title` and the folder name as text.

- [ ] **Step 1: Write failing tests.** Editor logic: `addEntries` with kind `'folder'` adds, collapses duplicates, reports the forbidden message, counts toward the cap; `removeLast`/`canSave` handle folders (a list with only a folder can be saved). DOM test with `window.__TAURI__` stubbed: with `hasNative()` true the editor shows **Browse files…** and **Browse folder…**; picking two `.exe` paths adds two app chips by file name; a cancelled dialog (null) changes nothing; a forbidden folder shows the message; with `hasNative()` false neither button exists. Model test: the Helper details window summary mentions the folder count.
- [ ] **Step 2: Run** `node --test tests/focus-editor-logic.test.js tests/focus-ui-dom.test.js tests/focus-model.test.js` — expect failures.
- [ ] **Step 3: Implement.** `pickExeFiles` calls `T().dialog.open({ multiple: true, title, filters: [{ name: 'Programs', extensions: ['exe'] }] })` and returns an array or null. The editor adds a Folders field (no text input; chips and one button) and a Browse files button beside the Apps input; picked paths go through `addEntries`; failures show in the field's existing error element; dialog exceptions show "Could not open the file dialog. You can still type the program name."; `saveList` receives `folders: state.folders`. Add minimal `.fr-*` styles for the button row.
- [ ] **Step 4: Run** `npm test` — expect all pass.
- [ ] **Step 5: Commit** `feat(focus): browse buttons for programs and folders`.

### Task 6: End to end, screenshots, checklist

**Files:**
- Modify: `tests/focus-locks-e2e.test.js` (or create `tests/focus-folders-e2e.test.js` following its probe and skip pattern), `scripts/focus-steps.mjs`, `docs/superpowers/focus-room-windows-checklist.md` (new section 14), `README.md`
- Test: the e2e file

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the e2e test** against the real helper via stdio (skip only on the existing `bad-request` probe): push a block window with `app_folders: ['C:\\Games\\Foo']`, `GetStatus` shows it in `decision.blockFolders`; pushing `C:\\Windows` is refused with `forbidden-folder`; pushing `C:\\a\\..\\b` is refused with `bad-folder`; a locked window with a folder, re-pushed with a different folder, keeps the original.
- [ ] **Step 2: Run** `cargo build -p focus-helper --features test-clock` then `node --test tests/focus-folders-e2e.test.js` — expect pass.
- [ ] **Step 3: Screenshots.** Extend `scripts/focus-steps.mjs` with a step that stubs `window.__TAURI__.dialog.open` and shows the editor with both Browse buttons, folder chips and the forbidden-folder error; run `node scripts/shot.mjs <dir> --steps scripts/focus-steps.mjs --helper target/debug/focus-helper` in light and `--dark`; expect no console errors and no horizontal overflow.
- [ ] **Step 4: Docs.** Add checklist section 14 with the Windows items from the spec's Testing list; add one README line about folder blocking and its limits (junctions, launchers).
- [ ] **Step 5: Run** `npm test` and `cargo test -p focus-helper`; **Commit** `test(focus-pickers): e2e, screenshots, checklist`.

### Task 7: Partner page Save dialog and Show in folder

Owner decision (2026-11-10): no hosted link and no server. The partner page is saved as a file and sent by the owner; the current `<a download>` button does nothing visible in the desktop window.

**Files:**
- Modify: `src/shell/native.js`, `src/modules/focus/ui/partner-setup.js`, `src-tauri/src/main.rs`
- Test: `tests/focus-ui-dom.test.js` (or a new `tests/focus-partner-setup.test.js`)

**Interfaces:**
- Consumes: existing Tauri commands `write_files(dir: String, files: Vec<FileEntry>)` (`FileEntry { path, bytes }`) and the dialog plugin's `save`.
- Produces: `pickSavePath(defaultName: string, ext: string): Promise<string | null>` and `revealInFolder(path: string): Promise<void>` in `native.js`; a Rust command `reveal_in_folder(path: String) -> Result<(), String>` registered in `generate_handler!` (Windows: spawn `explorer.exe` with the single argument `/select,<path>`; other platforms: return `Err("not supported")`; refuse a path that does not exist).

- [ ] **Step 1: Write failing tests** with `window.__TAURI__` stubbed (`dialog.save` returns `C:\Users\me\Desktop\partner-unlock.html`, `core.invoke` records calls): clicking **Save the partner page** calls `write_files` with dir `C:\Users\me\Desktop` and one file named `partner-unlock.html` whose bytes decode to the partner page, then calls `reveal_in_folder` with the full path, then shows "Saved to C:\Users\me\Desktop\partner-unlock.html. Send this file to your partner (email, WhatsApp, a USB stick). They open it in a browser." A cancelled dialog (null) writes nothing and shows nothing. A failing `write_files` shows "Could not save the page: <reason>. Nothing was sent." With `hasNative()` false the old blob download runs and the same send-it hint is shown.
- [ ] **Step 2: Run** `node --test tests/focus-partner-setup.test.js` — expect failures.
- [ ] **Step 3: Implement** the wrappers and `reveal_in_folder`; split the chosen path at the last `\` or `/` into dir and file name; encode the page with `TextEncoder` into a number array for `bytes`; a reveal failure must not hide the "Saved to" message. Also add a **Copy page text** button only if trivial; otherwise skip (not in scope).
- [ ] **Step 4: Run** `npm test` — expect all pass; the Rust command is covered by the Windows `cargo check` in CI and the checklist.
- [ ] **Step 5: Add to the checklist** (section 14): the Save dialog opens, the file lands where chosen, Explorer opens with it selected, the saved page opens in a browser and works offline. **Commit** `feat(focus): save the partner page with a real dialog`.
