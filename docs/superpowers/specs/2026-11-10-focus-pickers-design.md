# Focus Room pickers, sub-project 5a: file and folder pickers

Date: 2026-11-10. Status: draft, awaiting owner review.

Builds on `2026-11-08-focus-room-design.md` (engine, helper) and
`2026-11-09-focus-room-ui-design.md` (screens). Read those first.

Order agreed with the owner: 5a pickers, then recurring schedules (sub-project 3), then daily and weekly time limits. Each gets its own spec, plan and merge.

## Purpose

Stop typing exact `.exe` names. A Browse button opens a real Windows dialog. Picking a file adds that program to a list. Picking a folder blocks anything running from inside that folder, including programs added to it later.

## Owner decisions

- Browse files adds programs by file name, as typing does today.
- Browse folder blocks every program whose path is inside the folder.
- Folders are a separate third kind of item, not mixed into apps.

## Scope

In: a Browse files button and a Browse folder button in the list editor (desktop app only), a `folders` item kind end to end (database, store, sync, window merge, locked blocks), helper path matching, helper refusal of dangerous folders, tests, checklist.

Out: allow-list folders (lists are always block mode), blocking by publisher or command line, browsing for websites, typing folder paths by hand.

## Success criteria

- In the desktop app the owner can add programs by browsing and never has to type an `.exe`.
- A blocked folder stops every program started from inside it, and does not stop one in a sibling folder with a similar name (`C:\Games` does not match `C:\GamesX`).
- A folder that would break Windows (a drive root, the Windows folder, Program Files itself, the Users folder, the helper's install folder) is refused by the helper, not only by the app.
- A process whose path cannot be read is never killed.
- Editing the app database cannot weaken a lock already accepted by the helper (unchanged rule: the helper's copy of a locked window wins).
- The pure and Rust logic is covered by tests; the real dialog and kill-by-path are on the manual Windows checklist.

## App changes (JavaScript)

- **Picker wrappers** (`src/shell/native.js`): `pickExeFiles()` (multi-select, filter `exe`, returns paths or null) and the existing `pickFolder(title)`. Both only exist when `hasNative()`.
- **List editor** (`ui/list-editor.js`): the Apps field gets a **Browse files…** button. A new **Folders** field shows folder chips (full path in the chip title, folder name as text) with a **Browse folder…** button. Neither button is shown when `hasNative()` is false. Folders cannot be typed, only picked.
- **Entries** (`entry.js`): file picks reuse `checkEntry('app', path)`, which already reduces a Windows path to the file name. `checkEntry('folder', path)` accepts only an absolute Windows path (`X:\...`), normalizes it (backslashes, no trailing slash, no `.` or `..` segments), and refuses the forbidden folders below with a plain message. Duplicate and invalid picks use the existing inline error.
- **Limits** (`limits.js`): `validItem('folder', value)` and the shared forbidden-folder check; folders count toward `MAX_ITEMS`.
- **Schema v3** (`schema.js`): the item `kind` check allows `'folder'`. The migration rebuilds the table once, leaves existing rows alone and sets `focus_meta.schema_version` to 3.
- **Store** (`store.js`): `ListRec` gains `folders`; `saveList` takes and validates `folders`.
- **Expand and sync** (`expand.js`, `sync.js`): `listTargets` returns `{sites, apps, folders}`; the window carries `app_folders`; the locked-block merge unions folders like apps. A window with a bad folder is skipped by sync, like a bad site or app.
- **Details row**: Helper details shows the folder count in the window summary where it shows sites and apps.

## Helper changes (Rust)

- `Window` gains `app_folders: Vec<String>` (`#[serde(default, skip_serializing_if = "Vec::is_empty")]`). The state version is bumped; a missing field means none.
- **Validation on push** (the app is not trusted): each folder must be an absolute path with a drive letter, contain no control characters, no `..` segment and no wildcard. It must not be a drive root, `C:\Windows` and below it, `C:\Program Files` or `C:\Program Files (x86)` themselves (a program's own subfolder is allowed), the Users folder itself, or the helper's install folder. A bad folder is `bad-window` with reason `bad-folder`; a forbidden one is `forbidden-folder`. Folders count toward `MAX_ITEMS_PER_WINDOW`.
- **Decision**: `Decision` gains `block_folders` (deduplicated, normalized, sorted). Block mode only; an allow-mode window with folders ignores them.
- **Process table**: `Proc` gains `path: Option<String>`. The Windows table fills it from the process image path (`sysinfo` exe path) and leaves `None` when it cannot be read.
- **Matching** (`decide.rs`): `is_blocked_path(d, path)` normalizes both sides (ASCII-lowercase, `/` to `\`, no trailing `\`) and returns true only when the path equals the folder or starts with the folder followed by `\`. A path that is `None` never matches.
- **Enforcement** (`enforce.rs`): a process is killed if blocked by name, by path, or as a VPN app, and the existing guards (self pid, pid 0 and 4, `CRITICAL_APPS`, unreadable names) still apply first. `any_window_active` also counts `block_folders`.
- **Locked windows**: a locked window's folders are part of its accepted items. A push that changes items of an accepted locked window is "same window, items ignored", as for sites and apps.

## Errors

- Helper down or rejecting: the list is saved, shown as not enforced yet, as today.
- A refused folder is rejected in the app before saving, with the reason in plain words ("That folder is part of Windows and can't be blocked."). If the helper still refuses it, the existing bad-item warning shows it.
- Dialog cancelled: nothing changes. Dialog failure: a short message, typing still works for files.

## Testing

- JS: folder normalization and the forbidden list, entry checks, `validItem('folder')`, schema v2 to v3 migration, store round trip, expand and sync carry folders, locked-block merge, editor logic, DOM test for the buttons shown and hidden by `hasNative()`.
- Rust: validation vectors shared with JS where practical, path matching boundaries (`C:\Games` vs `C:\GamesX`, case, slashes, trailing slash, `None` path), decision merge, enforcement with a fake process table that has paths, state version bump with an old state file, locked-window items-ignored rule.
- End to end with the real helper (Linux, fake paths): push a window with a folder, status shows `block_folders`, a forbidden folder is refused.
- Screenshots in light and dark: list editor with both Browse buttons and folder chips, forbidden-folder error.
- Windows checklist additions: the file dialog opens and filters to `.exe`; the folder dialog adds a chip; a program started from a blocked folder is killed; a program from `C:\GamesX` is not; a program installed into the folder afterwards is killed; a forbidden folder is refused; a locked block with a folder survives a reboot.

## Decisions and limits

- Path matching uses the process's image path, so a launcher outside the folder that starts a game inside it is blocked only once the game process itself starts. Processes that load files from the folder but run elsewhere are not covered.
- Junctions and symlinks: matching uses the path Windows reports for the running image; a folder reached through a junction may not match. Documented, not handled.
- Network drives and other users' processes the helper cannot open are skipped, never killed.
- The forbidden list is a safety floor, not a full protection list; the never-kill list still guards critical programs.

## Open items

None.
