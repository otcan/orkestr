# Owned-session broker client checkpoint

`orkestr-runtime::broker::BrokerOpen` implements only the proposed
`orkestr-v2-provider-broker-v1` metadata handshake. Construction derives provider,
role, owner, session, namespace and incarnation from Core's private issued
`BoundSessionMetadata`; caller JSON cannot create an issuer grant. One correlated
`OpenOwnedSession` request accepts only the matching identity and an opaque,
metadata-only handle. Replies are bounded to 16 KiB; unknown result fields,
credential-shaped additions, foreign identity and malformed replies refuse and
poison the exchange. The handle has no public accessor or inference methods.

This codec does not launch a broker, confirm native readiness or authorize a
turn. Its request is not yet part of the containment metadata whitelist. The
separate `containment/broker.rs` launcher boundary is owned by Isolation and must
be reviewed before registration. It uses only the configured trusted executable
and fixed `open-owned-session --protocol orkestr-v2-provider-broker-v1` arguments,
with the existing cleared environment and disposable directories.

Canonical connector ownership must supply the broker implementation and grant
policy. Existing production sockets, profile paths and credentials are not
fallback locators. No broker availability is claimed by these protocol tests.
Execution attachment must consume the original metadata child, Core readiness
transition and one-time consumed dispatch capability under the actual execution
fence. Neither JSON identity nor the opaque owned handle grants inference
permission. A trusted attach wire operation remains a review prerequisite.

## Proposed typed containment admission

The proposed operation is `MetadataChild::open_broker_metadata(&self) ->
Result<BrokerOpen, Error>`. It accepts no JSON, identity, handle or caller frame.
Only the private trusted broker launcher can mark a child eligible. Under the
metadata state lock, the operation requires Setup, the original live grant and
an unused per-child open latch. It derives the codec directly from that grant,
serializes the fixed request internally and queues it within the actual metadata
fence and transport frame bound. It returns the submitted codec only after that
operation commits; ordinary bounded stdout polling supplies its reply.

The attempt latch is spent before queue submission. Any uncertain queue/commit
outcome quarantines the child and yields no replacement open. A second open,
revoked grant, ordinary direct-provider child and raw `OpenOwnedSession` through
`enqueue_metadata` must all refuse. The general metadata whitelist stays closed.
This is a proposed API for Isolation's launcher implementation, not an operation
implemented by this document. Its source and negative tests require review.
