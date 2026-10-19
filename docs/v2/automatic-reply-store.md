# Automatic reply Store boundary (schema 39)

This checkpoint registers no transport, account, HTTP route or automatic producer.
Root and independent source review are required before an adapter consumes it.
Manual explicit sends remain a separate API. There is no automatic hold release,
recall promise, sent acknowledgement, or imported-authority promotion.

## Trusted and owner ports

All methods are ordinary `Store` methods. Producer methods require a bound
supervisor Store and its exact original current machine credential. Browser
methods require an unbound Store and reauthenticate the original credential in
`BEGIN IMMEDIATE`, deriving owner and checking conversation scope before receipt
replay as well as fresh writes. A caller-supplied OwnerId is never authority.

* `bind_automatic_reply_route(credential, conversation, route_id, account_scope,
  expected_generation) -> AutomaticReplyProducer`: trusted connector configuration
  only. Expected zero creates a disabled route; replacement CAS advances generation
  and disables permission. Account scope is an exact bounded opaque trusted
  configuration value, not a provider/browser assertion. The producer privately
  retains owner, supervisor context/incarnation, namespace, conversation and route.
* `set_automatic_reply_permission_authenticated(credential, conversation,
  AutomaticReplyPermissionRequest) -> AutomaticReplyPermissionReceipt`: explicit
  owner permission with route-generation and permission-revision CAS plus key.
  Historical exact replay is read-only, including after a later disable; changed
  semantic input conflicts. Replaying an enable receipt does not re-enable it.
* `register_automatic_reply_input(credential, producer, source_namespace,
  source_input_identity) -> AutomaticReplyInputReceipt`: fresh trusted ingress.
  An identity is unique per owner and namespace, cannot change routes, and cannot
  adopt an imported identity. Recording ingress does not grant permission to send.
* `preserve_automatic_reply_input_authenticated(credential, conversation,
  AutomaticReplyPreservedInput) -> AutomaticReplyInputReceipt`: copy-only dormant
  evidence. Every imported input is held and never replayed, including no_record.
* `hold_automatic_reply_input_authenticated(credential, conversation, input_id,
  reason)`: negative-only owner hold, retaining the original hold reason.

There is no browser wrapper for trusted route or fresh-ingress issuance. Existing
mirror/progress flags are not interpreted as permission. Every future automatic
producer must use this boundary; this checkpoint does not claim legacy send paths
have been migrated or universally muted.

## Immutable effect and capability transfer

`reserve_automatic_reply(credential, producer, input_id, request_key, output_bytes)`
returns `AutomaticReplyReservationResult::Reserved(AutomaticReplyReservation)`
only once; exact later calls return `Replay(AutomaticReplySendReceipt)` without
write authority. A different key cannot evade the single reservation per input;
a reused key cannot select another input. Core copies 1..65536 exact output bytes
and computes lowercase SHA256. Durable intent binds input, route/account scope,
generation, issuing context/incarnation, permission revision, digest and length.

`consume_automatic_reply(credential, reservation)` consumes the opaque reservation
by value. Only a durable reserved-to-delivery_unknown transition can return
`AutomaticReplyConsumption::Deliver(AutomaticReplyDelivery)`. ReconciliationRequired
never carries bytes authority. Lost reservation/consume responses, reopen or
receipt replay cannot reconstruct either capability. No capability implements
Clone, Debug, Serialize, Deserialize, or a public constructor.

`with_automatic_reply_fence(credential, &mut delivery, offset, offered, action)`
checks current machine auth, supervisor context, route/account generation,
permission and input hold inside an immediate transaction. It supplies the exact
retained byte suffix to `action: FnOnce(&[u8]) -> Result<usize, E>`. Offered bytes
are 1..16384, offsets are strictly local and monotonic, and zero written bytes
means a known nonblocking no-write. The adapter must perform only a short actual
nonblocking write: no network/ACK wait, async work or nested Store operation under
the SQLite writer lock. The effect cannot be recalled after bytes are written.
Any callback error, invalid count, guard error or uncertain commit permanently
poisons the local capability. Bytes might already have escaped even if its durable
written count rolled back. There is no retry/reissue on that ambiguity.

`finish_automatic_reply_write(credential, delivery)` consumes a fully written,
current capability and returns a receipt still classified delivery_unknown.
Neither full local writing nor receipt replay establishes external sent/ACK
truth. There is deliberately no sent/recall/ACK method in this first slice.
Delivery getters expose the immutable consumed receipt, account scope and local
written count; the receipt's initial count is not a live progress projection.

## Preservation wire mapping

Exact serde definitions are `contracts/src/automatic_reply.rs`, with unknown
fields refused. Revision and source-generation enums are adjacently tagged:
`{"availability":"known","value":...}` or `{"availability":"unknown"}`.
Migration's proposed unknown/null shape therefore needs an explicit mapper;
unknown never means zero. Known revisions are lowercase 64-hex SHA256 strings.
Independent input and hold revisions are retained. Historical effects retain
classification, order and full u64 counts in JSON text, without SQLite signed
integer conversion. Source generation is provenance, not target authority.

Identity is namespace UUID plus nonempty opaque UTF8 identity <=512 bytes with no
controls. There are 1..5 distinct historical classifications: sent, sending,
uncertain, unknown and no_record; no_record does not establish unsent. created_at
is opaque retained provenance (<=128 bytes, no controls); no cutoff is applied.
Optional observed_at is either unknown or exact canonical whole-second UTC.
No source payload, live identity or private seven-input overlay is in fixtures.
Import is one record per transaction, so larger source sets can be partitioned
without dropping evidence. No imported record can be unheld by these ports.

## Validation scope

Tests use synthetic accounts/inputs and ordinary Store setup. They exercise exact
bytes and intent replay, two-pool one-fresh reservation, default-disabled routes,
changed input/key, consume and suffix permission/hold/replacement/revocation
refusal, disable/reenable fencing, serialized disable versus actual callback,
callback failure and a real deferred SQLite COMMIT failure after callback bytes.
The latter leaves durable unknown and permanently poisons the local capability.

Feature `fixture-test-controls` adds four bounded opt-in checkpoints:
`automatic-reply-reserve-before-commit`, `automatic-reply-reserve-after-commit`,
`automatic-reply-consume-before-commit`, `automatic-reply-consume-after-commit`.
The process test SIGKILLs the ordinary writer at each and verifies full read-only
ledger snapshots in fresh executables, including lost-response reserved/unknown
states. These facilities grant no dispatch authority and are never armed by a
production route. There is no actual WhatsApp/network/transport acceptance claim.

The required locked/offline wrapper run passed 297 Store library tests (four
existing subprocess-only entries ignored). After private capability-size lint
corrections, the final automatic-reply subset passed 12/12, including the four
actual SIGKILL windows, with no ignored cases. Strict feature-enabled Store
all-target Clippy and workspace formatting passed. Copy-first migration tests
retain exact old-row/FK/checksum/untouched-backup comparisons and explicitly
require all four new automatic-reply tables to be empty; no old evidence creates
permission or a fresh input. The schema-39 SQL SHA256 is
`afbdb3b02990e47409e5fb2a510a2fef5f1ea28ecb7f6ad79c4e4b4cceff5f76`.
