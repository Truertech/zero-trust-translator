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

// The dev-only pinned walled key (#3919, `walled-keys.ts`), supplied by the
// RME e2e helper that drives this build. Absent for every other build, dev
// or release: those bundles pin no walled key at all.
const walledDevOrigin = process.env['ZT_WALLED_DEV_ORIGIN'];
const walledDevKeyId = process.env['ZT_WALLED_DEV_KEY_ID'];
const walledDevPublicKey = process.env['ZT_WALLED_DEV_PUBLIC_KEY'];
const walledDevDefine =
  isDev && walledDevOrigin && walledDevKeyId && walledDevPublicKey
    ? { __ZT_DEV_WALLED_KEY__: JSON.stringify(JSON.stringify({ origin: walledDevOrigin, keyId: walledDevKeyId, publicKeySpki: walledDevPublicKey })) }
    : {};

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
    define: { 'process.env.NODE_ENV': isDev ? '"development"' : '"production"', ...walledDevDefine },
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

  bundle('background-main.ts', 'background.js');
  bundle('content.ts', 'content.js');
  bundle('options.ts', 'options.js');
  bundle('popup.ts', 'popup.js');
  bundle('unlock.ts', 'unlock.js');
  bundle('allow.ts', 'allow.js');

  const manifestJson = buildManifest();
  writeFileSync(join(outDir, 'manifest.json'), manifestJson);
  const { version } = JSON.parse(manifestJson);

  const files = [{ name: 'manifest.json', data: Buffer.from(manifestJson) }];
  for (const name of ['background.js', 'content.js', 'options.js', 'popup.js', 'unlock.js', 'allow.js']) {
    files.push({ name, data: readFileSync(join(outDir, name)) });
  }
  // The pages hold the only remote addresses (the source and release
  // links), so `check-no-network.mjs` can refuse every URL in a bundle.
  for (const name of ['options.css', 'options.html', 'popup.css', 'popup.html', 'unlock.html', 'allow.html']) {
    const data = Buffer.from(readFileSync(join(ROOT, 'src', name), 'utf8').replaceAll('__VERSION__', version));
    writeFileSync(join(outDir, name), data);
    files.push({ name, data });
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const zip = buildDeterministicZip(files, sourceDateEpoch);
  const zipPath = join(ROOT, `${outDirName}.zip`);
  writeFileSync(zipPath, zip);

  const sha256 = createHash('sha256').update(zip).digest('hex');
  writeFileSync(join(ROOT, `${outDirName}.zip.sha256`), `${sha256}\n`);
  console.log(`Built ${zipPath}`);
  console.log(`SHA-256: ${sha256}`);
}

main();
