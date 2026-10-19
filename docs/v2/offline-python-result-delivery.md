# Offline Python native result authority

This Store leaf supplies authority for a future ordinary Worker tool composition.
Its Store tests use synthetic executor attestations. They do not establish actual
broker routing, sandbox invocation, provider execution, or release readiness.

`OfflinePythonParent` comes from an actual consumed Worker dispatch before Runtime
attachment. It retains delegation lineage only. The server may populate
`OfflinePythonNativeCall` only by borrowing Runtime's sealed pending call; the
public fields are bounded correlation data, never authority. Core validates the
current credential, exact live Worker and native thread, then atomically records
the call and existing offline delegation. Native request ID kind is preserved.
One request/call identity cannot be rebound within a native turn, and each Worker
run permits at most 32 native tool calls. Source is 1–32768 UTF-8 bytes, without
NUL. The server uses a fixed tool/profile; provider text cannot choose a launcher,
environment, credential, filesystem mount, network policy, or owner.

The trusted sandbox executor calls `prepare_offline_python_result` only after
physical child termination, with its genuine consumed launch and exact bounded
output. Core checks the spent launch and current Worker/parent authority, computes
the digest of the complete raw output and process status, and renders bounded
native text. Truncation of display text does not truncate the evidence digest.
Nonzero process exit or a terminating signal yields `success=false`; this is not
task acceptance. Sandbox timeout/cleanup uncertainty without process output does
not qualify for this output-bearing result API. It remains unknown/quarantined.

Preparation issues one private `OfflinePythonResultReservation`. The result table
does not recreate a reservation after a lost reply, even while still `prepared`.
`consume_offline_python_result` commits `delivery_unknown`, clears the grant hash,
and issues one non-Clone `CompletedToolDelivery`. Concurrent consumption has one
winner. Reopening, exact replay, a public completion receipt, or reconstructing
request IDs cannot issue another capability. Current authentication is rechecked
before even historical replay is returned.

Runtime must match the sealed capability's parent, call, source and actual owned
child, then construct the closed native JSON response itself from `text()` and
`success()`. Broker `ToolResult`/`BrokerPrepared` is correlation only. The broker
never writes provider stdin. Every actual nonblocking provider-stdin suffix runs
through `with_offline_python_result_fence`; no more than 16384 bytes may be offered
per call and the whole frame is at most 65536 bytes. Offsets are monotonic and
successful byte counts are persisted. A known zero-byte nonblocking result may be
retried at the same offset. Any error, stale offset, authority refusal or uncertain
persistence permanently poisons the local capability. The earlier durable unknown
state survives even if bytes were written and the later accounting transaction
fails. Stop between two suffixes refuses the next write.

After all bytes are written, Runtime consumes the capability through
`finish_offline_python_result`, supplying the complete prepared frame length.
Only then can the result row become `delivered`. That state is transport evidence;
Worker completion and owner acceptance still require their existing observations
and actions. Partial/error/drop paths retain `delivery_unknown` and require
reconciliation. Pending tool/result state must block session transfer or renewal.

Migration 0032 is additive. Existing tool history is preserved without inventing
native calls or result authority. Core owns shared registration and preflight
review. The scoped tests include actual ordinary Store upgrade/reopen, separate
SQLite-pool contention, output substitution, current auth after revocation, parent
and Worker Stop, partial writes and injected persistence failure after the effect.
No fixture claims live sandbox or provider proof.
