# Desktop proxy initialization

The noVNC asset and WebSocket routes resolve a routing target independently of
the desktop inventory UI. Asset requests do not enumerate and decorate the
catalog with leases, related threads, or per-desktop policy summaries. They do
not start or recover a desktop. Use the existing brokered open flow for lifecycle
actions; a stopped desktop returns `desktop_not_running`.

The internal adapter selects one configured profile or one raw managed-desktop
record. Legacy browserctl providers only support `list --json`, and remote
providers still use their existing inventory endpoint; selection happens before
Orkestr UI enrichment. This is not a new single-desktop provider API.

## Concurrency and authorization

Only pending target lookups are shared. There is no completed routing cache:
later dependency waves and reconnects read fresh runtime records, rather than
reusing ports after a restart. The former `ORKESTR_DESKTOP_PROXY_TARGET_CACHE_MS`
setting no longer controls this route. The separate UI inventory cache is
unchanged and is not used for routing.

Pending work is partitioned by principal, owner, thread, boundary, resource,
policy/grant/resource generation, share/attempt and lease fencing token.
Partitions are hashed and never used as metric labels. A maximum of 64 pending
partitions bounds admission; excess work receives `desktop_lookup_busy`.

Every request checks exact-desktop authorization before and after the shared
read. A changed binding fails closed. Approved share sessions are revalidated
after lookup, and established sockets retain lifecycle revocation/expiry
enforcement. Sharing a lookup never shares authorization. A disconnected caller
cannot cancel another caller's lookup.

## Deadlines and telemetry

| Setting | Default | Applies to |
| --- | --- | --- |
| `ORKESTR_DESKTOP_PROXY_LOOKUP_TIMEOUT_MS` | 6000 ms | Pending raw target read, with cancellation |
| `ORKESTR_DESKTOP_PROXY_HTTP_TIMEOUT_MS` | 15000 ms | Upstream static response, including body |
| `ORKESTR_DESKTOP_PROXY_WS_TIMEOUT_MS` | 10000 ms | Upstream WebSocket handshake only |

Proxy deadlines are clamped to 100–30000 ms. Provider inventory retains its
existing independent 5-second default (10-second maximum). These limits do not
cancel established interactive WebSocket sessions. An incomplete response is
terminated at its deadline, including stalled HTTP error bodies; pre-header
timeouts return a generic 504. WebSocket response headers are limited to 16 KiB
and must indicate an upgrade before bytes are piped bidirectionally.

`orkestr_desktop_proxy_phase_seconds` records authorization, target lookup,
upstream headers/body and WebSocket handshake with fixed phase/outcome labels.
`orkestr_desktop_proxy_lookup_total` records started/shared work. These metrics
contain no user, thread, desktop, URL or token labels. Authorization time is
measured separately; the target-read deadline is not a total authentication
deadline.

## Validation and release checks

After building the server, run the desktop-target, desktop-target-adapter,
desktop-proxy-init, desktop-proxy-transport, desktop-proxy-lifecycle,
desktop-access, desktop-capability-broker and desktop-shares tests. Use isolated
test configuration, not production gateway/connector settings. Run the tenant
isolation suite, static UI/architecture checks and standard release checks.

The proxy integration fixture exercises cold batches of 6, 16 and 44 assets with
real grants and an approved share, checking one raw lookup per batch and no
upstream access after revocation. Transport fixtures cover header/body stalls,
error-body stalls, downstream cancellation, invalid/oversized WebSocket
handshakes and continued traffic after successful upgrade.

Rejected WebSocket handshakes close the downstream after flushing the error,
even when the client keeps its write side open. The half-open transport fixture
guards against retaining a socket after its handshake deadline is cleared.
Malformed percent encoding on upgrade routes returns a generic 400 before
authorization or target lookup; the routing fixture verifies that the async
upgrade listener does not reject into the server event loop. Both regressions
were reproduced against worker base `03e12e59` before applying the fixes.

The bounded ORK-499 follow-up passed 65 isolated tests across target, adapter,
proxy initialization/transport/routing/lifecycle, access, capability-broker and
share suites after `npm run build:server`. Use
`ORKESTR_HOST_BOUNDARIES=0 node --import ./test/test-bootstrap.mjs --test`
with those test files. The real-proxy fixture measured 502/578/779 ms for
6/16/44 concurrent assets, each with one target read. Its injected upstream
inventory delay is 250 ms; the 44-request observation exceeds the nominal
250+500 ms budget by 29 ms. The fixture's 3000 ms regression bound passed;
this is not evidence that all proposed performance budgets passed. No live
desktop interaction, service restart or configuration change was performed.

Fixture timings are regression evidence, not a production Keycloak/browser
waterfall. Before marking the incident resolved after release, capture cold and
warm authenticated browser loads on desktop and mobile: HTML, JavaScript
dependency waves, WebSocket 101, RFB negotiation and first rendered frame.
Compare against the pre-release waterfall and phase metrics. Verify grant/share
revocation and restart/reconnect behavior; do not tune framebuffer/XDAMAGE
settings based solely on initialization latency. Keep deployment and rollback
evidence in the release train.

Live acceptance remains separate: record client, bandwidth, RTT and cache state
for authenticated desktop and mobile waterfalls. Check warm asset p95 <= 500 ms,
cold fanout within one bounded lookup plus 500 ms, and first-frame p95 <= 5 s
under the proposed <= 80 ms RTT profile with an already-running desktop. Report
unmet budgets explicitly. Isolated loopback fixtures do not establish Keycloak
navigation-to-WebSocket or navigation-to-first-frame performance.
