# Security policy

Zero Trust Translator holds no server, no account and no network access. The
whole extension runs on the admin's own computer. It never sends, syncs or
uploads the list or a key (see the "no network" checks in `README.md`).

## How the list is protected

- `chrome.storage.local` holds the list as AES-256-GCM ciphertext only, with
  a new 12-byte IV on every write. A copy of the Chrome profile without an
  unlock method gives no name.
- One random 256-bit data key encrypts the list. Each unlock method wraps
  that key with AES-GCM:
  - Windows Hello or a security key: a key from the WebAuthn PRF extension,
    through HKDF-SHA-256. The private key never leaves the device. A device
    that cannot give a PRF result is not offered.
  - A password: PBKDF2-SHA-256, 600,000 rounds, a 16-byte salt. At least 12
    characters, and not in the bundled list of common passwords. Five wrong
    passwords in a row stop password unlock for 5 minutes.
  - A recovery code: 160 random bits, shown once.
- The service worker keeps the open data key in `chrome.storage.session`,
  set to trusted contexts only, so a content script cannot read it. Chrome
  keeps that area in memory and clears it when Chrome closes.
- The content script asks the service worker for the names of the markers on
  the page. It gets no key and no name while the list is locked. It draws the
  names inside closed shadow roots, so the page's own script cannot read them.
- Removing an unlock method, adding one, changing the password, a new
  recovery code, an export and "Delete my list" need a check in the last
  5 minutes. The service worker refuses them without one.
- An encrypted backup (`.ztbackup`) holds the list wrapped for the password,
  the recovery code and each security key, never for Windows Hello, which
  works on this PC only. So a backup opens on another computer. A backup keeps the password and the recovery code that
  were set when it was made: after a password change or a new recovery code,
  an older backup still opens with the old password or the old code.
- If every unlock method and the recovery code are lost, the list cannot be
  opened. Nobody, including the maintainers, can recover it.

## The send batch (#3919)

`zt:encryptForSend` (see `README.md`) lets the web app ask the Translator
to encrypt a batch of phone numbers and first names for the walled Lambda
(#3920), without the Translator ever holding a network permission or
calling a server itself.

- The admin must press Allow in a window this extension opens; nothing is
  encrypted before that, and the window shows the page origin (from
  Chrome, so the page cannot forge it), the operation in the page's own
  words, and the matched count, read from the admin's own list.
- The batch (a one-time token, the time, and each matched person's E.164
  phone number and first name) is encrypted with a fresh, random AES-256-GCM
  key. That key is then wrapped with RSA-OAEP-SHA-256 under the walled
  Lambda's public key, pinned by page origin in `src/walled-keys.ts`. Only
  the matching Lambda's private key, which this extension never holds, can
  unwrap it.
- A pinned key is never taken from a page, and no message this extension
  answers can set or replace one: the only way a pinned key changes is a
  new release of this extension. An origin with no pinned key gets
  `{ refused: 'unknown-origin' }`, never a batch encrypted under the wrong
  key or under no key at all.
- Deny, closing the Allow window with no decision, and a locked list all
  refuse before anything is encrypted.

## Reporting a problem

Open an issue in this repository:
<https://github.com/Truertech/zero-trust-translator/issues>.

For a problem that should not be public before a fix ships (a way for the
page to read the name list, a way to open the list without an unlock method,
a way for one computer's list to reach another, or anything that could add a
network path to the extension) email `paulmorrishill@gmail.com` with
"zero-trust-translator security" in the subject, instead of opening a public
issue.

## Supported versions

The newest published release only. There is no separate security-patch
branch: a fix ships as the next tagged release.