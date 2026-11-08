# MyBrain Shell + Second Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MyBrain Windows desktop shell and its first module, Second Brain (linked Markdown notes, backlinks, graph, daily note, resurface, quick capture, import/export, backup).

**Architecture:** Thin Tauri v2 shell in Rust exposing SQLite (rusqlite) through three commands. Everything else is plain ES-module JavaScript with no build step: pure logic in `src/core` and `src/modules/secondbrain`, tested with `node --test` against a Node SQLite adapter that implements the same `Db` interface as the Tauri one. Modules register themselves with the shell and never import each other.

**Tech Stack:** Tauri v2, rusqlite, vanilla JS (ES modules), `node:sqlite` + `node --test`, vendored `marked`, GitHub Actions (Windows build).

**Spec:** `docs/superpowers/specs/2026-11-08-mybrain-design.md`

## Global Constraints

- Windows desktop app, separate repo; nothing from or into the LifeOS repo.
- No framework, no front-end build step; `window.__TAURI__` via `withGlobalTauri: true`.
- All data in one SQLite database in the app-data folder plus a sibling `attachments/` folder; every multi-statement write is one atomic transaction.
- Offline only: no network calls anywhere in this plan.
- Notes must always be exportable to plain `.md` files.
- Pure logic has Node tests (Node 22+, `node --test`); only the Tauri layer needs a real Windows machine.
- Schema: `notes(id, title, body, created, updated)`, `tags(note_id, tag)`, `links(from_type, from_id, to_type, to_id)`.
- Seven modules in the sidebar; only Second Brain is live, the others show "coming soon".

## Review Focus

1. Titles are case-insensitive: `[[foo]]` links to an existing note "Foo"; creating "FOO" when "Foo" exists is refused. (Task 4)
2. A note containing raw HTML such as `<script>alert(1)</script>` shows as text in the preview and never runs. (Task 9)
3. Deleting a note removes its links both ways; notes that linked to it show the link as "create on click", not an error. (Task 4)
4. Import survives CRLF files, front matter, a non-UTF8 file (skipped and reported) and two files with the same title (second gets " (2)"). (Task 7)
5. Graph and Related panel work on an empty database, a one-note database and a note that links to itself. (Tasks 5, 6)

---

### Task 1: Scaffold, test runner and CI

**Files:**
- Create: `package.json`, `.gitignore`, `src/index.html`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/capabilities/default.json`, `.github/workflows/ci.yml`, `tests/smoke.test.js`

**Interfaces:**
- Produces: `npm test` runs `node --test tests/`; Tauri window loads `src/index.html` with `withGlobalTauri: true`.

- [ ] **Step 1: Write `tests/smoke.test.js`** asserting `typeof require('node:sqlite').DatabaseSync === 'function'`.
- [ ] **Step 2: Create `package.json`** (`"type": "module"`, script `"test": "node --test tests/"`) and the Tauri v2 skeleton (`frontendDist: "../src"`, one window titled "MyBrain", product name `MyBrain`, identifier `app.mybrain.desktop`).
- [ ] **Step 3: Run `npm test`.** Expected: PASS.
- [ ] **Step 4: Add `ci.yml`**: on push, run `npm test` on ubuntu with Node 22.
- [ ] **Step 5: Commit** `chore: scaffold tauri app, tests and ci`.

### Task 2: Database layer and schema

**Files:**
- Create: `src/core/db.js`, `src/core/db-node.js`, `src/core/db-tauri.js`, `src/core/schema.js`, `tests/db.test.js`
- Create (Rust): `src-tauri/src/db.rs`; Modify: `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: the `Db` interface used by every later task:
  - `db.all(sql: string, params?: any[]) => Promise<object[]>`
  - `db.run(sql: string, params?: any[]) => Promise<{ lastInsertId: number, changes: number }>`
  - `db.batch(stmts: { sql: string, params?: any[] }[]) => Promise<void>` (atomic; all or nothing; `last_insert_rowid()` usable between statements)
  - `openNodeDb(path: string) => Promise<Db>` (db-node.js), `openTauriDb() => Promise<Db>` (db-tauri.js, calls Rust commands `db_all`, `db_run`, `db_batch`)
  - `migrate(db: Db) => Promise<void>` (schema.js), uses `PRAGMA user_version`; creates `notes`, `tags`, `links`, unique index on `lower(title)`, index on `links(to_type, to_id)`.

- [ ] **Step 1: Write tests** in `tests/db.test.js` against a temp-file Node db: `migrate creates tables`, `migrate is idempotent when run twice`, `batch rolls back everything when one statement fails` (second statement invalid → first insert absent), `run returns lastInsertId`.
- [ ] **Step 2: Run** `node --test tests/db.test.js`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** `db-node.js` with `node:sqlite` `DatabaseSync` (batch = `BEGIN` / `COMMIT`, `ROLLBACK` on error), `schema.js` and `db.js` (re-exports + `createDb()` choosing the Tauri adapter when `window.__TAURI__` exists).
- [ ] **Step 4: Implement the Rust side**: `db.rs` holding `Mutex<rusqlite::Connection>` opened at `<app_data_dir>/mybrain.db` (bundled SQLite), commands `db_all`, `db_run`, `db_batch` (batch inside one transaction); register in `main.rs`.
- [ ] **Step 5: Run** `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: sqlite layer with node and tauri adapters`.

### Task 3: Note text parsing

**Files:**
- Create: `src/modules/secondbrain/parse.js`, `tests/parse.test.js`

**Interfaces:**
- Produces:
  - `extractLinks(body: string) => string[]` — titles inside `[[...]]`, trimmed, de-duplicated case-insensitively, `[[Title|alias]]` yields `Title`, empty `[[]]` ignored, links inside fenced code blocks ignored.
  - `extractTags(body: string) => string[]` — `#word` tags (letters, digits, `-`, `_`, `/`), lowercase, de-duplicated, not matching `#` inside code blocks or URLs.

- [ ] **Step 1: Write failing tests**: `extractLinks("see [[Foo]] and [[foo|x]] and [[ ]]")` equals `["Foo"]`; `extractLinks("```\n[[Hidden]]\n```")` equals `[]`; `extractTags("#Idea and https://x.com/#frag and #a/b")` equals `["idea","a/b"]`.
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement. Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat: parse links and tags from note text`.

### Task 4: Notes repository and backlinks

**Files:**
- Create: `src/modules/secondbrain/notes.js`, `tests/notes.test.js`

**Interfaces:**
- Consumes: `Db`, `migrate` (Task 2); `extractLinks`, `extractTags` (Task 3).
- Produces (all take `db` first):
  - `createNote(db, { title: string, body?: string }) => Promise<Note>` — throws `Error("duplicate title")` when `lower(title)` exists; then re-resolves links of notes whose body mentions the new title.
  - `saveNote(db, id: number, { title?: string, body?: string }) => Promise<Note>` — one `batch`: update row and `updated`, rewrite `tags` rows, rewrite this note's `links` rows with `from_type='note'` for titles that resolve (case-insensitive); unresolved titles get no row.
  - `getNote(db, id) => Promise<Note|null>`, `findNoteByTitle(db, title) => Promise<Note|null>` (case-insensitive), `listNotes(db, { tag?: string }) => Promise<Note[]>` (newest `updated` first), `deleteNote(db, id) => Promise<void>` (removes the note, its tags, and links in both directions).
  - `backlinks(db, id) => Promise<Note[]>`, `unresolvedLinks(body: string, db) => Promise<string[]>` (titles in the body with no note).
  - `Note = { id, title, body, created, updated, tags: string[] }`

- [ ] **Step 1: Write failing tests**: `createNote rejects a title that differs only by case`; `saving a note linking [[Foo]] creates a backlink on Foo`; `link is case-insensitive`; `creating "Bar" later links notes that already mention [[Bar]]`; `deleteNote removes links both ways and leaves unresolvedLinks reporting the title`; `listNotes filters by tag`; `saving with an invalid title leaves the old row intact` (batch atomicity).
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement** (timestamps are `Date.now()`; renaming does not rewrite other notes' bodies). **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat: notes repository with links, tags and backlinks`.

### Task 5: Search and resurface

**Files:**
- Create: `src/core/search.js`, `src/modules/secondbrain/resurface.js`, `tests/search.test.js`, `tests/resurface.test.js`

**Interfaces:**
- Consumes: `Db`; `Note` (Task 4).
- Produces:
  - `registerSearchProvider(name: string, fn: (db: Db, q: string) => Promise<SearchHit[]>) => void`
  - `searchAll(db: Db, q: string) => Promise<SearchHit[]>` — merges providers, title matches first, max 30; empty query returns `[]`.
  - `SearchHit = { module: string, id: number, title: string, snippet: string }`
  - `notesSearchProvider(db, q) => Promise<SearchHit[]>` (title/body LIKE, wildcards in `q` escaped).
  - `relatedNotes(current: Note, others: Note[], limit = 5) => { note: Note, score: number }[]` — score = 3 × shared tags + shared distinctive words (lowercase, ≥4 letters, stop-words removed); excludes `current`, score 0 dropped, ties newest first.

- [ ] **Step 1: Write failing tests**: `searchAll puts title matches before body matches`; `a query of "%" matches only a literal percent sign`; `empty query returns []`; `relatedNotes ranks shared tags above shared words`; `relatedNotes on a one-note list returns []`; `relatedNotes ignores the current note and self-links`.
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement. Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat: global search and related-note scoring`.

### Task 6: Graph data and layout

**Files:**
- Create: `src/modules/secondbrain/graph.js`, `tests/graph.test.js`

**Interfaces:**
- Consumes: `Db` (Task 2).
- Produces:
  - `graphData(db: Db, { tag?: string }) => Promise<{ nodes: {id:number,title:string,tags:string[]}[], edges: {from:number,to:number}[] }>` — only notes with the tag when filtered; edges only between included nodes; self-links dropped.
  - `layoutGraph(nodes, edges, { width: number, height: number, iterations?: number }) => Map<number, {x:number,y:number}>` — deterministic force layout (seeded start positions), all points inside the box.

- [ ] **Step 1: Write failing tests**: `empty database gives empty nodes and a layout of size 0`; `self-link produces no edge`; `tag filter drops edges to excluded notes`; `layout is deterministic for the same input`; `every point is within width and height`; `single node is centered`.
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement. Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat: graph data and force layout`.

### Task 7: Daily note and Markdown import/export

**Files:**
- Create: `src/modules/secondbrain/daily.js`, `src/modules/secondbrain/importexport.js`, `tests/daily.test.js`, `tests/importexport.test.js`

**Interfaces:**
- Consumes: `createNote`, `findNoteByTitle`, `listNotes` (Task 4).
- Produces:
  - `dailyTitle(d: Date) => string` (local date, `YYYY-MM-DD`); `openDailyNote(db, d = new Date()) => Promise<Note>` — finds or creates with template `# {date}\n\n## Today\n\n## Notes\n`.
  - `parseMarkdownFiles(files: { path: string, bytes: Uint8Array }[]) => { notes: { title: string, body: string }[], skipped: { path: string, reason: string }[] }` — strict UTF-8 decode (invalid → skipped, reason `"not UTF-8"`), CRLF → LF, YAML front matter `title:` and `tags:` honoured (tags appended as `#tag` line), else title = file name without `.md`, folders ignored, duplicate titles within the batch get `" (2)"`, `" (3)"`.
  - `importNotes(db, files) => Promise<{ created: number, skipped: {path:string,reason:string}[] }>` — skips titles that already exist in the db with reason `"already exists"`.
  - `exportNotes(notes: Note[]) => { path: string, text: string }[]` — file name from title with `\/:*?"<>|` replaced by `-`, collisions suffixed `" (2)"`, round-trips through `parseMarkdownFiles`.

- [ ] **Step 1: Write failing tests**: `openDailyNote called twice returns the same note`; `dailyTitle uses local date`; `CRLF file imports with LF body`; `front matter title and tags are used`; `a non-UTF8 file is skipped and reported`; `two files titled Ideas become Ideas and Ideas (2)`; `export then import round-trips titles and bodies`; `export file names never contain reserved characters`.
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement. Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat: daily note and markdown import/export`.

### Task 8: Shell UI

**Files:**
- Create: `scripts/shot.mjs`, `src/main.js`, `src/styles.css`, `src/shell/modules.js`, `src/shell/palette.js`, `src/shell/settings.js`, `src/shell/theme.js`, `tests/modules.test.js`; Modify: `src/index.html`

**Interfaces:**
- Consumes: `createDb`, `migrate` (Task 2); `searchAll`, `registerSearchProvider` (Task 5).
- Produces:
  - `registerModule(def: { id: string, name: string, icon: string, ready: boolean, render: (root: HTMLElement, ctx: { db: Db, open: (moduleId: string, itemId?: number) => void }) => void | (() => void), searchProvider?: Function }) => void`; `listModules() => def[]`.
  - Seven module stubs registered (`secondbrain` ready; `focus`, `cooking`, `money`, `skills`, `photos`, `journal` with `ready: false` rendering "Coming soon").
  - Sidebar, hash router (`#/secondbrain`, `#/settings`), Ctrl+K palette (arrow keys, Enter opens `open(module, id)`, Esc closes), light/dark theme saved in `localStorage` key `theme`, settings page with backup/restore buttons wired in Task 11.

- [ ] **Step 1: Write `tests/modules.test.js`**: `listModules returns seven modules in order`; `only secondbrain is ready`; `registering a duplicate id throws`.
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement the registry; then the UI files.** **Step 4: Run, verify PASS.**
- [ ] **Step 5: Screenshot check:** write `scripts/shot.mjs` (`node scripts/shot.mjs <outDir> [--seed]`): serves `src/` statically, opens it in the preinstalled Playwright Chromium at 1280×800, and injects a `window.__TAURI__.core.invoke` stub that forwards `db_all`/`db_run`/`db_batch` to `openNodeDb` on a temp file (via `page.exposeFunction`), so the page runs on real SQL; `--seed` first inserts 8 linked, tagged notes with `createNote`/`saveNote`. Capture both themes; confirm sidebar, palette and theme toggle render. Expected: no console errors.
- [ ] **Step 6: Commit** `feat: shell with sidebar, router, palette and theme`.

### Task 9: Second Brain screen (editor)

**Files:**
- Create: `src/modules/secondbrain/index.js`, `src/modules/secondbrain/editor.js`, `src/modules/secondbrain/preview.js`, `src/vendor/marked.min.js`, `tests/preview.test.js`

**Interfaces:**
- Consumes: Tasks 3–5, 7; `registerModule` (Task 8).
- Produces:
  - `renderPreview(body: string, resolvedTitles: Set<string>) => string` — HTML: Markdown rendered with `marked`, raw HTML in the source escaped, `[[Title]]` shown as a link (class `wikilink`, class `missing` when not in `resolvedTitles`, compared case-insensitively).
  - Second Brain screen: note list with tag filter and search box, split editor/preview, tag chips, Backlinks panel, Related panel (via `relatedNotes`), "Today" button (`openDailyNote`), "New note", delete with confirm. Typing `[[` opens an autocomplete of note titles. Clicking a `missing` link creates the note and opens it.
  - Auto-save: 600 ms after the last keystroke calls `saveNote`; on failure keeps the text, shows banner "Couldn't save — retrying", retries every 3 s until success.

- [ ] **Step 1: Write failing tests** for `renderPreview`: `<script>alert(1)</script>` output contains `&lt;script&gt;` and no `<script`; `[[Foo]]` with set `{"foo"}` has class `wikilink` and not `missing`; `[[Nope]]` has `missing`.
- [ ] **Step 2: Run, verify FAIL. Step 3: Implement `preview.js`; vendor `marked`; build the screen.** **Step 4: Run, verify PASS.**
- [ ] **Step 5: Screenshot check** with `node scripts/shot.mjs <outDir> --seed`: editor, preview, backlinks and related panels visible. Expected: no console errors.
- [ ] **Step 6: Commit** `feat: second brain editor with autosave, backlinks and related notes`.

### Task 10: Graph view and tag filter UI

**Files:**
- Create: `src/modules/secondbrain/graph-view.js`; Modify: `src/modules/secondbrain/index.js`

**Interfaces:**
- Consumes: `graphData`, `layoutGraph` (Task 6).
- Produces: a "Graph" tab in the Second Brain screen drawing nodes and edges on a `<canvas>` (node radius grows with link count), tag dropdown calling `graphData({tag})`, click on a node opens that note, hover shows its title, "No notes yet" message on an empty database.

- [ ] **Step 1: Implement** the canvas view using `layoutGraph` sized to the canvas, with hit-testing by distance to node centers.
- [ ] **Step 2: Screenshot check** with `node scripts/shot.mjs <outDir> --seed`: 8 notes and a tag filter. Expected: all nodes visible, no console errors, empty-state text with zero notes.
- [ ] **Step 3: Commit** `feat: interactive note graph`.

### Task 11: Native features (backup, folder import/export, quick capture)

**Files:**
- Create: `src-tauri/src/backup.rs`, `src-tauri/src/files.rs`, `src/quick/quick.html`, `src/quick/quick.js`; Modify: `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`, `src/shell/settings.js`, `src/modules/secondbrain/index.js`

**Interfaces:**
- Consumes: `importNotes`, `exportNotes` (Task 7); settings page (Task 8).
- Produces Rust commands: `backup_create(dest: String)` (zip of `mybrain.db` plus `attachments/`, taken after checkpointing the database), `backup_restore(src: String)` (writes a safety zip of the current data next to the app-data folder first, then replaces), `read_folder_md(dir: String) -> Vec<{path, bytes}>` (recursive `.md` files), `write_files(dir: String, files: Vec<{path, bytes}>)`.
- Settings page: Backup now, Restore, shows the data folder path. Second Brain menu: "Import folder…", "Export all…". **An automatic `backup_create` runs before every import.**
- Quick capture: global shortcut `Ctrl+Alt+N` (tauri-plugin-global-shortcut) opens a small always-on-top window `quick.html`; Ctrl+Enter saves a new note titled by timestamp `Quick YYYY-MM-DD HH:mm` and closes the window; Esc closes without saving.

- [ ] **Step 1: Implement the four Rust commands** with a `cargo test` in `backup.rs` that creates a temp folder, backs up, changes data, restores and asserts the original file contents are back.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml`. Expected: PASS (install Rust in the container if absent).
- [ ] **Step 3: Wire the UI** (settings buttons, import/export menu, quick window).
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: backup, folder import/export and quick capture`.

### Task 12: Windows build and owner checklist

**Files:**
- Create: `.github/workflows/build.yml`, `README.md`

**Interfaces:**
- Produces: on every push, a Windows job runs `npm test`, then `tauri build`, and uploads the `.exe`/`.msi` installer as a workflow artifact.

- [ ] **Step 1: Write `build.yml`** (windows-latest, Node 22, stable Rust, `tauri-apps/tauri-action` without release publishing).
- [ ] **Step 2: Write `README.md`**: what the app is, `npm test`, where the installer artifact is, and the owner's manual checklist: install; create two notes and link them with `[[`; see Backlinks and the graph; press `Ctrl+Alt+N` from another app and save a quick note; import a folder of `.md` files; back up and restore; close and reopen and confirm everything is still there.
- [ ] **Step 3: Push and confirm the Windows workflow is green** via the GitHub MCP tools (`actions_list`, `get_job_logs` on failure) and fix any failure.
- [ ] **Step 4: Commit** `ci: windows installer build and readme`.
