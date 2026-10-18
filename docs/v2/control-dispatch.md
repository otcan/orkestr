# Owned cancellation handoff

`control_dispatch::mailbox(Store, OwnerId, ConversationId, RunId)` creates one
bounded receipt slot for one registered child. The trusted authenticated route
publishes the exact `CancelReceipt` returned by Core's cancellation transaction;
only the separate public `ExecutionStopReceipt` is serialized. No receipt is
reconstructed from execution status, browser fields or a replacement request key.

The cloneable sender holds no lock across an await. Exact receipt replay succeeds
after the receiver takes it or closes, without redelivery. A different receipt
conflicts; a first publication after receiver closure refuses. The route reports
control unavailable if publication fails after commit: durable cancellation
intent is preserved, but native interruption has not thereby been proven.

The owning session consumes the receiver once, moving its actual authority and
pump into the existing Runtime Stop adapter. Runtime validates the current Core
control fence before native writes. A transport acknowledgement is not terminal
evidence. Only a correlated interrupted terminal persisted by Core can produce
`Stopped`; timeout, stale authority and racing completion require reconciliation.
The two-second local deadline is checked between adapter steps, not inside a
Store operation. Cleanup initiates Runtime's owned reaper and does not itself
prove the provider stopped.

Factory wiring must serialize each normal pump step with authenticated
cancellation commit plus receipt publication. It must register only its exact
owned run, close the receiver with that lifecycle, and retain a sender after
cleanup only for matching authenticated receipt replay. The mailbox is an
in-process handoff, not crash recovery or an execution authority issuer.

`apps/server/tests/control_dispatch.rs` uses ordinary SQLite-issued cancellation
receipts to check scope, replay, concurrent publishers and publication/cleanup
races. These are mailbox tests; ordinary HTTP/provider interruption is a separate
factory integration check. No production activation or full-release approval is
implied by this module.
