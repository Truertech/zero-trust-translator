// The deterministic build (issue #3786).
//
//   node scripts/build.mjs          the release build: the matches in
//                                   manifest.json only, no localhost
//   node scripts/build.mjs --dev    adds http://localhost/* to the content
//                                   script matches, for the Playwright
//                                   tests in this repository and in
//                                   Truertech/RestoreMemberEngagement.
//                                   Never upload this build.
//
// `OUT_DIR` (default `dist`) chooses the output folder and the zip name;
// `scripts/build-check.mjs` builds twice into two different `OUT_DIR`s to
// compare them. `SOURCE_DATE_EPOCH` (default `0`) is the one timestamp every
// file in the zip gets; the release workflow sets it from the tagged
// commit, so a rebuild of that tag reproduces the same zip.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { buildDeterministicZip } from './zip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const isDev = process.argv.includes('--dev');
const outDirName = process.env['OUT_DIR'] ?? (isDev ? 'dist-dev' : 'dist');
const outDir = join(ROOT, outDirName);
const sourceDateEpoch = Number(process.env['SOURCE_DATE_EPOCH'] ?? '0');

function bundle(entry, outfile) {
  esbuild.buildSync({
    entryPoints: [join(ROOT, 'src', entry)],
    outfile: join(outDir, outfile),
    bundle: true,
    format: 'iife',
    target: 'chrome120',
    platform: 'browser',
    legalComments: 'none',
    // #3786: never build a bundle that can reach the network. A dropped
    // `fetch`/`XMLHttpRequest` import here would be dead code the bundler
    // keeps; `scripts/check-no-network.mjs` is the real gate, this is belt
    // and braces.
    define: { 'process.env.NODE_ENV': isDev ? '"development"' : '"production"' },
  });
}

function buildManifest() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  if (isDev) {
    manifest.content_scripts[0].matches.push('http://localhost/*');
    manifest.name = `${manifest.name} (dev)`;
    // A fixed test-only key (never the Chrome Web Store signing key), so an
    // unpacked dev build always loads at the same extension id
    // (`tests/fixtures/dev-extension-key.json`). Playwright needs the id to
    // navigate straight to the popup page; this build never ships.
    const { publicKeyBase64 } = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'dev-extension-key.json'), 'utf8'));
    manifest.key = publicKeyBase64;
  }
  return JSON.stringify(manifest, null, 2) + '\n';
}

function main() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  bundle('content.ts', 'content.js');
  bundle('popup.ts', 'popup.js');

  const manifestJson = buildManifest();
  writeFileSync(join(outDir, 'manifest.json'), manifestJson);

  const popupHtml = readFileSync(join(ROOT, 'src', 'popup.html'));
  writeFileSync(join(outDir, 'popup.html'), popupHtml);

  const files = [
    { name: 'content.js', data: readFileSync(join(outDir, 'content.js')) },
    { name: 'manifest.json', data: Buffer.from(manifestJson) },
    { name: 'popup.html', data: popupHtml },
    { name: 'popup.js', data: readFileSync(join(outDir, 'popup.js')) },
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const zip = buildDeterministicZip(files, sourceDateEpoch);
  const zipPath = join(ROOT, `${outDirName}.zip`);
  writeFileSync(zipPath, zip);

  const sha256 = createHash('sha256').update(zip).digest('hex');
  writeFileSync(join(ROOT, `${outDirName}.zip.sha256`), `${sha256}\n`);
  console.log(`Built ${zipPath}`);
  console.log(`SHA-256: ${sha256}`);
}

main();
