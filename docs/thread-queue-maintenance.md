# Thread queue maintenance

The operator-only `/api/threads/:id/queue` surface counts the complete persisted
pending input queue. Executor acceptance is not task completion; active native
turns are reported separately. MCP `queuedMessages` uses the same pending states
and includes inputs older than the most recent 200 transcript entries.

`POST queue/hold` accepts `{ "paused": true, "reason": "reviewed maintenance" }`.
It waits for the Codex dispatch boundary and prevents further dispatch without
interrupting an already running turn. New inputs remain recorded. Unsupported
runtimes reject the operation. Resume with `paused: false` after reconciliation.

`GET queue` returns every pending original record and its digest. Keep this
export private. `POST queue/consolidate` requires a stable `operationId`, a
preserved `summary`, and an entry for **every** pending ID with its digest and a
`retain` or `supersede` disposition. Superseding additionally requires reviewed
`reason` and `evidence` references. Only queued CLI/agent/watch reports without
any delivery evidence qualify. A CLI source alone does not prove automation:
operators must retain human instructions and uncertain provenance. Never mark
unexecuted work completed. The write-ahead ledger stores all originals before
mutation; superseded records remain in history with links to the summary.

The same operation is idempotent and can resume after interruption. A partial
failure leaves dispatch held. `POST queue/rollback` with the same `operationId`
restores only still-superseded, unexecuted originals. Restore cancelled watches
with `POST queue/restore-watch` and `watchId`; their cursors, rate limits and fired
IDs are preserved. No backlog or watch recreation happens implicitly.

Automatic watches can also contain old finals not yet forwarded because of rate
limits. Inspect `GET queue/watch/:watchId`, cancel the watch, then submit every
returned final ID/digest to `POST queue/reconcile-watch`, with `watchId`, stable
`operationId`, summary and `retain` or `summarize` decisions plus evidence. The
write-ahead ledger preserves the source messages. Only those exact completed
final revisions are skipped; cursors, rate history, pending inputs and failures
remain untouched. Changed or new reports remain eligible. Restore the watch
normally. `POST queue/rollback-watch` reverses this while held and cancelled,
revisiting the preserved cursor with original delivery idempotency keys intact.

Worker reports reserve DONE/BLOCKED/FAILED for substantive outcomes. Use NO_REPLY
for acknowledgements. CLI `send` records caller-thread provenance and supports
`--report-kind ack|result|blocked|failed|decision` and `--report-key <revision>`.
ACKs are internal records, not runnable inputs. Exact duplicate report revisions
from CLI and automatic watches share deduplication. New failure events and
changed reports remain eligible. Provenance does not grant human authority or
external delivery permission. Normal human inputs are not classified by wording.

Validated related-thread reports and automatic worker watches default to
`instant_steer`: they update an active Codex turn, or start a turn when idle.
Explicit `codexDeliveryMode: "passive"` or `steerActiveTurn: false` on CLI reports
preserves separate-turn delivery. Manual watches retain their passive default.
During a live turn, steering inputs can pass queued passive inputs; idle input
ordering remains FIFO and `/stop` keeps priority. Reports cannot answer a pending
human question or approval. Operator dispatch holds still prevent delivery.

To stop V1 from running model turns on undelegated threads altogether (rather
than holding one queue), see [V1 execution retired guard](v1-execution-retired.md).
