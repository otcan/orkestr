# First-slice black-box probe procedures

Specification only; all cases in `v2/acceptance/cases.json` remain pending.
Use the published server/fixture contract when available. Do not implement a
second store or infer runtime success from an HTTP response shape.

## Admission and restart (A03/A04)

Create a synthetic authorized project and record its empty snapshot watermark.
Release ten authenticated HTTP clients from one barrier, each sending identical
`{client_message_id, text}`. Require exactly one 202 and nine 200 responses with
the same message/event/sequence. Snapshot and test-only durable counters must
show one new message, event and inbox entry. Retry with changed text and the same
key: require 409, unchanged IDs/counts and no extra model turn. Repeat the same
key in a different authorized conversation to verify the documented key scope.

After receiving acceptance, kill the test-owned server PID without graceful
shutdown. Restart with the same isolated home; authenticate again and compare
message IDs, text and ordered inbox watermark. Retry the original request after
restart and require the same receipt. Do not clear the home between process
lifetimes. Kill-before-acknowledgement is a separate ambiguous-receipt case: retry
must converge to one durable admission, whether the first transaction committed
or rolled back. It must not assume every interrupted request was persisted.

## Authority and fencing (A07–A12)

Acquire lease generation G, block a completion, then replace it with G+1.
Release the old completion and attempt an old-generation effect. Verify both
are refused and no canonical completion/effect-sink invocation occurred. Repeat
with an already terminal run; terminal state must not regress.

For stop, park a fake provider before interrupt acknowledgement. Send cancel
and observe its durable fence while the provider remains blocked. Attempt a new
dispatch using authority admitted before cancellation: zero sink invocations.
Release an action already dispatched before the fence and verify it is reported
as in-flight/completed/unknown according to evidence, never described as undone.
Restart before interruption acknowledgement and require the fence to survive.

Create one exact pending approval. Independently mutate target, arguments, scope,
expected version and expiry. Each invalid decision must leave sink count zero.
Race two valid decisions and require one consumption. Replay that decision after
restart and require no second dispatch. Owner-role text supplied by a worker must
not change the principal, lift a hold or authorize this approval.

Place deterministic crash barriers before intent commit, after intent commit,
and after sink dispatch but before receipt persistence. Only the first case may
be safely absent; ambiguous dispatched effects are quarantined on reopen.
Repeated recovery cannot invoke the sink again without a documented reconciled
idempotency result or a new authorized decision. Preserve the distinction between
one local dispatch attempt and proof of one remote effect.

## Streaming and access (A06/A09)

Capture SSE through sequence N, disconnect, admit more inputs, then reconnect
using Last-Event-ID. Compare received event identities/order with the authorized
snapshot; the client applies each identity once. Also test stale, malformed and
foreign-scope cursors. Stale cursors require explicit resync; foreign cursors
must not expose event data. Throttle one consumer while other clients admit
messages and measure bounded server buffering and receipt latency independently.

Use a fixture principal explicitly lacking access to project B, rather than
assuming two projects of the same owner are mutually inaccessible. Attempt B's
conversation, events, run, cancellation, holds and approval decisions. Require
denial before mutation, no transcript leakage, and unchanged sink counts.
