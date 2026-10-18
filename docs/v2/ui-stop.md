# Web Stop request consumer

The web consumer targets the reviewed `POST /api/v2/conversations/:id/stop`
contract. Activation remains disabled pending integration and independent
verification of the trusted server composition. Steering remains unavailable.

A request binds the conversation, run, expected revision and generated request
key. An uncertain response retains that exact request for retry. Navigation
keeps pending requests scoped to their original run; owner/session changes
clear them and invalidate callbacks. Model silence and stale telemetry do not
remove Stop authority.

The transport uses same-origin cookies and the in-memory CSRF value. It bounds
responses, aborts on timeout or component disposal, and treats malformed replies,
HTTP errors and network failures as unconfirmed. A `requested_unknown` receipt
reports an unconfirmed interruption. `not_dispatched` means cancellation before
provider delivery. Neither receipt invents a confirmed interruption of a live
provider, and neither rewrites the canonical execution status.

Contract provenance: `d03d2d774b45eb7276e86618aa333ea912ee9441`.
Reviewed route source: `d99d5710af80b0a99fd1f8bbd5aa6f0147f0b699`.
Pure state and transport tests cover exact retries, receipt identity validation,
owner changes, hung requests and bounded response handling. These tests do not
prove live provider interruption or browser acceptance.
