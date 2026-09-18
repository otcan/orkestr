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

Fixture timings are regression evidence, not a production Keycloak/browser
waterfall. Before marking the incident resolved after release, capture cold and
warm authenticated browser loads on desktop and mobile: HTML, JavaScript
dependency waves, WebSocket 101, RFB negotiation and first rendered frame.
Compare against the pre-release waterfall and phase metrics. Verify grant/share
revocation and restart/reconnect behavior; do not tune framebuffer/XDAMAGE
settings based solely on initialization latency. Keep deployment and rollback
evidence in the release train.
