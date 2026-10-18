# Opt-in Worker native tool transport

This callable transport requires the Core schema-32 native result ledger and
`CompletedToolDelivery::matches_source` successor. It does not register a server
scheduler or authorize a sandbox launch.

Trusted setup uses
`PreparingCodex::open_worker_offline_python_retained(Store, BoundSessionMetadata,
&Path launcher, &Path workspace, ChildDirectories, Box<dyn Send + 'static>)`.
Only a fresh Codex Worker metadata grant is accepted. The fixed launcher argv is
`open-owned-worker-session --protocol orkestr-v2-provider-broker-v1`. Installation
must pin the reviewed Worker broker package; the default constructor keeps tools
disabled. Normal `poll`, consuming `confirm`, and consuming `ReadyCodex::attach`
retain the same child and actual provider writer.

`CodexPump::pending_offline_python() -> Option<&PendingOfflinePythonCall>` exposes
borrowed request ID, call ID, thread ID, turn ID and exact source. This is native
correlation, not authority. Capture Core's retained Worker parent before attach;
use its current credential and native delegation/result ports for sandbox work.
Never await the sandbox while holding the per-run scheduling lock.

`write_tool_result(&mut self, &Store, credential: &str, CompletedToolDelivery)`
consumes the sealed delivery. It checks source and exact call identities before
constructing the sole native response. `poll_tool_result(&mut self, &Store,
credential: &str).await -> Result<bool, Blocker>` performs at most one bounded
actual suffix under the dedicated Core result fence. The credential stays local.
Each suffix rechecks the pending source and child lineage. Errors quarantine;
no result grant or suffix is returned for replay.

Under the existing per-run lock, continue normal flush/step polling to receive
BrokerPrepared, call poll_tool_result for bounded writes, and continue step to
receive the correlated null reply. A true result means Core finish and the broker
reply both completed. Prepared alone never admits the reply. Continue ordinary
progress polling while sandbox work runs. Transfer and lease refresh refuse a
pending tool/result. Issued cancellation retires pending correlation and any local
result writer; ACK alone remains insufficient terminal evidence.

No real native tool, sandbox-to-native HTTP flow or production activation is
claimed by this transport checkpoint. Server orchestration and immutable package
selection require separate integration and acceptance.
