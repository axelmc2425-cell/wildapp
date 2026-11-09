// Builds src/modules/focus/partner-unlock.html: a single offline page for the accountability partner.
// The crypto functions are inlined from unlock.js (not copied by hand). Run: node scripts/build-partner-page.js
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPartnerPage } from '../src/modules/focus/partner-page.js';

export { buildPartnerPage };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = fileURLToPath(new URL('../src/modules/focus/partner-unlock.html', import.meta.url));
  writeFileSync(out, buildPartnerPage());
  console.log('wrote', out);
}
