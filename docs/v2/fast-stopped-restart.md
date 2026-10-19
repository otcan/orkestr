# Configured Fast restart after Stop

When a Fast turn genuinely stops, its factory retains the original Runtime
`ReapedBroker` while waiting for another eligible owner input. If shutdown ends
that wait, the factory consumes this exact proof only after its retained child
resources are gone and its machine credential is still current. Core then records
the exact canonical Stopped predecessor in migration 0037's retirement ledger.

The existing private Fast startup path discovers this retirement and performs
the typed predecessor reattachment. It waits for eligible input before spending
the one-use metadata reservation. A new process resumes the same native session
and binding under a new supervisor incarnation. It receives a new admission;
historical dispatch, Stop and completion receipts confer no new authority.

Held inputs stay held. Fast Stop itself does not create a Deep inbox hold. The
held-input regression obtains a genuine hold from a separately configured Deep
Stop, then restarts only the unchanged Fast configuration. It does not qualify
Deep stopped restart or release that Deep input.

ACK-only cancellation, unexpected native death, an unaccepted proposal, revoked
machine authority, and server death before graceful retirement do not produce
this restart permission. Canonical Stopped status alone is insufficient when the
original reap witness was lost. There is no new browser field, route, constructor
or metadata API.

`owned_fast_stopped` runs seven actual-server HTTP scenarios with synthetic
native UUIDs, authenticated browser requests, ordinary Store transactions and
read-only pinned ledger snapshots. It checks source selection, held-input
preservation, original-process cleanup, exact native identity, predecessor
incarnation, explicit successor acceptance and refusals without new native calls.
Its standalone Python driver accepts `--report` and `--case` for bounded evidence.

This does not qualify actual accounts, browser behavior, automatic recovery of
unknown work, idle initial setup, or a lost already-issued continuation grant.
Accepted restart remains covered separately by the existing Fast lifecycle suite.
