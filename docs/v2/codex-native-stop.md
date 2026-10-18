# Owned Codex cancellation

`CodexPump::into_stopping(Store, &CancelReceipt)` consumes a running pump only
once. The caller must first commit authenticated cancellation. The issued
control admission is checked against the original execution and binding; it
never becomes execution or setup authority.

The returned `StoppingCodex` exposes bounded `flush` and asynchronous `step`.
Broker submission and each actual provider-stdin suffix execute under Core's
`with_cancellation_fence`. Reads retain the original owned execution identity.
No provider response is awaited inside a database transaction.

An interrupt object acknowledgement sets `acknowledged()` only. Only a genuine
interrupted terminal frame creates a sequenced Stopped input using the exact
issued control envelope. The matching durable Cancelled receipt sets
`stopped()`. Transient persistence failure retains the identical input without
repolling; permanent refusal quarantines the owned process. Pending evidence is
available through `pending()`. A racing CompletedProposal, Failed or Lost is
retained without conversion to Stopped and requires explicit reconciliation.

The session tests use an ordinary Store and the fixed broker with an owned
synthetic native process. They cover acknowledgement without a terminal event,
acknowledgement followed by interrupted evidence, and completion racing Stop.
These tests do not establish real-provider interruption or production activation.

## Server factory adapter

The separately owned `server/src/stop_execution` module wraps a pump and its
Authority after the authenticated Stop transaction. `StopExecution::begin`
requires the registered owner/run and exact receipt; `tick` returns Pending,
InterruptAcknowledged, Stopped or ReconciliationRequired. The factory must retain
this object across transient storage errors, not rebuild or resend it. Pending
terminal evidence is retried before any further transport flush. An unconfigured
factory remains unavailable; this module does not register routes or alter main.

`server/tests/stop_execution.rs` compiles the adapter independently of factory
registration. It is a compile target, not an additional behavioral test count.
