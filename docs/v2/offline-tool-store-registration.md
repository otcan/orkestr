# Offline Python Store registration

The ordinary Store registers the reviewed `production_runtime/worker_tool`
implementation from commit `f21eeb2e`, without changing its authority semantics.
It exports OfflinePythonDelegation, ConsumedOfflinePython, admission/consumption
results, outcome, receipt and state. All opaque grant fields remain private.
Migration 0017 remains the sole ledger. No root manifest, lockfile, schema or
provider role admission is changed by this registration.

Core adoption is scoped to that Store subtree. The matching runtime sandbox
spawn-only refactor and server callable remain separate scoped integration inputs
from the same helper commit; this registration does not claim their execution.
Offline Python is a bounded subordinate tool, not a persistent Worker provider
session, nor permission to reinterpret a parent provider capability as a task
or tool grant. Issuance and one-use consumption remain required before spawn.

Current credential and exact parent authority are checked before grant replay,
consume, spawn, monitoring and completion. Only actual bounded spawn belongs in
the short SQLite fence; process wait and cancellation monitoring stay outside.
The separate exact cancellation-purpose acknowledgement records confirmed cleanup,
not a fabricated provider Stopped event. Loss of current authority quarantines
output and leaves uncertain delivery unconfirmed.

The injected post-spawn/pre-commit failure cleanup regression remains outstanding.
Provider execution-fence rollback tests do not cover this distinct worker fence;
no actual disk/COMMIT failure or full-release qualification is claimed here.
