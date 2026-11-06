// Fails the build if the bundle can reach the network (issue #3786). Run as
// `node scripts/check-no-network.mjs <dir>`. Scans every `.js` file under
// `<dir>` for the network APIs and for a remote URL: the content.js and
// popup.js bundles, which are the only files this extension executes.
// `manifest.json` (whose `matches` field names the app's own origins by
// design) is read, not run, so it is not scanned.
//
// #3797: the `.css` and `.html` pages are scanned for a remote URL too, so
// no remote font, image, stylesheet or script gets in. The one remote
// address a page may hold is the `href` of an `<a>` link (the source and
// release links), which the browser follows only when the admin clicks it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const FORBIDDEN_TOKENS = ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'importScripts'];
// A remote URL in the bundle text. `localhost`/`127.0.0.1` are not remote,
// so the dev-build content script match and any test fixture are allowed.
const REMOTE_URL = /https?:\/\/(?!localhost|127\.0\.0\.1)[^\s"'`)]+/;
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html']);
const ANCHOR_TAG = /<a\s[^>]*>/gi;

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (SCANNED_EXTENSIONS.has(extname(full))) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node scripts/check-no-network.mjs <dir>');
    process.exit(1);
  }
  const problems = [];
  for (const file of collectFiles(dir)) {
    const raw = readFileSync(file, 'utf8');
    const isPage = extname(file) === '.html';
    const text = isPage ? raw.replace(ANCHOR_TAG, '<a>') : raw;
    for (const token of isPage || extname(file) === '.css' ? [] : FORBIDDEN_TOKENS) {
      if (text.includes(token)) {
        problems.push(`${file}: contains "${token}"`);
      }
    }
    const remoteMatch = text.match(REMOTE_URL);
    if (remoteMatch) {
      problems.push(`${file}: contains a remote URL "${remoteMatch[0]}"`);
    }
  }
  if (problems.length > 0) {
    console.error('The bundle has network access:');
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    process.exit(1);
  }
  console.log(`No network access found under ${dir}.`);
}

main();
