# Zero Trust Translator

A Chrome extension for branch admins of a Restore Member Engagement Zero
Trust branch (`Truertech/RestoreMemberEngagement`, issue #3785). In Zero
Trust mode the web app shows a username or an anonymised reference instead
of a real name — for example `Macc3`. This extension shows the real name
instead, read from a list kept on the admin's own computer, and nowhere
else.

## What it does, and does not do

- The content script finds every `data-zt-id` marker on
  `https://rb-branch.org.uk` and `https://rb-branch-staging.org.uk`, and
  draws the matching name from the admin's list over it, including a marker
  the page adds after it has loaded. The name, a shield and a hover box with
  the username sit in a closed shadow root, and a badge at the top right
  says how many names the page shows, or that the list is locked.
- The list is encrypted (issue #3797). `chrome.storage.local` holds only
  ciphertext: AES-256-GCM with a new IV on every write. The data key is
  wrapped once for each way the admin unlocks the list: Windows Hello or a
  security key (WebAuthn with the PRF extension), a password (PBKDF2-SHA-256,
  600,000 rounds), and a recovery code (160 bits). See `SECURITY.md`.
- The service worker holds the open data key in `chrome.storage.session`,
  which Chrome keeps in memory and clears when Chrome closes. The list locks
  when Chrome closes, after the chosen minutes with no activity, when the PC
  locks (a switch on the Security page), and when the admin clicks Lock.
- The content script never gets the data key. It asks the service worker for
  the names of the markers on the page and gets nothing while the list is
  locked.
- The extension's only permissions are `storage` and `idle`. It has no
  `host_permissions`, no network call, no remote font or image, no analytics
  and no `chrome.storage.sync`.
- The popup imports `people.csv` (the #3785 wipe download), a NationBuilder
  Export CSV (matched to usernames by email), an encrypted `.ztbackup` file,
  or any CSV with a `username` or `reference` column. It adds, edits,
  deletes and searches people, and exports an encrypted backup only.
- It does not change what the web app sends or stores.
## Installing it

Once published, install it from the Chrome Web Store listing (the
organisation adds the link here once the listing exists). Until then, or
for a pre-release build, load it unpacked:

```sh
npm ci
npm run build
```

Open `chrome://extensions`, turn on "Developer mode", choose "Load
unpacked", and select the `dist/` folder this prints.

## Building

```sh
npm ci
npm run typecheck
npm test              # vitest: the vault, the service worker, the CSV and NationBuilder import, passwords, the no-network check, the zip writer
npm run build          # the release build -> dist/, dist.zip, dist.zip.sha256
npm run build:check    # builds twice in clean directories and compares the SHA-256
npm run check-no-network   # fails if dist/ can reach the network
npm run test:e2e       # Playwright, against the extension's own fixture page (needs a leased box: see this repository's own CLAUDE.md-equivalent rule against running Playwright on a bare machine if you use the persona fleet)
```

## How the release build is deterministic

`scripts/build.mjs` bundles the service worker, the content script, the
popup, the Security page and the unlock tab with esbuild, copies the pages
and their CSS, writes `manifest.json` (unchanged for a release build), and packs
them with `scripts/zip.mjs` — a zip writer written in this repository that
stores every file uncompressed, so there is no compression codec whose
output could differ between machines. Every file gets the same modification
time, taken from `SOURCE_DATE_EPOCH`. The CI release workflow sets
`SOURCE_DATE_EPOCH` to the tagged commit's own commit time
(`git log -1 --format=%ct`), builds the zip twice in two clean directories,
and fails the release if the two hashes differ.

### Rebuilding a tagged release and checking the hash

```sh
git clone https://github.com/Truertech/zero-trust-translator.git
cd zero-trust-translator
git checkout v<version>
npm ci
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) npm run build
sha256sum dist.zip   # compare with the "dist.zip.sha256" the GitHub release attaches
```

A match proves this exact source produces the exact zip the release
published — the attached `actions/attest-build-provenance` signature
(verify with `gh attestation verify dist.zip --repo Truertech/zero-trust-translator`)
proves CI, not a human's machine, built that zip from that source.

### Checking the package the Chrome Web Store serves against the release zip

```sh
EXTENSION_ID=<the published id>
curl -L -o store.crx \
  "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=120&acceptformat=crx2,crx3&x=id%3D${EXTENSION_ID}%26uc"
mkdir store-unpacked && cd store-unpacked
unzip ../store.crx   # a .crx is a zip with a short binary header; most unzip tools skip the header and read the archive
diff -r . ../dist     # compare file-by-file against the rebuilt release
```

A clean `diff` proves the Chrome Web Store is serving the same files this
repository built and signed, not something uploaded by hand on top of it.

## Development build, for tests only

`npm run build:dev` (or `scripts/build.mjs --dev`) adds
`http://localhost/*` to the content script's matches and gives the
manifest a fixed test-only `key`
(`tests/fixtures/dev-extension-key.json`), so the extension loads at a
known, stable id under test. **Never upload this build anywhere.** The
release workflow never calls it.

## Layout

| Path | What it is |
| --- | --- |
| `manifest.json` | The release manifest (Manifest V3). |
| `src/background.ts`, `src/background-main.ts` | The service worker: holds the data key, answers every request, locks the list. |
| `src/vault.ts`, `src/webauthn.ts` | The encryption, the unlock methods, the backup file, and the WebAuthn PRF calls. |
| `src/content.ts` | Finds markers, draws names and the badge, in closed shadow roots. |
| `src/popup.ts`, `src/popup.html`, `src/popup.css` | Setup, lock and unlock, the list, import, export. |
| `src/options.ts`, `src/options.html`, `src/options.css` | The Security page: unlock methods, locking, recovery, delete. |
| `src/unlock.ts`, `src/unlock.html` | The tab that finishes a Windows Hello or key dialog when the popup closes. |
| `src/csv.ts`, `src/import.ts` | The CSV reader, and the people.csv and NationBuilder import. |
| `src/store.ts`, `src/password.ts` | The list rules, and the password rules. |
| `scripts/build.mjs`, `scripts/zip.mjs` | The deterministic build. |
| `scripts/check-no-network.mjs` | Fails the build on any network API in a script, or a remote URL in a script, a stylesheet or a page. |
| `tests/unit/` | vitest, with a fake `chrome` API for the service worker. |
| `tests/e2e/` | Playwright, against `tests/fixtures/page.html`, the popup and the Security page. |
## Why it is public

So any branch admin, or anyone advising one, can read exactly what the
extension does before trusting it with a list of real names, and can prove
the published package matches this source (see above).
