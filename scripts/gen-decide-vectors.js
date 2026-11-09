// Generates tests/fixtures/decide-vectors.json (shared with the Rust helper).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decide, isBlockedSite, isBlockedApp } from '../src/modules/focus/decide.js';

const w = (id, o) => ({
  id, starts: 1000, ends: 2000, lock: 'none', mode: 'block', sites: [], apps: [], ...o,
});
const site = (value) => ({ kind: 'site', value });
const app = (value) => ({ kind: 'app', value });

const CASES = [
  { name: 'no windows', windows: [], now: 1500,
    probes: [site('reddit.com'), app('notepad.exe')] },
  { name: 'invalid and empty probes',
    windows: [w('a', { sites: ['reddit.com'], apps: ['steam.exe'] }), w('b', { mode: 'allow', sites: ['y.com'] })], now: 1500,
    probes: [site(''), site('.'), site('..'), app(''), app('   ')] },
  { name: 'active at starts', windows: [w('a', { sites: ['reddit.com'], apps: ['steam.exe'] })], now: 1000,
    probes: [site('reddit.com'), site('example.com'), app('steam.exe'), app('notepad.exe')] },
  { name: 'inactive at ends', windows: [w('a', { sites: ['reddit.com'], apps: ['steam.exe'] })], now: 2000,
    probes: [site('reddit.com'), app('steam.exe')] },
  { name: 'inactive before starts', windows: [w('a', { sites: ['reddit.com'] })], now: 999,
    probes: [site('reddit.com')] },
  { name: 'subdomain and case', windows: [w('a', { sites: ['reddit.com'] })], now: 1500,
    probes: [site('old.reddit.com'), site('OLD.Reddit.com.'), site('notreddit.com'), site('reddit.com.evil.org')] },
  { name: 'app path and case', windows: [w('a', { apps: ['steam.exe'] })], now: 1500,
    probes: [app('Steam.EXE'), app('C:\\Program Files\\Steam\\steam.exe'), app('steam'), app('steamwebhelper.exe')] },
  { name: 'block wins over allow',
    windows: [w('b', { sites: ['x.com'], apps: ['game.exe'] }),
      w('a', { mode: 'allow', sites: ['x.com', 'y.com'], apps: ['game.exe', 'code.exe'] })], now: 1500,
    probes: [site('x.com'), site('y.com'), site('z.com'), app('game.exe'), app('code.exe'), app('notepad.exe')] },
  { name: 'allow windows union',
    windows: [w('a1', { mode: 'allow', sites: ['a.com'], apps: ['code.exe'] }),
      w('a2', { mode: 'allow', sites: ['b.com'], apps: ['term.exe'] })], now: 1500,
    probes: [site('a.com'), site('sub.b.com'), site('c.com'), app('code.exe'), app('term.exe'), app('notepad.exe')] },
  { name: 'allow with expired window ignored',
    windows: [w('a1', { mode: 'allow', sites: ['a.com'], ends: 1200 }), w('b', { sites: ['x.com'] })], now: 1500,
    probes: [site('a.com'), site('x.com')] },
  { name: 'frozen without allow list',
    windows: [w('f', { lock: 'frozen', ends: 5000 })], now: 1500,
    probes: [app('notepad.exe'), app('explorer.exe'), app('MyBrain.exe'), app('focus-helper.exe'),
      app('System'), app('System Idle Process'), site('example.com')] },
  { name: 'frozen with allow list',
    windows: [w('f', { lock: 'frozen' }), w('a', { mode: 'allow', apps: ['code.exe'], sites: ['docs.rs'] })], now: 1500,
    probes: [app('code.exe'), app('notepad.exe'), app('svchost.exe'), site('docs.rs'), site('example.com')] },
  { name: 'allow list omitting critical apps',
    windows: [w('a', { mode: 'allow', apps: ['code.exe'] })], now: 1500,
    probes: [app('lsass.exe'), app('dwm.exe'), app('msedgewebview2.exe'), app('code.exe'), app('notepad.exe'),
      app('LogonUI.exe'), app('consent.exe'), app('Memory Compression'), app('Secure System'),
      app('MsMpEng.exe'), app('ApplicationFrameHost.exe'), app('TextInputHost.exe'), app('shellhost.exe')] },
  { name: 'critical app listed in block list',
    windows: [w('b', { apps: ['explorer.exe', 'notepad.exe'] })], now: 1500,
    probes: [app('explorer.exe'), app('notepad.exe')] },
  { name: 'locks sorted and unique lists',
    windows: [w('z', { lock: 'locked', ends: 3000, sites: ['b.com', 'a.com'] }),
      w('m', { lock: 'frozen', ends: 4000, sites: ['a.com'], apps: ['b.exe', 'a.exe'] }),
      w('n', { lock: 'none', sites: ['c.com'] })], now: 1500,
    probes: [site('a.com'), site('c.com'), app('a.exe'), app('zzz.exe')] },
];

export function buildVectors() {
  return CASES.map((c) => {
    const decision = decide(c.windows, c.now);
    return {
      name: c.name,
      windows: c.windows,
      now: c.now,
      decision,
      probes: c.probes.map((p) => ({
        kind: p.kind,
        value: p.value,
        blocked: p.kind === 'site' ? isBlockedSite(decision, p.value) : isBlockedApp(decision, p.value),
      })),
    };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = new URL('../tests/fixtures/decide-vectors.json', import.meta.url);
  writeFileSync(out, JSON.stringify(buildVectors(), null, 2) + '\n');
  console.log(`wrote ${fileURLToPath(out)}`);
}
