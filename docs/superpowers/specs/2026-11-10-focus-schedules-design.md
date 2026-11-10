# Focus Room schedules, sub-project 3: recurring schedules

Date: 2026-11-10. Status: draft, awaiting owner review.

Builds on `2026-11-08-focus-room-design.md` (engine, helper), `2026-11-09-focus-room-ui-design.md` (screens), `2026-11-09-focus-locks-design.md` (locked blocks) and `2026-11-10-focus-pickers-design.md`. Order agreed with the owner: pickers (done), schedules, time limits (6b), analytics (6a), uninstall protection (6c).

## Purpose

Let the owner say "block these lists every weekday 9:00 to 17:00" once, and have it happen every week, with the same lock choices as a block.

## What exists already

The engine already has the `focus_schedules` table, `expandSchedule` (weekdays, overnight, DST) and `syncWindows`, which pushes the next 30 days of occurrences to the helper. There is no way to create, edit or see a schedule, no pause, no end date and no unlock delay. This sub-project adds those and the UI. The helper needs no protocol change.

## Owner decisions

- A schedule has a lock choice like a block: None or Locked (Frozen stays unavailable until 4b).
- A locked schedule needs an end date. Every occurrence up to that date is locked; no lock is indefinite. Until the end date it cannot be deleted, shortened or paused in the app.

## Scope

In: schema v4, store functions, pure schedule logic, a Schedules section on the Focus Room home, a schedule editor dialog, running and next-occurrence display, locked-schedule rules, sync wiring, tests, checklist.

Out: frozen schedules (4b), one-off exceptions or skipped days, per-day different times, time limits (6b), calendar import, a schedule on an allow-list.

## Success criteria

- The owner can create a schedule: one or more lists, weekdays, start and end time, lock choice, optional end date (required when locked), optional name.
- An occurrence blocks on time with the app closed (the helper holds the pushed windows), including overnight (22:00 to 06:00) and across a DST change.
- Home shows each schedule (days, times, lists, lock, "Next: Mon 9:00" or "Blocking now") and lets the owner edit, pause or delete an unlocked schedule.
- A locked schedule cannot be edited, paused or deleted in the app before its end date; its occurrences already accepted by the helper follow the existing locked rules (partner code or waiting period to unlock one occurrence, never removed by editing the database).
- A schedule's overlap with a running block or another schedule is fine; the helper merges windows.
- Pure and JS logic are tested; the real helper on Linux holds a pushed locked occurrence; the Windows checklist is extended.

## App changes (JavaScript)

- **Schema v4** (`schema.js`): `focus_schedules` gains `name TEXT NOT NULL DEFAULT ''`, `enabled INTEGER NOT NULL DEFAULT 1`, `ends_on TEXT` (local `YYYY-MM-DD`, inclusive, null means no end), `unlock_delay_ms INTEGER` (null means partner code only) and a link table `focus_schedule_lists(schedule_id, list_id)` so one schedule can cover several lists. Existing rows migrate to one link each. The migration rebuilds once and sets `schema_version` to 4.
- **Pure logic** (`schedule-logic.js`, new): `validateSchedule(input, nowMs, tzOffsetAt)` (at least one list and weekday, `HH:MM` times, start not equal to end, locked requires `ends_on` between 1 day and 90 days ahead and a unlock choice, name at most 60 characters), `describeSchedule(s, listNames)` (text such as "Weekdays, 9:00 to 17:00"), `nextOccurrence(s, nowMs, tzOffsetAt)` (running or next start and end, honoring `ends_on` and `enabled`), `scheduleLockState(s, nowMs, tzOffsetAt)` (is it locked until `ends_on`, and so cannot change).
- **Store** (`store.js`): `listSchedules`, `saveSchedule`, `setScheduleEnabled`, `deleteSchedule`. Each refuses an edit, pause or delete of a locked schedule before `ends_on` (a second check next to the UI one). Deleting a list removes it from schedules; a schedule left with no lists is deleted unless it is locked, in which case the list cannot be deleted (same rule as a locked block holding a list).
- **Expand and sync** (`expand.js`, `sync.js`): `expandSchedule` takes several lists (union of sites, apps, folders, like a locked block), stops at `ends_on` end of day, skips disabled schedules, and sets `unlock_delay_ms` on locked occurrences. The occurrence id stays `c<scheduleId>@<starts>`, so a re-push is the same window. Occurrences are pushed for the next 30 days as today.
- **Home** (`ui/home.js`, `ui/schedule-list.js`, new): a Schedules section below the lists with a New schedule button, one row per schedule with the buttons above, and the live "Blocking now" and next-occurrence text. A locked row shows its end date and a lock note; its buttons are disabled with a title saying why.
- **Editor** (`ui/schedule-editor.js`, `ui/schedule-editor-logic.js`, new): a dialog with the list picker (checkboxes), seven weekday toggles with Weekdays and Every day shortcuts, two time inputs, an optional name, the lock choice reusing the Start dialog wording and unlock-delay selector, and an end-date field (required and prefilled when Locked is chosen). Plain error text beside the field, no alerts.
- Locked-schedule unlock uses the existing Unlock dialog on the running occurrence; unlocking one occurrence does not end the schedule.

## Helper changes (Rust)

None to the protocol. Tests only: an end-to-end test with the real helper on Linux pushes a locked occurrence from an expanded schedule, advances the test clock into it, and checks it is enforced and that a re-push with the row deleted cannot remove it.

## Errors

- Invalid input is shown beside the field and nothing is saved.
- A helper that is down or rejects the push: the schedule is saved and shown "not enforced yet" like a list today; sync retries on the next start and daily.
- More than 1024 windows in 30 days: the existing cap keeps locked and soonest windows; a note in Helper details counts skipped ones.
- A schedule whose list was deleted or became invalid is skipped by sync and shown with a warning.

## Testing

- JS: validation (empty days, same start and end, locked without end date, end date too far, name length), `describeSchedule`, `nextOccurrence` (before, during, overnight, end date, disabled, DST spring-forward and fall-back, Monday and Sunday boundaries), expand with several lists, `ends_on` and `unlock_delay_ms`, schema v3 to v4 migration, store round trip and locked refusals, sync output for a locked schedule, editor logic, DOM tests for the section, row states and editor errors.
- End to end with the real helper (Linux, test clock): as above.
- Screenshots in light and dark: Schedules section with an unlocked and a locked row, the editor, the locked-edit refusal.
- Windows checklist additions: a schedule blocks at its start and stops at its end with the app closed; an overnight schedule; a locked schedule survives reboot and cannot be edited; unlocking one occurrence with the partner code leaves the next week's occurrence blocked.

## Decisions and limits

- Times are the PC's local time zone; a time zone change moves occurrences, and the next sync re-expands them. Locked occurrences already accepted stay at their original instants.
- The helper enforces only the 30 days already pushed. For a locked schedule the app refuses to delete it, but the app database is editable, so occurrences beyond the next sync could be dropped by someone who edits the database; the end date (at most 90 days) caps that exposure. Documented, not handled.
- Allow-list lists work in a schedule exactly as in a block.

## Open items

None.
