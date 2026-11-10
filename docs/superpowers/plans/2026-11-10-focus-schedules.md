# Focus Room recurring schedules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner create, edit, pause and delete recurring block schedules (with an optional or, when locked, mandatory end date) from the Focus Room home.

**Architecture:** The engine already expands schedules into helper windows (`expandSchedule`, `syncWindows`). This adds schema v4 (name, enabled, `ends_on`, unlock delay, a schedule-to-lists link table), store and pure logic, controller methods on the single write queue, a Schedules section and editor dialog, and running locked occurrences exposed as block-shaped objects so the existing Unlock dialog works. No helper protocol change.

**Tech Stack:** Vanilla JS ES modules, SQLite via `db.all/run/batch`, `node:test`, Rust helper (test only).

**Spec:** `docs/superpowers/specs/2026-11-10-focus-schedules-design.md`

## Global Constraints

- Locked schedule: `ends_on` required, between 1 and 90 days ahead of creation (local `YYYY-MM-DD`, inclusive); unlock choice required (`unlock_delay_ms` 1 h to 7 days via `validateUnlockDelay`; reuse the Start dialog's delay selector, so locked schedules always carry a delay).
- A locked schedule cannot be edited, paused or deleted before `ends_on` has passed, in the UI and in the store.
- Lock choices: `'none'` or `'locked'` only (Frozen stays unavailable).
- Name at most 60 characters; at least one list and one weekday (0=Sunday..6); times `HH:MM`; start not equal to end; overnight allowed (end <= start means next day).
- Occurrence window id stays `'c' + scheduleId + '@' + starts`; horizon 30 days; `MAX_WINDOWS = 1024`.
- Times are the PC's local zone via the injected `tzOffsetAt`.
- No helper protocol change; no new dependencies.
- Plain error text beside fields, no `alert()`. Dialog and chip styling reuse existing `fr-*` classes in `src/styles.css`.

## Review Focus

- A schedule whose end is exactly midnight or that crosses a DST change still starts and ends at the right wall-clock time (tested in Tasks 1 and 3).
- A locked schedule whose list is edited or deleted from the list editor (Task 2 refuses; Task 5 shows the reason).
- Deleting a list that an unlocked schedule uses removes it from that schedule, and a schedule left with no lists disappears (Task 2).
- A schedule with `ends_on` in the past, or `enabled = 0`, pushes no windows and shows as "Ended"/"Paused" (Tasks 1, 3).
- Helper down when saving: saved, shown "not enforced yet", re-sync later (Task 4).

---

### Task 1: Pure schedule logic and expand

**Files:**
- Create: `src/modules/focus/schedule-logic.js`
- Modify: `src/modules/focus/expand.js` (`localDayEnd`; `expandSchedule` rewritten to the contract below)
- Test: `tests/focus-schedule-logic.test.js`, `tests/focus-expand.test.js`

**Interfaces:**
- Consumes: `tzOffsetAt: (utcMs:number) => minutesEastOfUtc`; `expandSchedule` from `expand.js`, which this task rewrites to the `ScheduleRec` model (contract under Task 3's Produces).
- Produces:
  - `validateSchedule(input: {name,listIds,weekdays,start,end,lock,unlockDelayMs,endsOn}, nowMs, tzOffsetAt): { ok: true, value: ScheduleInput } | { ok: false, errors: { name?, listIds?, weekdays?, times?, endsOn?, unlock? } }`
  - `describeSchedule(s: ScheduleRec, listNames: string[]): string` (e.g. `"Weekdays, 9:00 AM to 5:00 PM"`; `"Every day"`, `"Mon, Wed"`, `"overnight"` suffix when end <= start)
  - `nextOccurrence(s: ScheduleRec, nowMs, tzOffsetAt): { state: 'running'|'upcoming'|'paused'|'ended', starts?: number, ends?: number }`
  - `isLockedActive(s: {lock, endsOn}, nowMs, tzOffsetAt): boolean` (locked and `nowMs < localDayEnd(endsOn)`)
  - `scheduleBlocks(schedules: ScheduleRec[], listsById: Map<number,{name:string}>, nowMs, tzOffsetAt): Block[]` — one block per running LOCKED occurrence, shape `{ key: 'c<id>@<starts>', windowId: 'c<id>@<starts>', lock:'locked', unlockDelayMs, ids: [], listIds, listNames, starts, ends, state:'running', progress, scheduleId }`
- [ ] **Step 1:** Add `export function localDayEnd(endsOn, tzOffsetAt)` to `expand.js` (instant of 00:00 local on the day after `endsOn`, via the existing `wallToUtc`); test in `tests/focus-expand.test.js` for zone offsets 0 and `-300` and a DST-gap midnight.
- [ ] **Step 2: Write failing tests** `tests/focus-schedule-logic.test.js`: validation errors (no lists, no weekdays, start equals end, bad `HH:MM`, name 61 chars, locked without `endsOn`, locked with `endsOn` today or 91 days ahead, locked with delay below 1 h); `describeSchedule` for weekdays/every day/overnight; `nextOccurrence` before, during, overnight (23:00 to 06:00 with now at 02:00 Tuesday is running from Monday), after `endsOn` is `ended`, `enabled:false` is `paused`; DST spring-forward day; `scheduleBlocks` returns one block with the expected `key`, empty when unlocked or not running.
- [ ] **Step 2b: Write failing expand tests** in `tests/focus-expand.test.js` for the contract under Task 3 (move the contract's behaviors here): two lists union items; `enabled:false` gives `[]`; `endsOn` yesterday gives `[]`; `endsOn` today keeps an overnight occurrence that starts that day whole and drops the next day's; locked occurrence carries `unlock_delay_ms`; ids stable across two calls; existing schedule tests updated to the new signature.
- [ ] **Step 3: Run** `node --test tests/focus-schedule-logic.test.js tests/focus-expand.test.js` — expect FAIL.
- [ ] **Step 4: Rewrite `expandSchedule` in `expand.js` to the contract, then implement** the five functions in `schedule-logic.js`, delegating occurrence math to `expandSchedule` (call it with the schedule's lists as one union target, horizon 2 days, from `nowMs - 1 day`) so there is one source of truth.
- [ ] **Step 5: Run** the schedule-logic and expand tests — expect PASS.
- [ ] **Step 6: Commit** `feat(focus): pure schedule logic and expand`.

---

### Task 2: Schema v4 and schedule store

**Files:**
- Modify: `src/modules/focus/schema.js` (add `V4`, bump migration)
- Modify: `src/modules/focus/store.js` (schedule functions; list edit/delete refusals)
- Test: `tests/focus-schema.test.js`, `tests/focus-store.test.js` (extend)

**Interfaces:**
- Produces:
  - `typedef ScheduleRec = { id: number, name: string, listIds: number[], weekdays: number[], start: string, end: string, lock: 'none'|'locked', unlockDelayMs: number|null, endsOn: string|null, enabled: boolean }`
  - `listSchedules(db): Promise<ScheduleRec[]>` (ordered by id)
  - `saveSchedule(db, input: Omit<ScheduleRec,'id'|'enabled'> & { id?: number }, nowMs: number, tzOffsetAt): Promise<{ok:true,id:number}|{ok:false,errors:Record<string,string>}>` (validates via Task 2's `validateSchedule`; refuses an edit of a locked schedule before its end)
  - `setScheduleEnabled(db, id: number, enabled: boolean, nowMs, tzOffsetAt): Promise<{ok:true}|{ok:false,reason:'locked'|'missing'}>`
  - `deleteSchedule(db, id: number, nowMs, tzOffsetAt): Promise<{ok:true}|{ok:false,reason:'locked'|'missing'}>`
  - `scheduleHoldsList(db, listId: number, nowMs, tzOffsetAt): Promise<number|null>` (end instant of a still-active locked schedule using the list, else null)
- Consumes: `validateSchedule`, `isLockedActive` from `schedule-logic.js` (Task 1).

- [ ] **Step 1: Write failing tests** in `tests/focus-schema.test.js`: v3 database with one `focus_schedules` row (weekdays `"[1,2]"`, `09:00`, `17:00`, lock `none`, list 5) migrates to v4; `schema_version` is `'4'`; the row has `name ''`, `enabled 1`, `ends_on NULL`, `unlock_delay_ms NULL`; `focus_schedule_lists` holds `(scheduleId, 5)`; running `migrateFocus` twice changes nothing.
- [ ] **Step 2: Run** `node --test tests/focus-schema.test.js` — expect FAIL (version still 3).
- [ ] **Step 3: Implement `V4` in `schema.js`:** `ALTER TABLE focus_schedules ADD COLUMN` for `name TEXT NOT NULL DEFAULT ''`, `enabled INTEGER NOT NULL DEFAULT 1`, `ends_on TEXT`, `unlock_delay_ms INTEGER`; `CREATE TABLE IF NOT EXISTS focus_schedule_lists(schedule_id INTEGER NOT NULL, list_id INTEGER NOT NULL, PRIMARY KEY(schedule_id, list_id))`; `INSERT INTO focus_schedule_lists SELECT id, list_id FROM focus_schedules`; keep the legacy `list_id` column (SQLite cannot drop cheaply; new rows write the first list id). Add the `version < 4` block mirroring v3, setting `'4'`.
- [ ] **Step 4: Run** the schema test — expect PASS.
- [ ] **Step 5: Write failing store tests** in `tests/focus-store.test.js` (inject `tzOffsetAt = () => 0`, `now = Date.UTC(2026,10,10,12)`):
  - `saveSchedule` creates a row and `listSchedules` round-trips it (weekdays sorted and deduped, times kept, `enabled` true).
  - `saveSchedule` with `lock:'locked'` and no `endsOn` returns `errors.endsOn`; with `endsOn` 91 days ahead returns `errors.endsOn`.
  - Editing, `setScheduleEnabled(false)` and `deleteSchedule` of a locked schedule whose `endsOn` is tomorrow return `{ok:false, reason:'locked'}` (edit returns `errors.name` text "That schedule is locked until <endsOn>."); after `now` passes `endsOn` end they succeed.
  - `saveList` on a list used by an active locked schedule returns `{ok:false, errors:{name:'That list is part of a locked schedule.'}, lockedUntil}`; `deleteList` returns `{ok:false, reason:'running'}` for the same.
  - `deleteList` of a list used by an unlocked schedule with another list removes only the link; with it as the only list, the schedule is deleted.
- [ ] **Step 6: Run** `node --test tests/focus-store.test.js` — expect FAIL.
- [ ] **Step 7: Implement the store functions** above in `store.js`. Read rows with `focus_schedules` joined to `focus_schedule_lists`; write with `db.batch`. Locked check uses `isLockedActive` (Task 2). `saveList`/`deleteList` call `scheduleHoldsList`.
- [ ] **Step 8: Run** `node --test tests/focus-store.test.js tests/focus-schema.test.js` — expect PASS.
- [ ] **Step 9: Commit** `feat(focus): schedules schema v4 and store`.

---

### Task 3: Sync reads the new schedule model

**Files:**
- Modify: `src/modules/focus/sync.js` (read schedules through `listSchedules`, pass `byId`, count schedules with no live list as skipped)
- Test: `tests/focus-sync.test.js`

**Interfaces:**
- Consumes: `expandSchedule` (Task 1, implemented and tested there) with this contract: `expandSchedule(schedule: ScheduleRec, listsById: Map<number, List>, fromMs, horizonMs, tzOffsetAt): Window[]` — unions sites/apps/folders over `schedule.listIds` (missing lists ignored; none left means `[]`), returns `[]` when `!schedule.enabled`, drops occurrences with `starts >= localDayEnd(endsOn)` and clips none otherwise, sets `unlock_delay_ms` when `lock === 'locked'`, mode: `'block'` (all lists are block mode). Keeps the id `'c'+id+'@'+starts`.
- Produces: `syncWindows` unchanged in signature; it now reads schedules from the v4 tables.
- [ ] **Step 1: Write failing sync test:** with a v4 database holding one unlocked and one locked schedule, `syncWindows` pushes the expected windows (use the existing fake client in `tests/focus-sync.test.js`); a schedule whose only list was deleted is counted in `skipped`.
- [ ] **Step 2: Run** `node --test tests/focus-sync.test.js` — expect FAIL.
- [ ] **Step 3: Implement** in `syncWindows`: load schedules through `listSchedules(db)` (Task 2), pass `byId` to `expandSchedule`, count a schedule with no live list as skipped; existing sync tests updated to the v4 rows.
- [ ] **Step 4: Run** `node --test tests/focus-*.test.js` — expect PASS.
- [ ] **Step 5: Commit** `feat(focus): sync reads the new schedule model`.

---

### Task 4: Controller wiring and running-occurrence unlock

**Files:**
- Modify: `src/modules/focus/controller.js`
- Modify: `src/modules/focus/lock-logic.js` (`windowIdForBlock`)
- Test: `tests/focus-controller.test.js`, `tests/focus-lock-logic.test.js`

**Interfaces:**
- Produces on the controller: `saveSchedule(input)`, `setScheduleEnabled(id, enabled)`, `deleteSchedule(id)` — each `enqueue`d, reload, `changed()`, then `doResync()` (same pattern as `deleteList`), returning the store result plus `{ ok:true }`; failures keep `{ ok:false, errors|reason, message? }`. `state.schedules: ScheduleRec[]`; `state.blocks` becomes `groupSessions(...)` followed by `scheduleBlocks(...)` (sorted by `ends`); `findLiveBlock` also finds schedule blocks by `key`. `windowIdForBlock(block)` returns `block.windowId` when set, else the existing `'b'...` id.
- Consumes: Task 1 store functions, Task 2 `scheduleBlocks`.
- [ ] **Step 1: Write failing tests:** save then `state.schedules` shows it and the fake client received a push with its windows; a locked schedule's running occurrence appears in `state.blocks` with `windowId` `c<id>@<starts>` and `requestPartnerChallenge(key)` calls `client.requestChallenge('c<id>@<starts>')`; `extendBlock` and `cancelBlock` on a schedule block return `{ok:false, message}` ("Edit the schedule instead." / "A locked block cannot be cancelled. Use Unlock early."); helper-down save returns ok and sets `syncPending`; `windowIdForBlock` unit tests for both shapes; reconcile does not touch schedule blocks.
- [ ] **Step 2: Run** `node --test tests/focus-controller.test.js tests/focus-lock-logic.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the methods and the state/`findLiveBlock` changes; add `schedules` to `reload()`.
- [ ] **Step 4: Run** the focus controller, lock-logic and `node --test tests/focus-*.test.js` — expect PASS.
- [ ] **Step 5: Commit** `feat(focus): controller schedules and occurrence unlock`.

---

### Task 5: Schedules section and editor UI

**Files:**
- Create: `src/modules/focus/ui/schedule-editor-logic.js`, `src/modules/focus/ui/schedule-editor.js`, `src/modules/focus/ui/schedule-list.js`
- Modify: `src/modules/focus/ui/home.js` (render the section; hide Extend and Cancel on schedule blocks), `src/modules/focus/index.js` (pass `openScheduleEditor`), `src/styles.css`
- Test: `tests/focus-schedule-editor-logic.test.js`, `tests/focus-ui-dom.test.js` (extend)

**Interfaces:**
- Produces:
  - `schedule-editor-logic.js`: `initialDraft(schedule?: ScheduleRec, lists): Draft`; `toggleWeekday(draft, d)`; `applyPreset(draft, 'weekdays'|'every-day')`; `draftToInput(draft, nowMs, tzOffsetAt)` → `validateSchedule` result with errors keyed by field; default `endsOn` when switching to Locked = today + 28 days; `lockNote(draft)` warning text reusing `lockedWarning(delayHours)` from `lock-logic.js`.
  - `openScheduleEditor({ controller, schedule, onDone }): { close() }` dialog (`openDialog` from `ui/dialog.js`): list checkboxes, seven weekday toggles plus Weekdays and Every day buttons, two `type="time"` inputs, optional name, lock choice (Normal / Locked) with the delay selector from the Start dialog (`UNLOCK_DELAY_PRESETS_H`, `resolveDelayHours`), `endsOn` date input (required when Locked), errors in `.fr-err[role=alert]` beside each field; Locked requires the helper (same `HELPER_REQUIRED` message as the Start dialog); Save calls `controller.saveSchedule`.
  - `schedule-list.js`: `renderSchedules(state, { nowMs, tzOffsetAt, openEditor, controller, confirm }): HTMLElement` — one row per schedule with `describeSchedule`, list names, lock note and end date, status text from `nextOccurrence` ("Blocking now until 5:00 PM", "Next: Mon 9:00 AM", "Paused", "Ended"), buttons Edit / Pause|Resume / Delete (`data-fk="sched-edit-<id>"` etc.), disabled with a title when `isLockedActive`; empty state "No schedules yet" with a New schedule button (`data-fk="new-schedule"`, disabled when there are no lists).
- Consumes: controller methods and `state.schedules` (Task 4); `describeSchedule`, `nextOccurrence`, `isLockedActive` (Task 2).
- [ ] **Step 1: Write failing tests:** editor-logic (defaults, weekday toggle and presets, Locked prefills `endsOn` and delay, error mapping per field, `draftToInput` returns the exact `saveSchedule` payload); DOM tests with the fake controller used in `tests/focus-ui-dom.test.js`: section lists rows with the expected text, locked row has disabled Edit/Pause/Delete with a title, New schedule opens the editor, editor shows `endsOn` required error when Locked and empty, Save with valid input calls `controller.saveSchedule` once, schedule block cards show Unlock but no Extend or Cancel.
- [ ] **Step 2: Run** `node --test tests/focus-schedule-editor-logic.test.js tests/focus-ui-dom.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the three UI files, the `home.js` section (below the lists; `data-fk` hooks as above) and `index.js` wiring; minimal CSS reusing `.fr-list`, `.fr-chips`, `.fr-chip`, `.fr-actions`, plus `.fr-days` for the weekday toggles with light and dark variables.
- [ ] **Step 4: Run** `node --test tests/focus-*.test.js` — expect PASS.
- [ ] **Step 5: Commit** `feat(focus): schedules section and editor`.

---

### Task 6: End to end, screenshots, checklist

**Files:**
- Create: `tests/focus-schedules-e2e.test.js`
- Modify: the screenshot script used by `tests/focus-ui-e2e.test.js` / `focus-steps.mjs` (add schedule scenes), `docs/superpowers/focus-room-windows-checklist.md` (new section 15)

**Interfaces:** Consumes everything above; real helper binary built with `--features test-clock` (tests skip without it, like the existing e2e files).
- [ ] **Step 1: Write the e2e test** (pattern of `tests/focus-locks-e2e.test.js`): create a locked schedule through the controller with the real helper, `AdvanceClock` into an occurrence, assert the status window is held and enforced; delete the schedule row directly in the database, resync, assert the already-pushed occurrence is still held; unlock one occurrence with a partner token and assert the next day's occurrence is still pushed.
- [ ] **Step 2: Run** it with a test-clock helper (`cargo build -p focus-helper --features test-clock`, then `node --test tests/focus-schedules-e2e.test.js`) — expect PASS (skips if no binary).
- [ ] **Step 3: Screenshot scenes** (light and dark): Schedules section with an unlocked and a locked row, the editor (Locked with end date), the locked-edit refusal; view them and fix visible defects.
- [ ] **Step 4: Checklist section 15:** schedule blocks at start and stops at end with the app closed; overnight schedule; locked schedule survives reboot and its Edit/Pause/Delete stay disabled; unlocking one occurrence with the partner code leaves the next occurrence blocked; pausing an unlocked schedule stops the next occurrence.
- [ ] **Step 5: Final verify:** `npm test` (expect 0 fail), `cargo test -p focus-helper`, then commit `test(focus): schedules e2e, screenshots, checklist`.
