# Optional independent UI snapshots

The ordinary server still loads its configured UI directory once at startup.
Changing that directory or a symlink does not reload the running server. The
default clone/build/start path is unchanged.

An optional static front-proxy profile can publish a new UI while preserving
the exact qualified backend binary, package, Core process and API routes. This
change supplies a public manifest contract and an **unselected snapshot
builder**. It does not install a proxy, select a release, reload services or
authorize a production promotion.

## Public bytes and compatibility

`apps/ui/scripts/ui_release.mjs manifest` inventories a completed bundle. The
canonical `orkestr-ui-release-v1` document contains the exact UI source commit,
an explicit sorted list of compatible backend source commits, API contract
version, required server features, fixed JS/WASM entrypoints and every file's
SHA-256, size and MIME type. There is no deployment hostname, private backend
approval, credential, filesystem location or runtime receipt in this document.

The backend-source allowlist is a reviewed build input; there is no default
personal deployment or moving branch. Source-controlled
`apps/ui/release_requirements.json` declares required API features. A UI using
provider quota data must require `provider_quotas_v1`; a backend without that
feature is rejected. A supported quota API returning `unconfigured` or
`unavailable` remains a supported API, not evidence of a numeric quota.

The release ID is SHA-256 of the canonical manifest bytes, including a final
newline. Its complete payload is served under `/_ui/<release-id>/`. The root
bootstrap is rendered **after** this digest is known, avoiding a self-referential
hash. It names that release's JS and WASM explicitly; their relative snippet
imports stay inside the same namespace. The public `orkestr-ui-assets` meta
value pins dynamic upload helpers to that namespace. API URLs remain `/api/...`.
Pages without this meta value retain ordinary root asset behavior.

The builder refuses unknown document fields, duplicate/noncanonical manifest
encodings, traversal/reserved API paths, hidden/unknown files, symlinks,
hardlinks, non-regular files, extra/missing/changed bytes and concurrent file
changes. Limits match the existing static snapshot: 4,096 files, depth 16,
8 MiB per file and 64 MiB total. Files are read individually within those
bounds; the builder does not accept HTTP-selected filesystem paths.

## Preparing a candidate

Run from the repository root with an already built UI bundle. All example
identities are fake. The manifest output must be outside the bundle.

```sh
node v2/apps/ui/scripts/ui_release.mjs manifest \
  --bundle /tmp/example-ui-bundle \
  --source aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --backend-sources bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  --requirements v2/apps/ui/release_requirements.json \
  --output /tmp/example-ui-manifest.json
```

Alternatively set `UI_RELEASE_MANIFEST`, `UI_SOURCE_COMMIT` and
`UI_BACKEND_SOURCES` when invoking the existing `bundle.sh`. This is opt-in;
ordinary bundles require none of these settings. Rendering CI retains the
tested raw UI candidate independently of the slower backend image jobs. The
artifact's workflow, exact checkout and digest must be verified during private
import; a candidate is not a backend build receipt or a release approval.

Snapshot preparation takes separately supplied approved and currently observed
backend profiles. Both have exactly these fields:

```json
{"api_contract_version":0,"code_subject_sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","features":[],"format":"orkestr-ui-backend-profile-v1","server_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","source_commit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
```

The exact source/server/qualified-code-subject identity and feature profile must
match. Compatibility is then checked against the UI manifest. These supplied
profiles are assertions, not evidence that a live backend was measured: only
the private operator admission path may bind them to actual qualified bytes,
current health and approval. An untrusted caller can prepare files but cannot
thereby acquire publication authority.

```sh
node v2/apps/ui/scripts/ui_release.mjs snapshot \
  --bundle /tmp/example-ui-bundle \
  --manifest /tmp/example-ui-manifest.json \
  --approved-backend /tmp/example-approved-backend.json \
  --observed-backend /tmp/example-current-backend.json \
  --output /tmp/example-unselected-snapshot
```

The fresh output contains only `index.html` and the complete public namespace.
The JSON plan is returned on stdout, with the bootstrap and backend-profile
digests and `selected:false`. It belongs in private review evidence, outside
the public tree. An existing output is never overwritten. Failure can leave
an incomplete **unselected** output for inspection; it is never a promotion.

## Private publication boundary

The actual importer, Root custody checks, approvals, pointer CAS and proxy
configuration belong outside OSS. Before the first enablement, inventory the
actual proxy/service configuration and produce a bounded reviewed profile.
Do not infer production behavior from the synthetic proxy fixture.

The private profile must route only `/`, `/index.html` and the fixed versioned
namespace to public snapshots. API/auth/cookie/CSRF/SSE and origin/CSP policy
remain with their existing handlers. Unknown names are 404, never an SPA or
filesystem fallback. Root HTML revalidates; content-addressed asset URLs may be
immutable. GET, HEAD, conditional requests, MIME, nosniff, representation-specific
ETags and gzip must remain correct through the actual proxy.

Root publishes a verified complete namespace before atomically selecting its
bootstrap. Promotion CAS binds the previous bootstrap and freshly rechecked
qualified backend identity; rollback selects a retained bootstrap. There is no
browser-facing promotion endpoint, new Root daemon or Core restart. Keep all
published namespaces needed by open pages; no automatic pruning is introduced.
Missing old assets must fail, never fall through to the current version.

Initially leave legacy unversioned asset URLs on the unchanged backend. Before
any later backend replacement, preserve their exact baseline bytes separately
or explicitly review that migration; current old pages cannot retrospectively
gain versioned helper URLs. Never overwrite a sealed backend package to do this.

Before production selection, prove mounted browser A-to-B-to-rollback behavior,
including a delayed module import and an in-flight encrypted upload. Then prove
the real private proxy preserves ordinary accepted-input continuity, API
security/headers, the Core PID/start identity, backend binary and qualified code
subject. UI snapshot tests do not establish those live acceptance facts.
