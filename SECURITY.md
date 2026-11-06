# Security policy

Zero Trust Translator holds no server, no account and no network access. The
whole extension runs on the admin's own computer, reads a list from
`chrome.storage.local`, and draws names into the page. It never sends,
syncs, or uploads that list (see the "no network" checks in `README.md`).

## Reporting a problem

Open an issue in this repository:
<https://github.com/Truertech/zero-trust-translator/issues>.

For a problem that should not be public before a fix ships — a way for the
page to read the name list, a way for one computer's list to reach another,
or anything that could add a network path to the extension — email
`paulmorrishill@gmail.com` with "zero-trust-translator security" in the
subject, instead of opening a public issue.

## Supported versions

The newest published release only. There is no separate security-patch
branch: a fix ships as the next tagged release.
