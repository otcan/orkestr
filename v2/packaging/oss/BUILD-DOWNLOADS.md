# Reviewed build downloads

Custom GitHub build assets use the official release-asset API with fixed asset
IDs, `Accept: application/octet-stream` and API version `2022-11-28`. These are
anonymous requests; no token, alternate publisher or mirror is involved.

The browser release-download path repeatedly returned HTTP 504 while the API
asset path remained available. An actual anonymous API download of the existing
gitleaks v8.30.1 archive returned 8,230,402 bytes with SHA-256
`551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`,
matching the existing reviewed pin. Metadata checks alone are not counted as
successful artifact verification.

Codex's four canonical asset URLs, digests and ELF checks remain in
`fetch_providers.py`; an immutable mapping selects the corresponding official
API asset IDs. Unknown assets for that release fail before downloading. Claude's
npm URLs and integrity checks are unchanged.

The legacy image fixes cloudflared to 2026.10.7, the official release selected by
`latest` when these pins were reviewed. Each supported architecture has an exact
asset ID and SHA-256, checked before installation or execution. Builds no longer
resolve `latest` dynamically.

When updating a release, review the official repository, tag, asset name,
architecture and digest together. Update its asset ID and expected digest in the
same change. Keep bounded retries for transient transport failures; a permanent
refusal, checksum mismatch or architecture mismatch must still fail the build.

The packaging tests cover the immutable provider mapping, request headers,
unchanged npm transport, permanent failures and checksum refusal. An offline
synthetic curl peer also runs the actual Dockerfile download tail to prove both
architecture selections and that invalid downloads are never installed.
