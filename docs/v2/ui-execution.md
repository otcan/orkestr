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
regressing revisions/timestamps, future observations and invalid progress/CPU.
After 15 seconds without a current sample, or on disconnect, controls fail closed
and stale resource samples are not presented as current. CancellationRequested
never means Cancelled. Server capabilities and fresh confirmed state are both
required for control eligibility; no control request is implemented yet.

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
Clippy; plus Node bridge tests and fmt/diff checks. Local checkpoint: 22 Rust tests
and 22 Node tests passed, WASM build and strict Clippy passed. Headless live browser
execution/steering/Stop acceptance requires the ordinary backend and remains open.
Native iOS is deferred by the web-first scope decision.
