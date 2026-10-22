# Backend release signatures

- Updated: 2026-10-18
- 中文：[release-signing.md](release-signing.md)

Backend bundles require an RSA/SHA-256 detached signature of `SHA256SUMS`.
The installer verifies `SHA256SUMS.sig` before trusting a checksum, unpacking,
or executing any bundle. There is no unsigned fallback. Native app update keys
are a separate trust domain and are not reused.

## Initial provisioning (required before the next release)

No production backend release public key was present in this repository during
this migration. This change does not generate a production key or publish a
release. An operator must perform the following bootstrap:

1. On a protected signing machine, create and securely back up an RSA private
   key of at least 3072 bits, for example with `umask 077; openssl genpkey -algorithm RSA
   -pkeyopt rsa_keygen_bits:3072 -out release-private.pem`. Keep it outside the
   repository and restrict its permissions. Never ship the private key.
2. Export the public key using `openssl pkey -in release-private.pem -pubout
   -out release-public.pem`. Record its SHA-256 fingerprint over the DER public
   key (`openssl pkey -pubin -in release-public.pem -outform DER | openssl
   dgst -sha256`) in an independently authenticated channel. Have a second
   operator verify the fingerprint.
3. Provision that public key on installer machines at
   `$HESTIA_HOME/release-public.pem` (default
   `~/.local/share/hestia/release-public.pem`), or supply an existing trusted
   local path with `HESTIA_RELEASE_PUBLIC_KEY`. It must not be fetched from the
   release alongside its signature. Store it in a directory writable only by
   its owner. Upgrades leave this trust root outside `app/` and retain it.
4. Set `HESTIA_RELEASE_SIGNING_KEY` to the protected private-key path and
   `HESTIA_RELEASE_PUBLIC_KEY` to the independently checked public-key path
   when running `scripts/release-public.sh`. Publishing fails without both;
   a dry run without keys produces review artifacts only, which the new
   installer intentionally rejects. A mismatched pair fails verification.
5. Publish the first signed release and distribute the trusted installer and
   public-key fingerprint through the authenticated bootstrap channel.

Old unsigned releases cannot be installed by the new installer. To migrate,
provision the public key first, then upgrade to the first signed release.
Retain a reviewed installer locally for future upgrades. Downloading and
executing a fresh shell script from a compromised release account bypasses
anything implemented inside that script: bundle signatures do not authenticate
an already compromised bootstrap installer. Distribute or verify that installer
independently. TLS-only `curl | sh` remains a trust-in-the-script bootstrap.

For rotation, authenticate the new fingerprint with the current trust root or
an independently authenticated channel, explicitly replace the local public
key, and only then switch releases. Never automatically trust a key downloaded
from a release. Signatures authenticate bytes, not freshness; an explicitly
selected older signed version remains installable.
