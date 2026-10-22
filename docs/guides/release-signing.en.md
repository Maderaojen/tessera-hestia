# Backend release signatures

- Updated: 2026-10-22
- 中文：[release-signing.md](release-signing.md)

Backend bundles carry an RSA/SHA-256 detached signature of `SHA256SUMS`.
The installer verifies `SHA256SUMS.sig` before trusting a checksum, unpacking,
or executing any bundle. There is no unsigned fallback: a release without a
signature, or with one that doesn't verify, stops the installer. Native app
update keys are a separate trust domain and are not reused.

## The release public key

The SHA-256 fingerprint (of the DER form) of the current release public key
(RSA 3072):

```
63decd33da1896e188725c3264e0778b7bcaf32c2d52b3e1ff1b81dfa757084a
```

The key is written in `install.sh` (`EMBEDDED_RELEASE_PUBLIC_KEY`). The
installer uses, in this order:

1. the file `HESTIA_RELEASE_PUBLIC_KEY` names;
2. `$HESTIA_HOME/release-public.pem` (default
   `~/.local/share/hestia/release-public.pem`), when there is one; it says so
   in one line when it isn't the key in `install.sh`;
3. the key in `install.sh`. On a first install, with no key file yet, it is
   saved as `$HESTIA_HOME/release-public.pem` once the release verifies
   (mode 644, in a folder only its owner can write), and later upgrades go by
   that file. Upgrades never change it.

## What the one-line install trusts

The one-line install (`curl -fsSL …/install.sh | sh`) trusts **the
`install.sh` downloaded over HTTPS from GitHub**, with the key written in it.
If the GitHub account or repository is compromised, an attacker can change
the installer and the key together, or have the installer skip every check;
the bundle signatures can't stop that. The release private key is also kept
in GitHub Actions secrets (see "Maintainers"), so a compromised maintainer
GitHub account could also publish a correctly signed release.

What the signatures do stop:

- a bundle or `SHA256SUMS` swapped on the Release's assets or on a mirror
  (`HESTIA_DOWNLOAD_BASE`) alone;
- an upgrade run by an installer that already has its key: the local key
  file, or an installer you kept, doesn't start trusting a new key because a
  new Release carries one.

For a stronger guarantee, don't hand the downloaded script straight to `sh`:

- Download `install.sh`, read it, and check the fingerprint of its key through
  another channel (the `~/.local/share/hestia/release-public.pem` of a machine
  that is already installed, someone you trust):

  ```bash
  sed -n '/-----BEGIN PUBLIC KEY-----/,/-----END PUBLIC KEY-----/p' install.sh \
    | sed "s/^EMBEDDED_RELEASE_PUBLIC_KEY='//; s/'\$//" \
    | openssl pkey -pubin -outform DER | openssl dgst -sha256
  ```

- Or provide the key file yourself: a public key whose fingerprint you checked,
  at `$HESTIA_HOME/release-public.pem` or named by `HESTIA_RELEASE_PUBLIC_KEY`.
- Keep an installer you checked, and upgrade with it
  (`HESTIA_VERSION=vX.Y.Z sh install.sh`).

Signatures authenticate bytes, not freshness: an explicitly selected older
signed version remains installable.

## Rotating the key

The new public key goes into `EMBEDDED_RELEASE_PUBLIC_KEY` in `install.sh`, in
the same commit as the first release signed with the new private key; the
fingerprint in this document changes with it.

Machines that are already installed don't trust the new key on their own:
check the new fingerprint with the current trust root or another independent
channel, explicitly replace the local `release-public.pem` (or
`HESTIA_RELEASE_PUBLIC_KEY`), then upgrade. Never automatically trust a new key
that comes with a bundle or a Release.

## Maintainers: signing and publishing

- The private key is RSA 3072 (`openssl genpkey -algorithm RSA -pkeyopt
  rsa_keygen_bits:3072`), kept outside the repository, readable by its owner
  only, and backed up safely; it never ships.
- Publishing sets `HESTIA_RELEASE_SIGNING_KEY` (the private key) and
  `HESTIA_RELEASE_PUBLIC_KEY` (the public key). Before changing anything, the
  release script checks that both are there, that they are a pair, and that
  the key written in `install.sh` at the commit being published is this one
  (otherwise the installer it publishes couldn't verify its own Release); any
  mismatch stops it.
- The release script puts the key's fingerprint and the one-line install in
  the Release notes.
- Releases are normally published by GitHub Actions: the private key is also
  an Actions secret of the (private) source repository, written to a
  temporary file for the signing step only and removed after it; the public
  key used is taken from `install.sh` at the commit being published. So
  besides this repository, the maintainer's GitHub account is part of what
  you trust (two-factor authentication, tokens scoped to a single
  repository). The maintainer keeps a copy too, to publish from their own
  machine when Actions can't.
- A dry run without keys is for review only: its artifacts are unsigned, and
  the installer won't accept them.
