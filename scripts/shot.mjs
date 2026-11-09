// Headless screenshot harness. Runs src/ in Chromium on top of a real SQLite file.
// Usage: node scripts/shot.mjs <outDir> [--seed] [--steps path/to/steps.mjs] [--dark] [--helper <focus-helper binary>] [--helper-down]
import http from 'node:http';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openNodeDb } from '../src/core/db-node.js';
import { migrate } from '../src/core/schema.js';
import { createStdioCall } from './helper-bridge.mjs';
import { createNote, saveNote } from '../src/modules/secondbrain/notes.js';

const args = process.argv.slice(2);
const outDir = resolve(args[0] || 'shots');
const seed = args.includes('--seed');
const dark = args.includes('--dark');
const stepsIdx = args.indexOf('--steps');
const stepsFile = stepsIdx >= 0 ? resolve(args[stepsIdx + 1]) : null;
const helperIdx = args.indexOf('--helper');
const helperBin = helperIdx >= 0 ? resolve(args[helperIdx + 1]) : null;
let helperDown = args.includes('--helper-down');
const root = join(fileURLToPath(import.meta.url), '..', '..', 'src');

function loadPlaywright() {
  try { return createRequire(import.meta.url)('playwright'); } catch { /* try global */ }
  const g = execSync('npm root -g').toString().trim();
  return createRequire(join(g, 'x.js'))('playwright');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  let p = new URL(req.url, 'http://x').pathname;
  if (p === '/') p = '/index.html';
  try {
    const data = await readFile(join(root, p));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;

await mkdir(outDir, { recursive: true });
const dir = await mkdtemp(join(tmpdir(), 'mybrain-shot-'));
const db = await openNodeDb(join(dir, 'shot.db'));
await migrate(db);

if (seed) {
  const specs = [
    ['Welcome', 'Start here. See [[Projects]] and [[Reading list]]. #meta'],
    ['Projects', 'Active work: [[Garden plan]] and [[Budget]]. #work'],
    ['Garden plan', 'Tomatoes and herbs need sun. Link back to [[Projects]]. #garden #work'],
    ['Budget', 'Monthly budget notes about savings and groceries. #money #work'],
    ['Reading list', 'Books about gardening and money. [[Garden plan]] #books'],
    ['Ideas', 'A tool for planning a vegetable garden with sun maps. #garden #ideas'],
    ['2026-11-08', '# 2026-11-08\n\n## Today\nTalked about [[Budget]].\n'],
    ['Meeting notes', 'Discussed the budget and the garden plan with [[Projects]].'],
  ];
  for (const [title, body] of specs) await createNote(db, { title });
  for (const [title, body] of specs) {
    const n = (await db.all('SELECT id FROM notes WHERE title = ?', [title]))[0];
    await saveNote(db, n.id, { body });
  }
}

const pw = loadPlaywright();
const browser = await pw.chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
const importDir = join(dir, 'to-import');
mkdirSync(importDir);
writeFileSync(join(importDir, 'From folder.md'), '---\ntitle: From folder\ntags: [imported]\n---\nHello from a file. See [[Welcome]].\r\n');
writeFileSync(join(importDir, 'Welcome.md'), 'duplicate of an existing note');
writeFileSync(join(importDir, 'broken.md'), Buffer.from([0xff, 0xfe, 0x80]));
const exportDir = join(dir, 'exported');
mkdirSync(exportDir);
const bridge = helperBin ? createStdioCall(helperBin, join(dir, 'helper-state.json')) : null;
const calls = [];
await page.exposeFunction('__calls', () => calls);
await page.exposeFunction('__db', async (cmd, a) => {
  calls.push(cmd);
  if (cmd === 'data_dir') return dir;
  if (cmd === 'backup_auto') return join(dir, 'auto.zip');
  if (cmd === 'backup_create') return null;
  if (cmd === 'read_folder_md') return readdirSync(a.dir).map(f => ({ path: f, bytes: [...readFileSync(join(a.dir, f))] }));
  if (cmd === 'write_files') { for (const f of a.files) writeFileSync(join(exportDir, f.path), Buffer.from(f.bytes)); return null; }
  if (cmd === 'focus_helper_call') {
    if (!bridge) throw new Error('Focus Room blocking is only available on Windows');
    if (helperDown) throw new Error('The Focus Room helper service is not running');
    return bridge.call(a.request);
  }
  if (cmd === 'db_all') return db.all(a.sql, a.params);
  if (cmd === 'db_run') return db.run(a.sql, a.params);
  if (cmd === 'db_batch') return db.batch(a.stmts);
  throw new Error('unsupported command in harness: ' + cmd);
});
await page.addInitScript(() => {
  window.__TAURI__ = {
    core: { invoke: (cmd, a) => window.__db(cmd, a) },
    dialog: { open: async (o) => (o && o.directory ? (window.__pickDir || null) : null), save: async () => '/tmp/backup.zip' },
  };
});

const shot = async (name) => { await page.screenshot({ path: join(outDir, name + '.png') }); console.log('shot', name); };
try {
  await page.goto(url);
  await page.waitForSelector('#modlist .navitem');
  if (stepsFile) {
    const steps = await import(pathToFileURL(stepsFile).href);
    await steps.default(page, shot, { db, importDir, exportDir, bridge, setHelperDown: (v) => { helperDown = !!v; } });
  } else {
    await shot('home');
    await page.goto(url + '#/settings');
    await shot('settings');
    await page.keyboard.press('Control+k');
    await shot('palette');
  }
} finally {
  if (bridge) await bridge.close();
  await browser.close();
  server.close();
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('no console errors');
