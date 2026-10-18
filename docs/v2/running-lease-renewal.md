# Same-process running lease renewal

The production Store exposes `authorize_running_renewal(&ConsumedProviderDispatch)`
before trusted Runtime moves the original consumed capability into its transport.
The returned `RunRenewalAuthority` is private, non-Clone and nonserializable. It
contains no input text, reservation, candidate or ability to start a provider.
Capture is permitted for an already consumed Starting or Running execution only.

`renew_running(&mut RunRenewalAuthority)` returns a private `RunLeaseTransition`
with `previous()` and `current()` read-only ProviderAdmission references. The
transition changes only lease_generation and lease_deadline_ms. In particular,
dispatch_fence, purpose, native session, binding generation, source and run remain
identical. The deadline remains bounded by the current supervisor deadline and,
for Worker runs, the original delegation expiry. Heartbeat is a separate operation;
neither API revives expired authority. No schema or dependency change is needed.

The write transaction authenticates the original machine credential and current
bound supervisor, validates the exact current execution envelope and requires
Running plus DeliveryUnknown. Pending cancellation, terminal state, revocation,
expiry and a concurrent renewal refuse without issuing another lease. An unknown
commit/reply outcome cannot justify provider redispatch or reconstruction of an
opaque renewal object. A stale original locator requires reconciliation.

Runtime must serialize renewal against its owned transport and Stop, and require
no pending observation or partial outbound suffix. It compares the entire previous
envelope, transfers the same owned process to a fresh Store fence, retires old
transport membership and preserves native/parser/turn identity and observation
sequence. This Store checkpoint alone does not implement that transport transfer.
No browser budget or liveness claim can authorize this operation.

Historical issued lease rows remain immutable. Already committed observation
replays under their exact old envelope/body return the original event and state
with duplicate=true. Unseen events and I/O under an old generation refuse. Runtime
must not rewrite a committed retry's generation or reset its event sequence.

For a Deep parent renewal, the same transaction first advances exact matching
Worker delegation parent lease/deadline snapshots, then updates the parent run.
This ordering preserves the existing parent-fence trigger: a true parent state or
fence change still blocks descendants. Child expiry, binding, dispatch fence,
locator state and issued lease history are not extended or recreated. The original
bounded Worker lifetime remains in force. Task control revisions are unaffected by
lease-only renewal.

Author tests cover public consumed-cap capture, Starting/terminal/Stop/expiry and
revoked refusal, independent-pool generation CAS, old observation replay versus
old I/O rejection, and preserved active Worker lineage without child extension.
Expiry control and private parent locator setup in two author cases are test-only;
no process, transport-refresh or long-running native-provider acceptance is claimed.

## Runtime same-child adapter

Capture `authorize_running_renewal(&cap)` before `ReadyCodex::attach` consumes the
capability. Under the same per-run scheduling lock used for polling and Stop,
check `CodexPump::renewal_quiescent()` before consuming the pump with
`renew_lease(store, &mut authority)`. `lease_deadline_ms()` is a trusted scheduling
hint, never browser authority. Pending observations, buffered parser events,
provider suffixes, interrupted/terminal streams, and refused receipts prevent
refresh. A failed consuming refresh quarantines the owned child.

The successful result returns a replacement local `Authority` and the original
pump with a new sealed Store fence. Parser/native/request state and the cursor's
next observation sequence remain intact. No process is spawned and no frame is
enqueued. The old local authority is retired before transfer completes, so its
later revoke cannot signal the refreshed process. A post-action transaction
failure closes the writer and returns no usable handle. This adapter does not
raise server budgets or qualify long-running native-provider execution.
