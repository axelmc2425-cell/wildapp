# MyBrain: design

Date: 2026-11-08. Status: draft, awaiting owner review.

## Purpose

A personal, all-in-one desktop app for one user (the owner), on Windows. It
brings several tools into one place: a linked-notes "Second Brain", a Focus
Room, a Cooking Coach, a Money "what if" Sandbox, a Skill Tree, a Photo/Memory
Vault and an AI Journal Companion.

It is a separate project. Nothing in it lives in, or is built into, the
LifeOS app or its repo.

## Success criteria

- Everything the owner writes stays on their own machine, in one folder they can back up.
- Works fully offline. No account, no server, no network calls unless the owner turns on an optional feature.
- Notes can always be exported as plain `.md` files, so there is no lock-in.
- Installs from a single Windows `.exe` built by CI.
- The logic that matters is plain JavaScript with Node tests that run on Linux CI and in the dev container.

## Scope

In scope for this spec: the shell and the first module, Second Brain.

Out of scope for now: sync, mobile, sharing, multiple users. The other six
modules (Focus Room, Cooking Coach, Money Sandbox, Skill Tree, Photo Vault,
Journal Companion) each get their own spec and plan later, in this order.

## Architecture

- **Shell:** Tauri (Rust), kept thin. It owns the window, file and database access, the global shortcut and the installer.
- **Front end:** plain HTML, JS and CSS. No framework and no build step.
- **Data:** one local SQLite database in the user's app-data folder, plus a sibling attachments folder. All writes are in transactions.
- **Modules:** one folder each. A module declares a name and icon, a screen to render, its own tables, and a search provider. Modules never import each other. They connect through a shared `links` table.
- **Pure logic is separate from UI** and has Node tests. Only the thin Tauri layer needs a real Windows machine to try.
- **Build:** a GitHub Actions workflow builds the Windows installer on every push.

## Shell

- Sidebar: the seven modules (only Second Brain live at first, the others show "coming soon"), Search and Settings.
- Ctrl+K palette: searches every module's data through each module's search provider. Enter opens the result.
- Settings: data folder location, one-click backup and restore (a zip of the database plus attachments), light and dark theme.

## Second Brain

- **Notes:** Markdown with a title and tags, in a split editor and preview. Auto-saves on every pause in typing.
- **Links:** typing `[[` autocompletes note titles. A link to a note that does not exist creates it on click. Each note shows a Backlinks panel.
- **Graph view:** interactive map of notes and links. Click a node to open the note. Filter by tag.
- **Daily note:** one button opens today's note, created from a template.
- **Resurface:** a Related notes panel suggests older notes that share tags or words with the open note. Keyword matching on the device, no AI.
- **Quick capture:** a global shortcut opens a small quick-note window from anywhere in Windows.
- **Import and export:** import a folder of `.md` files (also works for an Obsidian vault). Export all notes back to plain `.md` files.

## Data model

- `notes(id, title, body, created, updated)`
- `tags(note_id, tag)`
- `links(from_type, from_id, to_type, to_id)`: shared by all modules. Backlinks and the graph are queries on this table.

## Error handling

- If a save fails, the editor keeps the text in memory, shows a clear banner and retries.
- A backup is taken automatically before any import.
- Import skips unreadable files and reports which ones, instead of failing the whole import.

## Testing

- Node tests for: link parsing, backlinks, tag filtering, resurface scoring, Markdown import and export, and the database layer against a temporary SQLite file.
- Headless-browser screenshots of the UI in the dev container.
- The Windows `.exe` is built by CI. Window behaviour, the global shortcut and installation are checked by the owner on Windows.
