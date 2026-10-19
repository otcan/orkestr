# Bounded tunnel admission experiments

These files are a native-free policy experiment. Product launchers do not import
them. They use virtual policy deadlines and owned local stream sockets; they do
not start a provider, send an HTTP request, resolve a host or use an account.

Run the focused experiment:

```sh
python3 -B -m unittest discover -s v2/provider-broker/experiments -p 'test_*.py' -v
```

## What waiting can solve

Four occupied tunnels can refuse a fifth startup connection immediately even
when a tunnel would close shortly afterward. A bounded FIFO queue permits that
fifth request to proceed after a slot drains, without issuing a second request.
New arrivals cannot bypass existing waiters, cancelled waiters cannot dispatch,
and traffic on existing tunnels does not extend a queue deadline.

Waiting alone cannot guarantee progress. Four retained pooled connections may
remain open past the queue deadline. The tests retain four such streams and
require the fifth to expire. A separate delayed-response test demonstrates why
an opaque proxy cannot safely label a quiet encrypted connection idle and evict
it: a legitimate response can arrive after exactly the same quiet interval.

## Pinned native source

Codex `rust-v0.163.0` resolves to
`83086188ae0614bd882818ff1aa23f3194962012`.

- The [shared HTTP builder](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/http-client/src/client_builder.rs#L359)
  leaves connection-pool settings at their transport defaults. Its workspace
  dependency resolves to reqwest 0.12.28 in that commit's lockfile. The
  [reqwest defaults](https://github.com/seanmonstar/reqwest/blob/v0.12.28/src/async_impl/client.rs#L301)
  retain idle connections for 90 seconds and do not set a finite per-host idle
  pool bound. That is not a claim that every observed tunnel was pooled or idle.
- [RouteAwareClientPool](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/http-client/src/route_aware_client_pool.rs#L478)
  retains clients by route. A new backend client has its own pool; there is no
  single shared native four-connection admission limit in these paths.
- The [model worker](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/models_refresh_worker.rs#L45)
  starts an online refresh immediately. The
  [plugin manager](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core-plugins/src/manager.rs#L2824)
  can also start curated sync, marketplace upgrades, remote plugin/cache work
  and featured-plugin warmups. These are potential concurrent requests, not an
  identification of encrypted requests observed by a proxy.
- `-c features.plugins=false` is a supported stable setting in the pinned
  [feature table](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/features/src/lib.rs#L1620).
  [Configuration](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/config/mod.rs#L1767)
  passes it into the warmup gate. It disables optional plugin work; it does not
  disable model refresh or account/workspace routing verification. It is
  appropriate to evaluate for an isolated role that intentionally has no plugin
  tools. Do not impose it on roles that require plugins.

No exposed HTTP pool count or idle-time setting was found in the inspected
configuration and HTTP builder. `model_catalog_json` replaces catalog contents;
using a fabricated catalog merely to avoid startup network requests is outside
this proposal. Account/read and its routing/authentication checks stay intact.

## Concrete candidate for review

The model's defaults implement the following proposed budget. They are not
activated in a broker, private acceptance package or live service.

| Limit | Existing reviewed tunnel policy | Proposed experiment |
| --- | --- | --- |
| Active tunnels | 4 | 8 |
| Explicit pending FIFO | None; accepted excess closes | 4 sockets |
| Queue deadline | None | 2 seconds from accept; never extended |
| Per-tunnel bytes | 64 MiB, both directions summed | Unchanged |
| Aggregate bytes | No lifetime aggregate | 64 MiB across all tunnels and both directions |
| Per-tunnel duration | 900 seconds after setup | Unchanged |
| Controller lifetime | No aggregate tunnel-policy deadline | 900 seconds from controller creation |
| Accepted connection attempts | No lifetime count cap | 32, including queue-full refusals |
| Idle eviction | None | None |

Eight active slots accommodate four retained startup streams plus four new
connections, which is the bounded burst shape under investigation. This is a
twofold explicit capacity adjustment, not a liveness guarantee. Eight quiet
streams still cause later queued requests to expire truthfully. Queueing avoids
client retries while a slot drains; it never replays a refused or expired request.

The authoritative aggregate must live in the trusted outer controller and
survive native/broker replacement, peer identity updates and tunnel completion.
An inner per-native budget may provide additional protection but cannot be the
only aggregate counter: a fresh native process would reset it. If an existing
acceptance controller already has a shorter overall deadline, preserve it.
This proposal does not qualify these values for every long-running product role.

Reserve each read chunk against the shared byte budget **before** forwarding.
On aggregate exhaustion or controller cancellation, close active and pending
connections. A refused new request does not silently replace an active stream.
Count requests without retaining an unbounded event history. Exhausting the
attempt budget prevents new admission; existing admitted streams remain subject
to the original byte/time limits. Neither time nor bytes are refunded on close.

Keep the exact-host/443 allowlist, public-address DNS restriction, CONNECT/header
normalization, peer UID/PID/start/ancestry checks, account read-only mount,
namespace/seccomp/process limits and native stdin/bootstrap FD ownership
unchanged. Both inner and outer connection ceilings must agree; raising only
the inner ceiling would simply move the refusal to the outer proxy.

## Resource and acceptance bounds

The socket tests observe at most 20 owned stream descriptors per proxy model:
eight active pairs plus four pending client sockets. They use one joined I/O
thread and at most two 16 KiB application buffers per active stream (256 KiB
at eight). The pending sockets have no upstream socket and do not forward bytes.
The fixture additionally owns the test peers; those are not proxy descriptors.
These counts do not bound kernel socket memory, native memory or a product
implementation's RSS. A thread-per-tunnel product implementation would have a
different measured footprint and needs its own final-path test.

The current relay has a 4096-byte header bound and a two-second timeout per
blocking header read. It does not have a two-second absolute header deadline.
The candidate implementation should use an absolute accept-to-setup deadline,
including pending time, without turning it into a sliding timeout. This is a
separate setup bound from the 900-second established-tunnel deadline. DNS and
connect setup also need bounded controller cancellation; a per-socket timeout
does not itself bound a blocking resolver call.

The model is serialized and the local-stream oracle deliberately omits
destination parsing and real DNS/TLS. It conservatively retains an unread
pending disconnected socket until explicit cancellation or deadline; it does
not claim early FIN detection behind unread request bytes. Before adoption:

1. Integrate the independent stale-completed-slot correction.
2. Apply any approved optional-plugin setting to the fixed launch command and
   regenerate its exact command/source/manifest bindings.
3. Implement aggregate counters and bounded FIFO in the actual trusted proxies,
   preserving the existing destination/authentication and FD boundaries.
4. Run same-path no-account tests for simultaneous arrivals, short and pooled
   occupancy, slow valid responses, fair admission, pending disconnects,
   cancellation during setup, blocked writes, aggregate limits across native
   replacements and complete descendant/socket cleanup.
5. Review and seal the changed immutable package before one actual-account
   acceptance. Synthetic success does not prove native startup succeeds.
