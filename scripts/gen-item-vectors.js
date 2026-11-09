// Generates tests/fixtures/item-vectors.json: site/app entry validity shared with the Rust helper
// (`good_item` in focus-helper/src/lockstore.rs). CI regenerates it and fails on a diff.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validItem } from '../src/modules/focus/limits.js';

const SITES = [
  'example.com', 'a-b.example.org', 'xn--bcher-kva.example', '',
  'a b.com', ' a.com', 'a.com ', 'a\tb', 'a\nb.com', 'evil.com\n127.0.0.1 bank.com',
  'a#b.com', 'a/b.com', 'a\\b.com', 'a\u0000b', 'a\u0007b', 'a\u00a0b', 'a\u0085b', 'a\u2003b',
];
const APPS = [
  'steam.exe', 'League of Legends.exe', 'Spotify (beta).exe', 'my-app_2.exe', 'a.b.exe', 'steam',
  '', '   ', 'a\tb.exe', 'a\nb', 'a\rb', 'a\u0007b', 'a\u00a0b.exe', 'a\u2003b.exe',
  'dir/app.exe', 'dir\\app.exe', 'C:\\Windows\\app.exe', 'c:app.exe', 'app.exe:stream',
];

export function buildItemVectors() {
  return [
    ...SITES.map((value) => ({ kind: 'site', value, valid: validItem('site', value) })),
    ...APPS.map((value) => ({ kind: 'app', value, valid: validItem('app', value) })),
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = new URL('../tests/fixtures/item-vectors.json', import.meta.url);
  writeFileSync(out, JSON.stringify(buildItemVectors(), null, 2) + '\n');
  console.log(`wrote ${fileURLToPath(out)}`);
}
