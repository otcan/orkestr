# Ordinary Worker offline Python composition

This opt-in path connects an independently admitted Worker to one fixed offline
Python tool. It does not contain provider-internal tools, enable arbitrary shell
commands, or grant project filesystem or network access. Trusted provider
authentication remains outside the Python sandbox.

The existing private `worker` policy accepts three additional fields:

- `offline_python`: boolean, defaults to false.
- `broker_launcher`: canonical absolute path to the reviewed Worker broker.
- `broker_launcher_sha256`: exact SHA-256 of that private executable.

The launcher and checksum must both be present when the profile is enabled and
both absent when disabled. Validation checks the bounded executable, canonical
path, ownership-independent private permissions and checksum before supervisor
creation. Launch checks the executable again. The separate broker entry accepts
only `open-owned-worker-session --protocol orkestr-v2-provider-broker-v1` and
requires the issued Worker role; the ordinary Deep entry remains tool-disabled.

Shared factory composition supplies the validated launcher override through the
existing `WorkerConfiguration` launcher fields, and creates one
`Arc<OfflinePythonDispatcher>` using `OfflinePythonDispatcher::opt_in(bound_store,
machine_credential)`. It passes that object in
`WorkerConfiguration.offline_python`. The private credential never enters tool
arguments, native JSON, or browser responses. `WorkerPolicy::offline_python_enabled`
and `WorkerPolicy::broker_launcher` expose configuration only, not authority.

The ordinary single-conversation and configured-set loaders install this
dispatcher once per enabled conversation. Each dispatcher retains that scope's
bound Store and credential. An unavailable sandbox refuses startup; the configured
set retains its documented per-slot reservation semantics. No HTTP field enables
tools or chooses an executable. Worker-enabled parent replacement remains
unavailable until its separate recovery policy is qualified.

The Worker captures an opaque Core lineage handle before its execution capability
is consumed by Runtime attachment. Only Runtime's owned pending call supplies
source and exact native request/call/thread/turn correlation. A bounded owned job
then obtains a current Core delegation, runs the existing offline sandbox,
reserves actual completed output, and consumes its one-use result capability.
Runtime constructs the response and fences each actual suffix independently.
Changed source or correlation refuses before response construction or write.
Historical receipts never recreate a launch or result capability.

The Worker scheduling lock is never held while waiting for Python execution. The
parent-owned loop continues bounded provider reads and checks the existing typed
Stop mailbox. Stop commits before interruption; it aborts the owned tool future
and retains its cleanup condition until the blocking process owner has reaped
the Python child. Only then may the loop persist a correlated native interrupted
terminal. An ACK alone remains `cancel_requested`. Parent Stop, revocation,
expiry, malformed protocol, and uncertain result writes initiate owned cleanup
without inventing successful cancellation or task completion. Tool delivery does
not accept either the Worker task or its parent.

The focused acceptance fixtures use fresh synthetic homes, authenticated local
HTTP, the actual product broker, a synthetic native peer, and the actual offline
sandbox. They cover successful correlated delivery followed by owner acceptance,
Stop during Python execution, ACK-only uncertainty, revocation and unsupported
tool refusal. Their execution receipts must identify the complete composed source
and binary; the presence of these fixtures is not execution evidence. Real native
provider qualification, project tools, multi-provider parity and release soak
remain separate gates.

`worker_tool_http` registers all five process scenarios in the ordinary Rust test
suite on the supported Linux x86-64 sandbox target. The existing single-session,
multi-conversation, restart and Worker task suites remain regression requirements.

`v2/acceptance/broker_pending_tool_stop.py` runs the actual Channel from an exact
Git commit and preserves pending-call cancellation guards. The independent
`runtime_tool_source_guard.rs` and its adjacent fixture load as a private test
submodule of Runtime's `execution/offline_result.rs`; a test-only broker adapter
calls its own private pending-call decoder. They use genuine Store-issued result
authority with a synthetic executor attestation. That constructor check does not
claim actual provider I/O.
