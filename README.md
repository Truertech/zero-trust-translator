# Zero Trust Translator

A Chrome extension for branch admins of a Zero Trust branch. In Zero
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
- The list is encrypted. `chrome.storage.local` holds only
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
- The popup imports `people.csv` (the wipe download), a NationBuilder
  Export CSV (matched by email; an email not in the list adds a new person
  with no username, for the admin to type later), an encrypted `.ztbackup` file,
  or any CSV with a `username` or `reference` column. It adds, edits,
  deletes and searches people, and exports an encrypted backup only.
- It does not change what the web app sends or stores.

## Sending an SMS or an event invite

A Zero Trust branch cannot show a member's phone number or name, so it
cannot send the member a text message itself. The web app asks the
Translator for an encrypted batch instead, and carries that batch to the
walled Lambda — the Translator
never calls a server itself.

- `zt:listCodes` answers with one row per person on the list: a `ref-`
  code, the username, and whether the phone is a valid UK mobile. Never a
  name, a number, an email or an address. A locked list refuses with
  `{ refused: 'locked' }` instead of an empty list, so the page cannot read
  "locked" as "nobody has a phone number".
- A person with no code gets one the first time the list is read, in this
  order: a `ref-` username (a wipe reference) is the code, and
  `zt:listCodes` gives that person an empty username; else the code the
  email last had; else a new code. The vault keeps each email's code after
  the person is deleted, so the same person added again gets the same code.
- Before each `zt:listCodes` and `zt:encryptForSend`, the Translator cleans
  up the codes, with the username as the source of truth. A `ref-` username
  replaces a different code. When two people hold the same code, the person
  whose username is that code keeps it, else the first person in the list
  keeps it, and each other person gets a new code. The clean-up changes
  codes only, never a phone number, so an opt-out (held by number in the
  walled store) still applies to the person.
- A page marker (`data-zt-id`) shows the name when it holds the person's
  username or the person's code.
- `zt:encryptForSend` takes the operation in the page's own words (1 to 80
  characters, for example "Send SMS messages"), the codes to send to and the
  page's own count of people. The Translator is a generic encryption step,
  so it shows no message text. It never encrypts anything before the admin
  presses Allow in a window this extension opens, which shows the page
  origin, the operation wording and the matched count — read from the
  admin's own list, never the page's claim. On Allow it builds a batch of a fresh one-time token, the time,
  and each matched code's phone number (E.164) and first name (a person
  saved with no first and no last name, such as a list from before this
  feature, gets `name` split on the first space when the list is read);
  encrypts the
  batch with a new AES-256-GCM key; and wraps that key with RSA-OAEP-SHA-256
  under the pinned public key for the page's origin (see "Pinned keys"
  below). It answers with the wrapped key, the IV and the ciphertext only —
  nothing in clear reaches the page. Deny, closing the window with no
  decision, a locked list, and an origin with no pinned key all refuse
  before anything is encrypted. A second `zt:encryptForSend` while an Allow
  window is open gets `{ refused: 'busy' }`, and the open window stays.
- A code the page sends that the admin's list does not hold, and a code
  with no valid UK mobile, are left out of the batch and out of the count;
  the admin sees the actual matched count, not the page's count.

### Pinned keys

The Translator will wrap a batch's key only for an origin it has a public
key pinned for. `src/walled-keys.ts` holds the production and staging
public keys once they are published; an unpinned origin (including any
origin not named there) gets `{ refused: 'unknown-origin' }`. The
Translator never takes a key from the page, and no message can set or
replace a pinned key — the only way a pinned key changes is a new release
of this extension. The dev build (`npm run build:dev`) pins a key for
`http://localhost/*` only when `ZT_WALLED_DEV_ORIGIN`, `ZT_WALLED_DEV_KEY_ID`
and `ZT_WALLED_DEV_PUBLIC_KEY` are all set; a release build never reads
those variables at all.

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
npm run build          # the release build -> dist/, zero-trust-translator-<version>.zip and its .sha256
npm run build:check    # builds twice in clean directories and compares the SHA-256
npm run check-no-network   # fails if dist/ can reach the network
npm run test:e2e       # Playwright, against the extension's own fixture page (needs a leased box: see this repository's own CLAUDE.md-equivalent rule against running Playwright on a bare machine if you use the persona fleet)
```

## How a release starts

Every merge to `main` makes a release. When CI passes on the push to `main`,
`.github/workflows/release.yml` runs `scripts/bump-patch.mjs`, which raises
the patch version in `manifest.json` and `package.json`. The workflow commits
that as `chore(release): bump version to <version>`, tags it `v<version>`,
pushes both, and publishes the GitHub release for the tag. A `v*` tag pushed
by hand still makes a release; its version must match `manifest.json`.

If `main` moves on before the release starts, that run makes no release. The
CI run of the newer commit makes it instead.

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
sha256sum zero-trust-translator-<version>.zip   # compare with the .sha256 file the GitHub release attaches
```

A match proves this exact source produces the exact zip the release
published — the attached `actions/attest-build-provenance` signature
(verify with `gh attestation verify zero-trust-translator-<version>.zip --repo Truertech/zero-trust-translator`)
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
