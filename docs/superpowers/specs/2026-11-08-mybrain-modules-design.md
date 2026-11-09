# MyBrain: the six remaining modules

Date: 2026-11-08. Status: approved by the owner as "do all of them without stopping" (no per-module review).
Builds on `2026-11-08-mybrain-design.md`: same shell, same `Db` interface, same rules (local-first, offline, no
network calls, pure logic in plain JS with Node tests, thin UI). Each module is a folder in `src/modules/<id>/`
with pure logic, a repository over its own tables, a UI `index.js` that registers it, and a search provider.
Tables come from numbered migrations in `src/core/schema.js` (v3..v8).

## Focus Room (`focus`)
Pomodoro timer (work, short break, long break after 4; lengths configurable), a "one thing" field, ambient sound
generated in the browser (white, brown, rain-like noise; no audio files), a session log, stats (today, last 7 days,
streak). Pure: `timer.js` (state machine driven by timestamps so it survives sleep/throttling), `stats.js`.
Table `focus_sessions`; shared `settings` key/value table.

## Cooking Coach (`cooking`)
Pantry list, recipes (ingredients with quantity and unit, steps, servings, macros and cost per serving).
"What can I cook tonight" ranks recipes by how much of them the pantry covers and lists what is missing.
Scale a recipe to any servings. Cooking timers pulled from step text ("simmer 10 minutes") and named manual timers.
Cost and macros per meal. Pure: `cooking.js`. Tables `pantry`, `recipes`. No barcode or photo scanning (needs the network).

## Money Sandbox (`money`)
What-if simulator for big decisions (buy a house, change jobs, go part-time, or any custom scenario). The owner enters
starting numbers by hand (MyBrain holds no bank data). Seeded Monte Carlo over market returns and income changes gives
percentile bands per year and the probability of reaching a goal by a horizon; scenarios are compared with a baseline.
Pure: `montecarlo.js` (seeded RNG, deterministic). Table `scenarios`.

## Skill Tree (`skills`)
Skills in a tree (parent/child), a practice log in minutes, levels from total hours, flashcards per skill with SM-2
spaced repetition and a daily review session. Pure: `sm2.js`, `levels.js`. Tables `skills`, `practice`, `cards`.

## Photo Vault (`photos`)
Import photos by copying them into the app's data folder (`attachments/photos/`); nothing is uploaded. Timeline by
month, "on this day" from earlier years, albums, and suggested trip albums from clusters of days with photos
(a gap of 3+ days starts a new trip). Taken date is the file's modified time. Included in backups. Pure: `timeline.js`.
Rust (`core/src/photos.rs`): `import_photos`, `delete_photo_file`. Tables `albums`, `photos`.

## Journal Companion (`journal`)
One entry per day (mood 1-5, energy 1-5, sleep hours, free text, tags). A weekly reflection with the numbers, patterns
found on the device (best/worst weekday, sleep vs mood, words that show up on high or low mood days, streaks), and
reflection prompts chosen from the week's data. Fully rule-based and offline; a "copy my week" button produces a text
summary the owner can paste anywhere. No AI service is called (the optional AI chat from the idea list is deferred
because it needs the network). Pure: `patterns.js`. Table `journal`.

## Cross-cutting
- Every module registers a search provider so Ctrl+K searches it; results open `#/<module>/<id>`.
- Each stub in `src/shell/builtin.js` is removed when its module ships; all seven end up `ready: true`.
- Backup/restore already covers the database and `attachments/` (so photos).
- Tests: every pure function and repository has Node tests; UIs are checked with the screenshot harness.
