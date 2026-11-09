// Builds the Focus Room helper (release) and stages it where the Tauri bundle expects it:
// src-tauri/resources/focus-helper.exe. Run via `npm run stage:helper` before `tauri dev/build`.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Source (cargo output) and destination (Tauri resource) for a Node `process.platform` value. */
export function helperPaths(platform) {
  const built = platform === 'win32' ? 'focus-helper.exe' : 'focus-helper';
  return {
    source: join('target', 'release', built),
    destination: join('src-tauri', 'resources', 'focus-helper.exe'),
  };
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const run = spawnSync('cargo', ['build', '--release', '-p', 'focus-helper'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (run.status !== 0) process.exit(run.status ?? 1);
  const { source, destination } = helperPaths(process.platform);
  mkdirSync(join(root, 'src-tauri', 'resources'), { recursive: true });
  copyFileSync(join(root, source), join(root, destination));
  console.log(`staged ${destination}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
