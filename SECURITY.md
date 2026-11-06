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