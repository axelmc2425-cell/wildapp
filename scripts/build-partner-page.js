// Builds src/modules/focus/partner-unlock.html: a single offline page for the accountability partner.
// The crypto functions are inlined from unlock.js (not copied by hand). Run: node scripts/build-partner-page.js
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PARTNER_PAGE_SOURCE, DEFAULT_TOKEN_TTL_MS } from '../src/modules/focus/unlock.js';

const UI_SCRIPT = `
const $ = (id) => document.getElementById(id);
let keyFile = null;

$('make').addEventListener('click', async () => {
  $('make').disabled = true;
  try {
    const keys = await generatePartnerKeys();
    keyFile = JSON.stringify({ publicKey: keys.publicKey, privateKeyJwk: keys.privateKeyJwk }, null, 2);
    $('pub').value = keys.publicKey;
    $('keyout').hidden = false;
  } catch (e) {
    $('keyerr').textContent = 'Could not create a key: ' + e.message;
  }
  $('make').disabled = false;
});

$('download').addEventListener('click', () => {
  if (!keyFile) return;
  const url = URL.createObjectURL(new Blob([keyFile], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'partner-key.json';
  a.click();
  URL.revokeObjectURL(url);
});

$('keyfile').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  $('loaded').textContent = '';
  keyFile = null;
  if (!f) return;
  try {
    const parsed = JSON.parse(await f.text());
    if (!parsed.privateKeyJwk) throw new Error('no private key in file');
    keyFile = JSON.stringify(parsed);
    $('loaded').textContent = 'Key file loaded.';
  } catch (e) {
    $('loaded').textContent = 'That is not a valid key file.';
  }
});

$('sign').addEventListener('click', async () => {
  $('token').value = '';
  $('signerr').textContent = '';
  if (!keyFile) { $('signerr').textContent = 'Load your key file first.'; return; }
  try {
    const jwk = JSON.parse(keyFile).privateKeyJwk;
    $('token').value = await signUnlock(jwk, $('code').value.trim(), Date.now(), TTL_MS);
  } catch (e) {
    $('signerr').textContent = 'Could not make a token: ' + e.message;
  }
});
`;

const CSS = `
:root { color-scheme: light dark; --bg: #fafafa; --fg: #1b1b1f; --muted: #55555e; --card: #fff; --line: #c9c9d1; --accent: #2750d8; --accent-fg: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #16161a; --fg: #ececf1; --muted: #a8a8b3; --card: #202026; --line: #3d3d47; --accent: #8fa9ff; --accent-fg: #101018; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 38rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.25rem; margin-top: 1.25rem; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.15rem; margin-top: 0; }
p, .hint { color: var(--muted); }
label { display: block; font-weight: 600; margin: 1rem 0 .25rem; }
input, textarea { width: 100%; box-sizing: border-box; padding: .5rem; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; }
textarea { font-family: ui-monospace, monospace; font-size: .85rem; min-height: 5rem; }
button { font: inherit; padding: .5rem 1rem; margin: .75rem .5rem 0 0; color: var(--accent-fg); background: var(--accent); border: 0; border-radius: 6px; cursor: pointer; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.err { color: #c0302b; } @media (prefers-color-scheme: dark) { .err { color: #ff8a84; } }
`;

export function buildPartnerPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Partner unlock</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>Partner unlock</h1>
<p>This page works offline. Nothing you enter here leaves your device.</p>

<section aria-labelledby="s1">
<h2 id="s1">Step 1: Create your key</h2>
<p>Do this once. Send the public key below to the person you are supporting, and keep the key file safe.</p>
<button id="make" type="button">Create my key</button>
<p id="keyerr" class="err" role="alert"></p>
<div id="keyout" hidden>
<label for="pub">Your public key (send this to the owner)</label>
<input id="pub" type="text" readonly>
<button id="download" type="button">Download my key file</button>
</div>
</section>

<section aria-labelledby="s2">
<h2 id="s2">Step 2: Approve an unlock</h2>
<label for="keyfile">Your key file</label>
<input id="keyfile" type="file" accept=".json,application/json">
<p id="loaded" class="hint" role="status"></p>
<label for="code">Challenge code from the owner</label>
<textarea id="code" spellcheck="false" autocomplete="off"></textarea>
<button id="sign" type="button">Make unlock token</button>
<p id="signerr" class="err" role="alert"></p>
<label for="token">Unlock token (send this back; valid for ${DEFAULT_TOKEN_TTL_MS / 60000} minutes)</label>
<textarea id="token" readonly spellcheck="false"></textarea>
</section>
</main>
<script>
const TTL_MS = ${DEFAULT_TOKEN_TTL_MS};
${PARTNER_PAGE_SOURCE}
${UI_SCRIPT}
</script>
</body>
</html>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = fileURLToPath(new URL('../src/modules/focus/partner-unlock.html', import.meta.url));
  writeFileSync(out, buildPartnerPage());
  console.log('wrote', out);
}
