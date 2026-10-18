# Parent-owned independent Worker scheduling

`worker_execution::WorkerSchedule` composes the ordinary Core Worker admission
and Runtime native provider transport. It is an optional trusted server policy,
not an HTTP authority input. `WorkerPolicy` accepts only
`{"mode":"parent-input-once-v1","lifetime_ms":30000}` with a lifetime from 1
through 30,000 milliseconds. This schedules one independently bound Worker for
the parent's immutable input; it is not general task decomposition.

The factory calls `prepare(Store, credential, WorkerConfiguration,
&ConsumedProviderDispatch)` immediately before moving the Deep capability into
native attachment. Preparation captures immutable locators and both source IDs
from that capability, without retaining or cloning its authority. `poll()` runs
in the parent's lifecycle, including while Deep awaits owner acceptance. The
factory drops the old scheduler before attaching a successor Deep run.

The scheduler waits for the exact parent to be durably Running, creates a
distinct Worker binding, and obtains parent-bound metadata authority. Core
rechecks current authentication and exact parent lineage at setup spawn/write
and readiness. The scheduler then consumes one opaque Worker delegation,
reserves and consumes its ordinary dispatch, and attaches the separately owned
native child. Unknown delivery or lost admission replies do not trigger replay.
Worker admission does not consume another Deep inbox item.

At most four Worker children, including pending reapers, hold global scheduler
capacity. Capacity exhaustion refuses immediately rather than adding a hidden
queue. Setup has a 15-second local deadline. Worker execution has the configured
deadline and Core's authoritative clipped lease. Each child has a fresh private
scratch directory; Runtime's retained-resource port owns that directory and
capacity through actual child reap, including setup failure. Private directories
and filtered environments are not an OS sandbox for provider-internal tools.

An execution deadline commits an exact Core cancellation receipt, then hands it
to the shared cancellation mailbox and Runtime Stop adapter. Parent termination
fences descendants in Core; local cleanup cannot fabricate Worker Stopped or
successful completion. Owner acceptance remains explicit for each proposal.
Current factory composition has one Deep browser Stop gate: parent Stop fences
and cleans up descendants, but direct Worker-run browser Stop needs a separate
multi-run gate and is not advertised by this module.

`apps/server/tests/worker_execution.rs` compiles the separate modules and checks
strict policy and owned-directory cleanup. `tests/worker_execution_http.py`
requires the ordinary factory hooks and actual server/product-broker processes
with a fixed synthetic native peer. It asserts distinct native sessions, exact
input lineage, independent owner acceptance, revocation, parent-terminal fencing,
parent HTTP Stop, and the Worker's own deadline interruption without stopping
Deep. Direct child browser Stop must refuse before any child cancellation write.
These checks are not real Codex/Claude execution, normal
browser latency, production activation or full-release qualification.
