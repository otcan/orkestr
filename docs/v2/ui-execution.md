# Web execution surface checkpoint

The conversation has a discoverable execution panel, queue/progress placeholders,
CPU/RAM details, and separate Stop/steer controls. Until ordinary execution routes
and canonical capabilities are published, controls are disabled and samples are
unavailable. Durable intake does not claim execution. The client does not guess
routes, poll nonexistent endpoints, or reinterpret fixture receipts as ordinary
run status. Cookie/CSRF transport and atomic conversation replay are preserved.

`apps/ui/src/execution.rs` is a presentation model, not a shared/wire DTO. A future
reviewed adapter must validate canonical scope/run identity and revision semantics
before supplying observations. Samples reject wrong conversation, empty run,
regressing scoped revisions and client receipt times and invalid progress/CPU.
After 15 seconds without a current sample, or on stream disconnect, telemetry is
stale and resource samples are not presented as current. Stop remains eligible
for a known active run with authenticated control authority, independent of model
output or stream liveness. An offline failure is unconfirmed and retryable. CancellationRequested
never means Cancelled. Server capabilities and authenticated scoped identity are required for Stop;
steering additionally requires fresh status. No control request is implemented yet.

Proposed minimal Core/Runtime dependency: canonical conversation/run identity,
revision and observation time, phase, optional progress/queue-age/resource samples,
and explicit Stop/steering capability; CSRF-protected idempotent control request
and receipt routes. CPU percentage requires a defined server sampling convention.
These are proposals only, awaiting exact reviewed DTOs/routes. No backend, shared
contracts, root membership or lock change is authored in this slice.

Executable tests cover simulated 30-second receipt wait with draft edits and
original-request retries, stale/disconnected/cancellation transitions, rejected
out-of-order samples, and 10,000 paged history rows with at most 100 retained render
rows. The 10k test uses the real projection, checks first/last retained sequence,
and has a generous five-second local regression budget; it is not a browser frame
rate or 30-second real execution acceptance test. Independent history pagination
continues to allow traversal beyond the live render window.

Validation commands from the v2 workspace use the assigned wrapper and isolated
UI target/home: offline locked UI tests, web-feature wasm32 build and strict UI
Clippy; plus Node bridge tests and fmt/diff checks. Local checkpoint: 24 Rust tests
and 22 Node tests passed, WASM build and strict Clippy passed. Headless live browser
execution/steering/Stop acceptance requires the ordinary backend and remains open.
Native iOS is deferred by the web-first scope decision.

Selection explicitly resets run/project state and increments a client generation.
Late responses from previous selections are rejected, including return navigation.
Revisions compare only within that selected generation/run. Server wall timestamps
are informational, not compared with browser time or used for freshness. Adapters
must pass client-monotonic elapsed milliseconds at receipt; clock-ahead/behind
samples and lower revisions on a new run are covered by deterministic tests.
These tests establish presentation semantics only; authenticated durable cancellation
identity validation and a hung-provider control request require the reviewed API.

## Reviewed canonical status adapter

Exact Core contract `a7c7952303ca39890b8c389237145224b2e415e7` is imported
verbatim in a separate provenance commit following independent source review.
`Execution::apply_status` calls `is_valid` and validates selection generation and
conversation before replacing state. Canonical revisions remain per conversation
across run changes and return navigation; equal revisions require identical
snapshots. Lower canonical revisions are rejected even if a new run is selected.
A new run can have a lower local presentation revision only through the separate
non-wire model; it cannot bypass canonical conversation revision ordering.

Queued snapshots without run identity never enable controls. Starting, blocked,
awaiting acceptance and requested cancellation remain distinct. Completed is only
presented when the canonical status reports it; the server owns verified acceptance.
CPU uses the contract's allocated-capacity permille convention and displays one
decimal percent. Old or missing resource samples stay unavailable, not zero.
Resource age is server sample age relative to server snapshot time, plus monotonic
client time since receipt. Progress is an opaque payload reference; no invented
counts or text are supplied. Reading that payload awaits a reviewed endpoint.

This is a validated read adapter, not live polling: no guessed route registration,
request, Stop or steering call is added. Runtime owns routes, CSRF and idempotent
control receipts. Local validation now includes 27 Rust tests (three canonical
status adapter cases), 22 Node cases, locked offline WASM and strict UI Clippy.

Read-only polling checkpoint: the conversation mounts a keyed execution-status
channel using relative `GET /api/v2/conversations/:id/execution`, same-origin
cookies and no Bearer or CSRF header on reads. A 200 is decoded and validated as
canonical `ExecutionStatus`; 204 removes displayed execution/control authority.
401/403 expires the session. Other failures leave the last confirmed status stale.
The channel polls serially, bounds bodies to 64 KiB, times out requests after ten
seconds, and cancels fetch/retry/tick timers on component teardown. Owner/session
generations fence every callback; conversation/owner selection remounts the channel.
Receipt time and visible freshness ticks use browser `performance.now()`.
Equal-revision identity uses Core's canonical comparison: only read-time clock and
queue age may vary. Identical/receding observation replays do not refresh the
client receipt anchor. Resource sample age remains separate from status freshness.
Stop/steer buttons remain unavailable. Server-route integration and delayed-fetch
browser acceptance still need separate proof; unit/bridge builds do not prove them.
