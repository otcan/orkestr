# Google registry request bridge v1

This source checkpoint freezes an **isolated** browser-request bridge alongside
the read-only metadata leaf. Shared Axum registration, native Store embedding and
real browser qualification remain unexecuted. No schema is needed. UI can consume
this DTO contract without treating configured capabilities as readiness.

## Source ownership and canonical authority

Migration owns only the new `v2/migration/google_registry_request.py`, its tests,
synthetic response fixture and this document. Coordinator owns any eventual
shared router/auth/lifecycle edits. Core need not leave its current schema work.

Canonical V2 source reviewed at `65e7730298afefae0812cd98455f7c9d9ec5973e`:

- `v2/apps/server/src/browser.rs::token`, `stored`, `credential`, `owner`: one
  exact session cookie, no Authorization combination, exact Host and current
  `Store.authenticate("browser:" + cookie)` lookup. The cookie is not a machine
  Bearer credential.
- `v2/apps/server/src/lib.rs::guard`: reject foreign Origin; no-store responses.
- `v2/crates/store-sqlite/src/lib.rs::authenticate`: current token hash lookup
  with Store expiry, returning the persisted owner. Logout/revoke removes that
  authority. Registry data is never an account/session authority.

The bridge follows these cookie/Host/Origin boundaries. It does not implement
login, persist sessions, read auth files, accept a caller-supplied principal or
call the legacy `authorizeHttpRequest` compatibility fallbacks. GET has no CSRF
mutation requirement; changing the method refuses. The eventual shared mount
must retain the ordinary guards and no-store policy.

## Exact minimal embedding seam

```python
class BrowserSessionAuthority:
    def authenticate_browser(self, credential: str) -> str | None: ...

registries = ExactOwnerRegistries({
    # server-owned, explicitly verified account-to-descriptor mapping only
    authenticated_owner_id: RegistryDescriptor(authenticated_owner_id, registry_path),
})
bridge = RegistryMetadataBridge(authority, registries, host=host, origin=origin)
```

The authority adapter must invoke the canonical current ordinary Store session
check for the supplied exact browser-prefixed credential **every call**, without
caching its owner. Return only that persisted owner or unauthenticated; fail
closed on Store failure. It must not consult registry ownership to authenticate.
The credential is ephemeral request memory, excluded from representations and
responses, never persisted or exported to a provider/registry.

`ExactOwnerRegistries` copies its trusted mapping and has no global/default/admin
fallback. Missing bindings return unavailable. The descriptor and every registry
account must already have the exact authenticated owner ID. If legacy and V2
identities differ, that binding remains unsupported until an independently
verified identity-mapping contract is agreed; do not infer an alias or rewrite
source ownership. No directory or registry is initialized to fill a gap.

`RequestVerifier` freezes only request credential and authority reference, not
an authentication result. The bridge authenticates to resolve the descriptor,
then the metadata leaf reauthenticates before opening and immediately before
return. Logout/revoke at any of these three checks refuses. An owner change on
the same credential refuses with `owner_scope_changed`; it cannot switch the
selected registry. The returned `CurrentAccount` projection comes exclusively
from current session authority, never input headers or registry JSON.

**Coordinator integration decision needed:** bind this protocol to the ordinary
native Store current-session API and supply trusted owner descriptors. The
included WSGI mount is executable isolated composition with fake authority,
not an implemented Python/Rust IPC or mounted production Axum route. No helper
may obtain authority by merely asserting a `CurrentAccount` object. Registration
must not copy browser credentials into a registry, configuration or subprocess
argument. If using the native server, retain its existing credential parser and
guards and implement the same per-delivery checks with its Store.

## Frozen relative route and response DTO

Proposed coordinator mount: **GET `/api/v2/connectors/google/registry-metadata`**.
No query, body, owner, account, path, claim or time parameter. Reserved authority
selection headers (`x-owner-id`, `x-account-id`, `x-user-id`, `x-registry-path`)
and transfer-encoded input refuse. Fixed header bounds apply. The path is not
registered by this patch.

Every response has `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, and JSON content type. No redirects or cookies
are produced. 405 also supplies `Allow: GET`.

Success (200):

```json
{"format_version":1,"status":"configuration_observed","metadata":{"format_version":1,"connections":0,"capabilities":{"gmail_read":0,"gmail_send":0,"gmail_actions":0,"gmail_drafts":0,"calendar_read":0,"calendar_actions":0},"unknown_capability_connections":0,"health":{"connected":0,"disconnected":0,"error":0,"unknown":0},"use_mode":{"default":0,"available":0,"explicit_only":0,"unknown":0},"configuration_only":true,"activity_proven":false,"provider_readiness_verified":false}}
```

Counts are nonnegative integers bounded by 1,024 connections. Gmail and calendar
are separate capability buckets, not account names, read grants or token status.
Unknown/out-of-scope capability values remain one fixed count; no raw value,
account ID, email, owner ID, token reference, scope string or host path is emitted.

Errors have exactly `format_version:1`, `status:"refused"`, and fixed `error`:

| HTTP | Error | Interpretation |
|---|---|---|
| 400 | `request_parameters_rejected` | Unsupported input or header bounds; no descriptor selected |
| 401 | `authentication_required` | Missing/malformed/combined cookie authority, expired/revoked/logout session |
| 403 | `host_rejected`, `origin_rejected`, `owner_scope_changed` | Boundary refused; never absence |
| 404 | `not_found` | Other relative route, not connector absence |
| 405 | `method_not_allowed` | GET only |
| 503 | `authority_unavailable` | Current session authority failed; no registry result |
| 503 | `registry_unavailable` | No exact binding, missing/malformed/foreign/legacy/oversize registry; no automatic repair |

UI must retain mail/calendar as possibly used on every refusal, show configured
metadata distinctly from live readiness, and never initiate refresh/setup/send
as a side effect of rendering. The synthetic fixture is
`v2/fixtures/migration-audit/google-registry/status-v1.json`.

## Executed synthetic acceptance

The request tests mount the bridge through WSGI validation and perform a real
loopback GET against fake current sessions and fresh synthetic files. They cover
two owners, all three revoke/logout windows, owner reassignment, no global
fallback, no client scope selection, duplicate/combined credentials, Host/Origin,
missing/foreign files, sanitized authority failures and readonly opens. A mounted
in-process test forbids filesystem writers and provider sockets. The separate
leaf tests cover stable bounded file reads, malformed data and symlinks.

These tests establish isolated adapter behavior only. Actual native Store/Axum,
browser, production registry and provider checks are unexecuted. No real token,
message, connector refresh, credential migration or account registry was read.
