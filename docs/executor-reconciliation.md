# Read-only executor reconciliation

`scripts/sre/executor_inventory.py` inventories terminal executors without changing
sessions, sending messages or rebinding conversations. It uses Python's standard
library. Run it with the privileges required to read the selected process and
runtime metadata; inaccessible sources are recorded as unavailable.

Supply deployment paths explicitly. Reports and personal linkage inputs belong
outside the repository, preferably in a private overlay or operator state directory.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B scripts/sre/executor_inventory.py \
  --core /private/runtime/data/core.sqlite3 \
  --legacy /private/legacy/api-session-bindings.json \
  --routes /private/coordinator/route.json \
  --home /private/codex-home --home /private/claude-home \
  --socket /private/tmux/default \
  --socket-root /private/managed-tmux \
  --proposals /private/operator/task-links.json \
  --observations /private/operator/identity-observations.json \
  --output /private/operator/executor-register
```

The output is an atomically replaced JSON report and Markdown register, each mode
0600. Only reports are written. Source SQLite opens in `mode=ro` with
`PRAGMA query_only=ON`. The collector does not read message bodies, auth tables,
browser state or credential files. Process arguments/environment are inspected
only for provider classification and supported native identity fields; raw
arguments/environment are never included in output. Run without `--core` or
other optional inputs to produce a partial inventory.

Core native-session bindings establish canonical runtime ownership. Coordinator
routes establish posting destinations. V1 attachments are historical observations
and do not override either. Missing V1 delegation data does not prove a V2 route
failure. Transcript mtime is disk activity, never proof of a running executor.
A process existing at observation time does not establish that a turn is running.
Tmux grouped sessions retain multiple views of one pane. Symlink homes resolve to
one inventory source. Infrastructure processes can multiplex sessions; the report
does not infer native ownership from working directory or process count.

Task links are proposed associations, not Core mutations. Example private input:

```json
[
  {
    "native_session_id": "10000000-0000-0000-0000-000000000001",
    "project": "Stability",
    "task": "Investigate connector recovery",
    "role": "investigator",
    "source": "operator-reviewed terminal audit"
  }
]
```

Some terminal clients expose no native ID in supported arguments or their own
provider's selected environment field. Reading another provider's transcript or
inheriting its environment variable does not establish identity. Explicit identity observations can join
an independently audited identity to a process. Require the PID and its Linux
`/proc/PID/stat` start-time ticks to prevent a stale PID assignment after reuse:

```json
[
  {
    "pid": 12345,
    "start_ticks": "987654",
    "provider": "claude",
    "native_session_id": "10000000-0000-0000-0000-000000000001",
    "source": "provider agents inventory and terminal ancestry"
  }
]
```

A proposal never changes `ownership: unknown` into `core-bound`. Missing inputs,
unknown IDs and unobserved processes remain explicit. Historical transcripts
without a process or Core binding are not enumerated as current executors.

Validation:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B -m unittest discover \
  -s scripts/sre/tests -p test_executor_inventory.py -v
```

## Approval handoff extension

`scripts/sre/source_handoff.py` is a transport-injected durable decision handoff.
It freezes request/decision identity, original conversation/run/native executor,
provider generation, action and resource before calling transport. The injected
transport must authenticate the source endpoint and return an admission receipt.
The body uses agent attribution and original-run/provider fences. A scoped
approval record changes no runtime privilege and leaves task ownership at source.

A protected private adapter must authenticate intake, validate module/state
custody, provide the authenticated client and enable delivery explicitly. The
extension itself does not install services or send messages. Unknown outcomes
and crash-after-claim records never automatically replay; changed scope/target
under the same decision ID is refused. An admission receipt does not prove work
completion. Operator receipt reconciliation is required after an unknown outcome;
automatic reconciliation and business-result ingestion are outside this extension.
