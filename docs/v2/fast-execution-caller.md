# Fixed-purpose Fast caller

`server/src/fast_execution::consume_fast` consumes only Core's exact non-inbox
`admit_fast` API. Inputs are immutable stored MessageId/EventId and the distinct
Ready Fast binding/generation, selected by the trusted supervisor. There is no
text, role, parent, inbox claim or effect grant in this caller.

The caller checks returned role, scope, purpose, native association and binding
before reserving. Replay and reconciliation return explicit no-dispatch outcomes.
FreshCandidate alone grants no provider permission: only ordinary reservation and
`consume_execution` can return the issuer-owned capability for same-child native
attachment. All errors, including Unavailable, propagate without a Deep fallback.

Core seam provenance: d3a3090961ec59d9fffa698689779f47d4715e13. Its durable
Fast adapter is currently Unavailable. The caller's real-Store refusal regression
proves no Deep execution appears and existing role bindings remain unchanged.
This checkpoint does not register a scheduler/router or claim Fast acceptance.
Core must publish the durable Fast lineage implementation before activation.
