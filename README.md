# MyBrain

A personal, offline, all-in-one desktop app for Windows. Your data stays on your computer.

It has a shell (sidebar, Ctrl+K search across everything, settings, backup) and seven modules:

| Module | What it does |
| --- | --- |
| 🧠 Second Brain | Linked Markdown notes, backlinks, graph, daily note, quick capture, import/export |
| 🎯 Focus Room | Pomodoro timer, ambient noise, one-thing focus, daily goal, keyboard shortcuts, done alerts, session log (finished marks, stopped-early sessions) and streaks |
| 🍳 Cooking Coach | Pantry, recipes, "what can I cook tonight", scaling, timers from steps, macros and cost |
| 💰 Money Sandbox | Monte Carlo what-if simulator (buy a house, change jobs, go part-time) with comparison |
| 🌳 Skill Tree | Skills tree, practice log, levels, spaced-repetition flashcards (SM-2) |
| 🖼️ Photo Vault | Private photo timeline, albums, trip suggestions, on this day |
| 📓 Journal Companion | Daily entries, weekly review, patterns, reflection prompts (all offline, rule-based) |

Everything is stored on this computer and works offline. Design docs: `docs/superpowers/specs/`.

## Second Brain

- Markdown notes with `[[links]]`, `#tags`, backlinks, a related-notes panel and a graph view
- A daily note, global search (Ctrl+K), quick capture from anywhere (Ctrl+Alt+N)
- Import a folder of `.md` files (Obsidian vaults work), export all notes back to `.md`
- One-click backup and restore (Settings)

## Get the app

Every push builds a Windows installer in GitHub Actions: open the latest **build-windows** run,
download the `MyBrain-windows-installer` artifact and run the `.exe`.

## Develop

```bash
npm install
npm test                                        # JavaScript tests (Node 22+)
cargo test --manifest-path core/Cargo.toml      # Rust tests (database, backup, files)
npx tauri dev                                   # run the desktop app (needs Rust + WebView2)
```

Layout: `src/` is the plain HTML/JS front end (no build step), `core/` is the testable Rust logic,
`src-tauri/` is the thin Tauri shell. Design: `docs/superpowers/specs/`, plan: `docs/superpowers/plans/`.

## Checklist for trying it on Windows

1. Install it and open MyBrain.
2. Create two notes and link them with `[[`. Check Backlinks and the Graph tab. Then open each other module and try it.
3. Press Ctrl+Alt+N from another app, write a line and press Ctrl+Enter. The note appears in the list.
4. Import a folder of `.md` files, then Export all.
5. Settings → Back up now, change a note, then Restore and reopen the app.
6. Photo Vault: import a few photos (they must show as thumbnails). Delete one.
7. Close and reopen: everything is still there.
