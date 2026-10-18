# Consumed dispatch bridge checkpoint

The Runtime bridge consumes the ordinary SQLite issuer's
`Box<ConsumedProviderDispatch>` by value. The private `CodexTurn` implements the
containment crate-private `ConsumedTurn` boundary. There is no constructor from
caller IDs, text, an admission DTO, a replay disposition, or raw JSON.

The bridge checks provider and binding association against protocol readiness.
Its scope is derived from the issued namespace, supervisor incarnation, owner,
session, run and dispatch fence. The turn uses only the issued native session,
message ID and removable message text. Request IDs are allocated on the matching
connection; this slice permits one turn submission per connection.

Every failure consumes the grant, including a refused connection association,
wrong transport scope, queue capacity failure or broken pipe. The durable store
has already committed `DeliveryUnknown`; no failure returns authority to retry.
An enqueue result describes queued bytes, not provider acknowledgement.

Core source provenance: `7631dea5`. Containment source provenance: `5ef1ec97`.
The workspace root and lockfile are unchanged. Containment and this bridge are
registered only under `cfg(test)` pending the reviewed ordinary durable fence
adapter. Existing high-level production starts remain `DispatchUnconfirmed`.

The integration cases use an ordinary authorized Store, trusted synthetic native
readiness evidence, and an owned synthetic echo child. Their explicit test-only
fence is not production authority. Reopening the database cannot reissue a
consumed capability. These cases do not establish real provider execution,
process recovery, durable cancellation, output acceptance or release readiness.

Next prerequisite is the supervisor-bound synchronous durable fence operation
around bounded spawn/enqueue/flush actions. It must preserve cancellation
ordering while holding current authority through the callback. No permissive
production fence may be substituted. Turn response correlation and durable
observation pumping remain subsequent adapter work.
