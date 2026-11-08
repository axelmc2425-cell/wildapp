# MyBrain

A personal, offline, all-in-one desktop app for Windows. Your data stays on your computer.

Right now it contains the shell and the first module, **Second Brain** (linked Markdown notes).
Focus Room, Cooking Coach, Money Sandbox, Skill Tree, Photo Vault and Journal Companion are listed
in the sidebar as "coming soon".

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
2. Create two notes and link them with `[[`. Check Backlinks and the Graph tab.
3. Press Ctrl+Alt+N from another app, write a line and press Ctrl+Enter. The note appears in the list.
4. Import a folder of `.md` files, then Export all.
5. Settings → Back up now, change a note, then Restore and reopen the app.
6. Close and reopen: everything is still there.
