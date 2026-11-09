# MyBrain

A personal, offline, all-in-one desktop app for Windows. Your data stays on your computer.

It is now just the **Focus Room**: a Cold Turkey-style blocker with timed blocks, locked blocks that
only a partner's signed code or a waiting period can end, and a tamper-resistant Windows helper
service. The other modules (Second Brain, Cooking, Money, Skills, Photos, Journal) and the Ctrl+K
search and Ctrl+Alt+N quick capture were removed; they are still in git history before this change.

Settings keeps backup and restore. Design docs: `docs/superpowers/specs/`.

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

## Building the installer locally

The Windows bundle includes the Focus Room helper, which must be staged as
`src-tauri/resources/focus-helper.exe` first (the file is git-ignored; without it `tauri dev` and
`tauri build` fail). On Windows:

```bash
npm run stage:helper && npx tauri dev     # run the app
npm run stage:helper && npx tauri build   # build the installer
```

`stage:helper` runs `cargo build --release -p focus-helper` and copies the result into place.
To try the Focus Room on a real PC, follow `docs/superpowers/focus-room-windows-checklist.md`.

## Focus Room screens

To render the Focus Room screens (first run, lists, running block, helper down, warnings, editor, start dialog, helper details) as PNGs, build the helper and run:

```bash
cargo build --manifest-path focus-helper/Cargo.toml
node scripts/shot.mjs /tmp/focus-shots --helper target/debug/focus-helper --steps scripts/focus-steps.mjs [--dark]
```

## Focus locks

Locked blocks cannot be cancelled in the app; they end at their end time, with a partner token, or after a chosen waiting period (1 hour or longer). The end-to-end tests (`tests/focus-locks-e2e.test.js`) need a helper built with the `test-clock` feature, which lets the tests move the helper's clock. Build it, then run the test:

```bash
cargo build --manifest-path focus-helper/Cargo.toml --features test-clock
node --test tests/focus-locks-e2e.test.js
```

The partner is trust-based: the owner could generate their own key from the same offline page. A locked window the helper holds but the app database lacks (for example after clearing app data) currently has no UI to unlock; locked schedules are skipped until sub-project 3.

Never ship a `test-clock` build. The Windows-only behaviour of locks is checked by section 13 of `docs/superpowers/focus-room-windows-checklist.md`.

## Checklist for trying it on Windows

1. Install it and open MyBrain.
2. Create two notes and link them with `[[`. Check Backlinks and the Graph tab. Then open each other module and try it.
3. Press Ctrl+Alt+N from another app, write a line and press Ctrl+Enter. The note appears in the list.
4. Import a folder of `.md` files, then Export all.
5. Settings → Back up now, change a note, then Restore and reopen the app.
6. Photo Vault: import a few photos (they must show as thumbnails). Delete one.
7. Close and reopen: everything is still there.
