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

Core source provenance: `7631dea5`. Containment source provenance: `5ef1ec97`; durable fence successor: `4d66e605`.
The workspace root and lockfile are unchanged. Containment and this bridge are
registered only under `cfg(test)` pending reviewed metadata bootstrap and same-child execution attachment. Existing high-level production starts remain `DispatchUnconfirmed`.

The integration cases use an ordinary authorized Store, trusted synthetic native
readiness evidence, and an owned synthetic echo child. Their private StoreFence invokes Core’s actual
`with_execution_fence`, holding the immediate SQLite transaction through each
bounded spawn/enqueue/flush callback. Renewal contenders have one winner; an old
queued frame cannot flush after renewal, and revoked authentication prevents a
new spawn. Reopening the database cannot reissue a
consumed capability. These cases do not establish real provider execution,
process recovery, durable cancellation, output acceptance or release readiness.

Next prerequisite is distinct Core-issued metadata authority before run
admission, followed by one-way attachment of the same owned metadata child to
the consumed execution. No fabricated run or permissive setup fence may be
substituted. Readiness advances binding generation, so attachment needs the
trusted transition association rather than an assumed generation equality. Turn response correlation and durable
observation pumping remain subsequent adapter work.
