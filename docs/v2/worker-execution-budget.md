# Bounded ordinary Worker execution

Longer owner-task execution requires two explicit settings. Private host Worker
configuration supplies a finite ceiling:

```json
{
  "mode": "owner-tasks-v1",
  "lifetime_ms": 30000,
  "execution_budget": {"max_run_ms": 600000}
}
```

The owner also includes `execution_budget_ms` in the ordinary task creation
request, for example `120000`, while retaining `lifetime_ms: 30000` for the initial
lease. Without the owner field, that task keeps its original hard lifetime even
when the host enables longer execution. Without host opt-in, the server retains
the existing short execution behavior. Parent-input-once Workers cannot use this
budget mode.

The durable maximum is the smaller of the owner budget and host ceiling, anchored
to task creation. Queue and setup time count toward that total. Neither a retry
nor a lease refresh moves the anchor. The host ceiling is 30 seconds through one
hour; optional `max_idle_ms` is one second through that ceiling. Only committed
native observations reset the inactivity clock. No inactivity limit is inferred
when this optional field is absent.

Core issues the renewal handle from the genuine consumed owner-task Worker grant.
The server uses Runtime's existing consuming transfer to retain the same native
child, turn, run, scope and observation cursor. Each lease remains at most 30
seconds and is also clipped to the current live parent, supervisor and immutable
budget. Expiry, Stop, revocation and parent retirement cannot be renewed.

Renewal is attempted under the existing per-run control lock only when native
transport and the owned offline-tool job slot are quiescent. The server does not
retry a failed consuming transfer. An immutable deadline already reached by the
current lease causes no further renewal attempt. The local scheduler requests
durable cancellation before the current lease ends; actual terminal evidence is
still required before the task can be reported cancelled. Cleanup alone leaves
an uncertain outcome.

After a successful transfer, the server obtains new opaque lineage for future
offline Python calls. Existing calls, source digests, one-use results and tool
deadlines are unchanged. Python still has its separate five-second execution
limit. Stop aborts the owned tool job, retains its resources through physical
reaping, and uses the same typed cancellation path as an ordinary short Worker.

The process harness `v2/tests/worker_budget_http.py` uses actual elapsed time,
ordinary authenticated HTTP, a synthetic native executable, and the fixed Python
sandbox. Its five scenarios check execution beyond 30 seconds with a subsequent
tool result, Stop and physical cleanup after renewal, revocation, preservation of
the legacy owner deadline, and an explicit owner budget below the host ceiling.
It never rewrites the clock or expiry rows. Running the harness against an exact
source/binary pair is required; source fixtures alone are not acceptance evidence.
Real provider execution and broader release qualification remain separate gates.
