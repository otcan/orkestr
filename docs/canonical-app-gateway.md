# Canonical app gateway

The canonical app gateway accepts instance-first application URLs:

```text
https://app.example.test/instance/ins_AQEBAQEBAQEBAQEBAQEBAQ/thread/thr_AgICAgICAgICAgICAgICAg
```

Both references are opaque public references. Internal instance IDs, thread IDs,
names, and binding names are not accepted in these path positions.

## Enablement

The gateway is additive and disabled by default. Enable public-reference
assignment first, run the migration described in
[`canonical-public-references.md`](canonical-public-references.md), and then
enable the gateway:

```sh
ORKESTR_CANONICAL_INSTANCE_URLS=1
ORKESTR_CANONICAL_APP_GATEWAY=1
```

Both flags must be enabled. Disabling `ORKESTR_CANONICAL_APP_GATEWAY` restores
the phase-one routing behavior without changing stored references. Existing
shared-app and `/i/{internal-id}/app/` routes remain unchanged in this phase.

For local dispatch, preflight records the stripped instance-relative path for
the existing share-session, auth-intent, thread-resource, connector, and
control-plane policy gates. Controllers therefore receive exactly the same
authorization decision as their non-canonical `/api/...` route. Broker parents
authorize only the instance; the tenant repeats canonical preflight after it
validates the encrypted broker assertion and applies its own local route gates.

## Security boundary

The gateway resolves the instance public reference through the storage index
and authorizes the caller for that instance before it looks up a local thread
or opens an upstream connection. Broker assertions are validated by the normal
global authentication middleware before the gateway runs. Unknown,
unauthorized, disabled, and expired instances all return the same `404 not
found` response. Local thread pages then resolve the exact thread public
reference and apply normal thread ownership policy; unknown and unauthorized
threads use the same response.

Broker assertions contain the internal instance ID only after authorization.
The canonical URL and canonical cookie path contain only `ins_` and `thr_`
references. A paired broker session receives both its legacy cookie and a
second cookie scoped to `/instance/{ins_}` so browser requests, SSE, and
WebSockets remain inside the canonical instance boundary.

## Dispatch behavior

The HTML base is `/instance/{ins_}/`. Instance-scoped asset, API, SSE, and
WebSocket suffixes are dispatched locally or proxied to the registered broker
endpoint with method, body, and query intact. HTTP fragments are browser-only
and never reach the gateway. Streaming responses are piped rather than
buffered; only HTML is buffered to rewrite the base path.

This phase adds canonical ingress only. Host-boundary enforcement and legacy
redirects remain separate, default-off rollout steps.

## Canonical link emission

Canonical link emission is a separate, default-off rollout step. After the
gateway is enabled and the application host is configured, enable it with:

```sh
ORKESTR_APP_HOST=app.example.test
ORKESTR_CANONICAL_APP_LINKS=1
```

All three canonical feature flags must be enabled before Orkestr emits links.
Thread summaries then include `canonicalUrl` and `canonicalPath`, the WebUI
uses the opaque route for navigation and copy/open actions, Gmail browser
notifications open it when available, and watcher alerts render it for the
operator. Legacy URLs and response shapes stay unchanged while link emission
is disabled.

The emitted URL contains only the configured app host and the persisted
instance/thread public references. Thread renames cannot change it. Converting
an already-open thread route preserves its query string and fragment, while
panel navigation appends the panel below the opaque thread reference. Host
selection and connect-host policy are intentionally outside this feature.

Link emission accepts only an explicitly configured application base:
`ORKESTR_PUBLIC_APP_URL`, `ORKESTR_APP_URL`, or `ORKESTR_APP_HOST` (in that
order). URL settings preserve their `http`/`https` scheme and port; a host-only
setting implies HTTPS. Explicit URL settings with any other scheme fail closed.
Legacy public, tailnet, primary-domain, auth, and connect
settings are not application-link fallbacks. When no explicit application base
exists, Orkestr omits canonical links. A browser already on another origin uses
a real cross-origin navigation to the configured app origin; same-origin panel
changes continue to use browser history.

## Application and connect/auth host boundaries

After the reference migration, gateway, and canonical-link checks are green,
an operator may separate browser responsibilities with another default-off
flag:

```sh
ORKESTR_HOST_BOUNDARIES=1
ORKESTR_PUBLIC_APP_URL=https://app.example.test
ORKESTR_CONNECT_PUBLIC_URL=https://connect.example.test
```

The application origin serves canonical ingress and normal application routes.
The connect/auth origin serves setup and OAuth handoffs plus only the static
shell and method-specific pairing/OAuth primitives required to complete those
flows. It does not serve thread, control-plane, or administrator security APIs.
An application-origin setup or OAuth handoff is redirected to the configured
connect/auth origin with its query string intact. Canonical routes arriving on
the connect/auth origin are redirected to the application origin.

The boundary compares the effective scheme and host. Forwarded host/protocol
headers are ignored unless `ORKESTR_TRUST_PROXY_HEADERS=1` and the direct peer
appears in the explicit `ORKESTR_TRUSTED_PROXY_IPS` list. Missing, malformed,
unknown, or mixed host configuration fails with a uniform `404`; request hosts
are never copied into redirect destinations.

While this compatibility phase is enabled, authorized and unambiguous
`/thread/{id-or-name}` and `/ng/thread/{id-or-name}` requests redirect to the
opaque canonical application URL. Redirects require the full canonical flag
set and persisted instance/thread public references. Ambiguous, unauthorized,
and unknown selectors all fail identically. The existing
`/i/{internal-id}/app/...` and shared-app `/i/{internal-id}/a/{slug}/s/...`
flows remain available on configured application and connect/auth origins;
these internal-ID compatibility routes are deprecated and should not be used
for newly emitted links.

Run `orkestr doctor system --json` or `orkestr doctor router --json` before
enablement. The checks report aggregate configuration, migration readiness,
legacy-selector ambiguity, cookie/forwarded-header hazards, and recent
wrong-host traffic without exposing private selectors or hostnames. Roll back
host separation by setting `ORKESTR_HOST_BOUNDARIES=0`; stored public references
and the three earlier canonical feature flags are unchanged.
