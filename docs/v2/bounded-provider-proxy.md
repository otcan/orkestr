# Bounded isolated Codex proxy candidate

This opt-in candidate is for a fixed, no-plugin isolated acceptance role. It is
not the default authenticated profile. `codex-bounded` selects the new inner
path and `features.plugins=false`; existing `codex` and Claude paths retain
their existing behavior. An operator must provision a new, reviewed immutable
package and private endpoint before selecting this mode.

The native 0.163.0 sources at commit
`83086188ae0614bd882818ff1aa23f3194962012` support that feature override.
Disabling plugins also disables plugin loading, associated skills and hooks,
recommendations and plugin/catalog warmups. It does not remove account checks
or model catalog refreshes. This candidate does not infer that all startup
connections are plugin requests and does not inspect encrypted traffic.

## Limits and ownership

Each layer has eight active workers and four FIFO pending clients. Pending
clients retain local channels but forward no CONNECT request or payload to an
Internet destination. Admission samples finished workers after accept, before
checking capacity. Cancellation observes Linux peer shutdown even when unread
client bytes remain. There is no active stream eviction to make space.

The trusted outer controller owns one `Budget` across every native and ordinary
server replacement in an acceptance attempt. Replacing an endpoint calls
`Pool.retire()` and passes the same budget to its successor. Final shutdown
stops the budget and joins all owned workers. A caller-supplied timestamp,
profile or native session cannot create, reset or select this authority.

| Limit | Meaning |
| --- | --- |
| 32 attempts | Authenticated local Unix channels counted before destination work, including inner capacity refusals. |
| 2 seconds | Absolute initial inner accept through outer setup; both queues share this window. |
| 64 MiB | Combined payload bytes in both directions, across all tunnels and replacement natives. |
| 900 seconds | Maximum generic aggregate and individual tunnel lifetime; the private acceptance controller uses a shorter 120-second total bound. |
| 4096 bytes | Each bounded CONNECT/header frame; separately bounded control traffic is not payload. |
| 16 KiB | At most one application payload chunk per relay while forwarding. |

Each outer payload read reserves bytes atomically before forwarding. The two
directions share one counter; a byte is not counted again on its corresponding
write. Failed or partial writes do not refund reservations. The inner layer has
an independent, conservative counter. The authoritative outer aggregate is not
the sum of the two layers. Request exhaustion refuses new admission without
terminating existing streams; aggregate byte/lifetime exhaustion cancels them.

At eight established and four pending clients, the inner layer owns 24 relay
socket descriptors and the outer layer owns 20. Listeners, interpreter files,
kernel socket buffers, test peers and subprocess setup descriptors are separate.
At most eight fixed DNS children can exist, one per outer active worker; a DNS
stdout pipe precedes that worker's Internet socket. Subprocess creation also
uses short-lived pipes, so 20 is not a claim about the whole process FD peak.
No thread is created for a pending client. There are at most eight relay threads
per layer and one 16 KiB application chunk per active relay. Kernel buffering
is not included in that application-memory bound.

## New private control protocol

The bounded endpoint is distinct from the legacy raw-CONNECT endpoint. After
the controller authenticates UID, PID, start identity, owned ancestry and exact
mounted source, the inner sends exactly 16 control bytes: `ORKPX2\0\0` followed
by an unsigned big-endian 64-bit original `CLOCK_MONOTONIC` nanosecond timestamp.
Canonical CONNECT bytes follow and retain their existing destination/header
rules. The timestamp assumes both processes use the same host monotonic clock;
it is not identity or authorization.

Zero, future and stale timestamps, a wrong magic/version, truncation or a partial
frame exceeding the receiver's own setup deadline are refused. The receiver
uses the earlier of its own accept plus two seconds and original accept plus
two seconds. It reads only the exact 16-byte prefix, preserving coalesced CONNECT
bytes. The timestamp is created once at initial accept and is never refreshed
while queued, on promotion or at the outer endpoint. Legacy endpoints do not
interpret this new envelope.

## DNS and cleanup

Only the authenticated outer controller resolves an exact allowed host. Its
fixed isolated Python helper has a minimal environment and no inherited socket
authority; it sets a parent-death SIGKILL fence and checks the parent identity
after installing that fence. Every returned address must be public and numeric,
with a fixed TCP/443 shape, at most 16 answers and at most 8192 response bytes.
The setup deadline and cancellation kill and reap the resolver. No blocked
`getaddrinfo` thread can outlive the acceptance attempt.

Connect, partial header reads, payload writes and relay waits all observe the
same context cancellation and deadlines. Shutdown closes retained sockets and
joins workers within one cleanup bound. Failed resolver reaping is propagated
as incomplete cleanup rather than qualified success. No raw request, credential,
TLS record or resolver error text is diagnostic output.

## No-account checks

Run from `v2/provider-broker`:

```sh
python3 -B -W error::ResourceWarning -m unittest test_bounded_proxy test_bounded_dns test_bounded_role test_proxy_stale_slot test_authenticated_inventory -v
python3 -B -W error::ResourceWarning measure_bounded_proxy.py
```

The local TCP/Unix fixture uses the actual inner/root modules with a fixed
synthetic resolver/connector seam; it never contacts a provider. Tests cover
FIFO admission, cancellation with unread bytes, both-direction reservations,
replacement-native/endpoint lifetime continuity, partial/coalesced control
frames, stalled/malformed DNS, parent death, blocked writes and complete cleanup.
The resource observer distinguishes relay descriptors from test peers. These
checks do not establish real-account compatibility or production qualification.
