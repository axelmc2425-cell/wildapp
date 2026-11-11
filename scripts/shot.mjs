// Headless screenshot harness. Runs src/ in Chromium on top of a real SQLite file.
// Usage: node scripts/shot.mjs <outDir> [--steps path/to/steps.mjs] [--dark] [--helper <focus-helper binary>] [--scale 2] [--helper-down]
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

const args = process.argv.slice(2);
const outDir = resolve(args[0] || 'shots');
const dark = args.includes('--dark');
const scaleIdx = args.indexOf('--scale');
const scale = scaleIdx >= 0 ? Number(args[scaleIdx + 1]) || 1 : 1;
const stepsIdx = args.indexOf('--steps');
const stepsFile = stepsIdx >= 0 ? resolve(args[stepsIdx + 1]) : null;
const helperIdx = args.indexOf('--helper');
const helperBin = helperIdx >= 0 ? resolve(args[helperIdx + 1]) : null;
let helperDown = args.includes('--helper-down');
let persistFail = false; // steps can make SetPartner answer persist-failed (after the helper applied it)
let helperDelay = 0; // steps can set this to stall every helper call
let usageTrackingOverride = null; // steps can set this to rewrite Status.usage_tracking in helper replies
let warningsOverride = null; // steps can set this to rewrite Status.warnings in helper replies
const root = join(fileURLToPath(import.meta.url), '..', '..', 'src');

function loadPlaywright() {
  try { return createRequire(import.meta.url)('playwright'); } catch { /* try global */ }
  const g = execSync('npm root -g').toString().trim();
  return createRequire(join(g, 'x.js'))('playwright');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname;
  if (p === '/__abs') {
    try { const want = u.searchParams.get('p') || ''; if (!want.startsWith(tmpdir())) throw new Error('outside the harness temp folder'); const data = await readFile(want); res.writeHead(200, { 'content-type': 'image/png' }); res.end(data); }
    catch { res.writeHead(404); res.end('missing'); }
    return;
  }
  if (p === '/') p = '/index.html';
  try {
    const data = await readFile(join(root, p));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r)); // never expose the harness beyond this machine
const url = `http://localhost:${server.address().port}/`;

await mkdir(outDir, { recursive: true });
const dir = await mkdtemp(join(tmpdir(), 'mybrain-shot-'));
const db = await openNodeDb(join(dir, 'shot.db'));
await migrate(db);

const pw = loadPlaywright();
const browser = await pw.chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: scale });
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
let bridge = null;
const calls = [];
await page.exposeFunction('__calls', () => calls);
await page.exposeFunction('__db', async (cmd, a) => {
  calls.push(cmd);
  if (cmd === 'data_dir') return dir;
  if (cmd === 'photo_import') {
    mkdirSync(join(dir, 'attachments', 'photos'), { recursive: true });
    const { copyFileSync, statSync } = await import('node:fs');
    const imported = a.sources.map(src => { const name = src.split('/').pop(); copyFileSync(src, join(dir, 'attachments', 'photos', name)); return { file: 'photos/' + name, taken_ms: statSync(src).mtimeMs, original: name }; });
    return { imported, skipped: [{ path: 'notes.txt', reason: 'not a supported image' }] };
  }
  if (cmd === 'photo_delete') return null;
  if (cmd === 'backup_auto') return join(dir, 'auto.zip');
  if (cmd === 'backup_create') return null;
  if (cmd === 'read_folder_md') return { files: readdirSync(a.dir).map(f => ({ path: f, bytes: [...readFileSync(join(a.dir, f))] })), skipped: [{ path: 'locked.md', reason: 'Access is denied' }] };
  if (cmd === 'write_files') { for (const f of a.files) writeFileSync(join(exportDir, f.path), Buffer.from(f.bytes)); return null; }
  if (cmd === 'focus_helper_call') {
    if (helperDown) throw new Error('The Focus Room helper service is not running');
    if (!bridge) throw new Error('Focus Room blocking is only available on Windows');
    if (helperDelay > 0) await new Promise(r => setTimeout(r, helperDelay));
    const reply = await bridge.call(a.request);
    if (persistFail && a.request.includes('"SetPartner"')) return JSON.stringify({ type: 'Error', code: 'persist-failed', message: 'disk full' });
    if (warningsOverride || usageTrackingOverride !== null) {
      try {
        const j = JSON.parse(reply);
        if (j && j.type === 'Status') return JSON.stringify({ ...j, ...(warningsOverride ? { warnings: warningsOverride } : {}), ...(usageTrackingOverride !== null ? { usage_tracking: usageTrackingOverride } : {}) });
      } catch { /* not JSON: pass through */ }
    }
    return reply;
  }
  if (cmd === 'db_all') return db.all(a.sql, a.params);
  if (cmd === 'db_run') return db.run(a.sql, a.params);
  if (cmd === 'db_batch') return db.batch(a.stmts);
  throw new Error('unsupported command in harness: ' + cmd);
});
await page.addInitScript(() => {
  window.__TAURI__ = {
    core: { invoke: (cmd, a) => window.__db(cmd, a), convertFileSrc: (p) => '/__abs?p=' + encodeURIComponent(p) },
    dialog: { open: async (o) => (o && o.directory ? (window.__pickDir || null) : (o && o.multiple ? (window.__pickFiles || null) : null)), save: async () => '/tmp/backup.zip' },
  };
});

const shot = async (name) => { await page.screenshot({ path: join(outDir, name + '.png') }); console.log('shot', name); };
try {
  if (helperBin) bridge = createStdioCall(helperBin, join(dir, 'helper-state.json'));
  await page.goto(url);
  await page.waitForSelector('#modlist .navitem');
  if (stepsFile) {
    const steps = await import(pathToFileURL(stepsFile).href);
    await steps.default(page, shot, { db, importDir, exportDir, bridge, setHelperDown: (v) => { helperDown = !!v; }, setPersistFail: (v) => { persistFail = !!v; }, setHelperDelay: (ms) => { helperDelay = Number(ms) || 0; }, advanceHelperClock: async (ms) => { const r = JSON.parse(await bridge.call(JSON.stringify({ type: 'AdvanceClock', ms }))); if (r.type !== 'Ok') throw new Error('AdvanceClock failed: ' + JSON.stringify(r)); }, helperCall: async (req) => JSON.parse(await bridge.call(JSON.stringify(req))), setUsageTracking: (v) => { usageTrackingOverride = v === null ? null : !!v; }, setWarnings: (arr) => { warningsOverride = Array.isArray(arr) ? arr : null; } });
  } else {
    await shot('home');
    await page.goto(url + '#/settings');
    await shot('settings');
  }
} finally {
  if (bridge) await bridge.close();
  await browser.close();
  server.close();
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('no console errors');
