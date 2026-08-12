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

This phase adds canonical ingress only. Host-boundary changes, legacy
redirects, and canonical link generation belong to later rollout work.

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
setting implies HTTPS. Legacy public, tailnet, primary-domain, auth, and connect
settings are not application-link fallbacks. When no explicit application base
exists, Orkestr omits canonical links. A browser already on another origin uses
a real cross-origin navigation to the configured app origin; same-origin panel
changes continue to use browser history.
