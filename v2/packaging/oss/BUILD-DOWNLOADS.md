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

## Public release-link fallback

Anonymous `api.github.com` requests from GitHub-hosted runners share a rate
limit per runner IP, and since 2026-11-16 they have returned HTTP 403 for hours
at a time. Every API asset download therefore has a second route: the same
official asset over its public release link,
`https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`.

- The API route is always tried first, with the exact headers above.
- The public link is used only when the API route fails. It is also anonymous:
  no `Authorization` header, token or other credential.
- The pinned digest check runs after either route and stays authoritative. A
  digest mismatch on either route fails the build; it never triggers the other
  route. A failure on both routes fails the build.
- In shell steps the fallback is `curl <api> && ok=yes` followed by
  `if [ "$ok" != yes ]; then curl <public link>; fi` (inside a Dockerfile `&&`
  chain: `if curl <api>; then ok=yes; fi`), never `||`.

| Asset | Used by | API asset ID | Public release link |
| --- | --- | --- | --- |
| gitleaks 8.30.1 linux x64 | `.github/workflows/ci.yml` secret scan | 378332058 | `gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz` |
| cloudflared 2026.10.7 amd64 | root `Dockerfile` | 692817008 | `cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-linux-amd64` |
| cloudflared 2026.10.7 arm64 | root `Dockerfile` | 692818763 | `cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-linux-arm64` |
| Codex 0.163.0 x86_64 | `fetch_providers.py` | 645227929 | `openai/codex/releases/download/rust-v0.163.0/codex-x86_64-unknown-linux-musl.tar.gz` |
| Codex code-mode host x86_64 | `fetch_providers.py` | 645227482 | `openai/codex/releases/download/rust-v0.163.0/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz` |
| Codex 0.163.0 aarch64 | `fetch_providers.py` | 645213549 | `openai/codex/releases/download/rust-v0.163.0/codex-aarch64-unknown-linux-musl.tar.gz` |
| Codex code-mode host aarch64 | `fetch_providers.py` | 645213791 | `openai/codex/releases/download/rust-v0.163.0/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz` |

On 2026-11-18 each public link was downloaded anonymously and its SHA-256
matched the pinned digest; the release metadata of each tag maps the asset IDs
above to the same file names and digests.

## Per-asset notes

Codex's four canonical asset URLs, digests and ELF checks remain in
`fetch_providers.py`; an immutable mapping selects the corresponding official
API asset IDs. The fallback is the canonical URL itself, so only reviewed
assets can be fetched over it. Unknown assets for that release fail before
downloading. Claude's npm URLs and integrity checks are unchanged and have no
second route.

The legacy image fixes cloudflared to 2026.10.7, the official release selected by
`latest` when these pins were reviewed. Each supported architecture has an exact
asset ID and SHA-256, checked before installation or execution. Builds no longer
resolve `latest` dynamically.

When updating a release, review the official repository, tag, asset name,
architecture and digest together. Update its asset ID, public release link and
expected digest in the same change. Keep bounded retries for transient transport
failures; a checksum mismatch, an architecture mismatch, or a refusal on both
routes must still fail the build.

The packaging tests cover the immutable provider mapping, request headers,
unchanged npm transport, permanent failures and checksum refusal. They pin each
fallback URL, its anonymity and its place before the digest check. An offline
synthetic curl peer also runs the actual Dockerfile download tail to prove both
architecture selections, the fallback after an API refusal, and that invalid
downloads from either route are never installed.
