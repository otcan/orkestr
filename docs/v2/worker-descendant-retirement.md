# Deep retirement with configured Worker policy

No new schema or public port is required. Use the existing
`retire_terminal_supervisor(machine, &parent_run)`,
`terminal_supervisor_candidate(machine, config, &conversation)` and
`reattach_terminal_supervisor(machine, config, &parent_run)` ports. Merely having
Worker policy configured is neither permission nor a durable reason to refuse.
Schema37's exact accepted/Stopped parent proof, original current machine
credential, context/incarnation, provider, binding and predecessor CAS remain.

The server must first stop scheduling with zero new dispatch, freeze all owned
setup/task/tool activity, finish owned cleanup, and retain the original Runtime
`ReapedBroker` witness for the parent and **each actually launched Worker**.
This includes setup-only and already terminal Workers. The witness aggregation
must be bound to the original owned identities, never reconstructed from PIDs,
state strings, expired deadlines, an empty ChildSet or caller booleans. Core
neither accepts those substitutes nor derives native reaping from its database.
The trusted retirement call is made only after this witness obligation, as for
accepted-only retirement. Configured-but-never-launched bindings need no invented
native witness. In-memory metadata grants are not persisted launch records;
the server must account for their children even when Core has no run yet.

Core now applies the same transaction-local negative descendant guard at all
three ports. These are necessary ledger predicates, not native cleanup proof:

- Every persisted run in the context, including each Worker, has its own exact
  canonical owner acceptance or matching issued cancellation-purpose Stopped
  evidence. Accepted and Stopped Workers may coexist with a terminal parent.
  Failed, Blocked, Starting, Running, AwaitingAcceptance, CancelRequested and
  ACK-only histories refuse, even if expired or the process has been killed.
- Every admitted provider delegation maps to its exact terminal Worker run.
  A never-admitted delegation may remain only if canonically blocked and its
  grant locator erased. This does not excuse any setup-child reap obligation.
- Pending owner tasks have already been durably held with claim hashes cleared
  by the canonical parent/task fences. Held and historical delegated tasks are
  retained; queued/claimed tasks or residual claims refuse. Nothing is requeued.
- Every confirmed Worker setup/readiness record has a matching terminal run at
  the released binding generation. Ready or Lost setup without such a run
  refuses; there is no new cleanup/recovery operation to manufacture one.
- Offline tools have committed Completed/Failed output evidence, or the separate
  exact cancellation acknowledgement and a canonical Stopped parent. Delegated,
  Blocked and DeliveryUnknown tool effects refuse. Tool completion alone does
  not settle a native result suffix.
- Every existing native tool-result record is fully delivered by the sealed
  finish writer with nonzero counted bytes. Bound, Prepared, DeliveryUnknown
  and partial/uncertain delivery refuse, including after parent Stop. No new
  abandon operation or retry is inferred from process cleanup.
- Every existing cancellation control outbox entry is acknowledged. Unfinished
  controls refuse. ACK alone still cannot supply terminal run evidence.

The guard writes nothing. Fresh refusal rolls back without provenance or lease
changes; candidate discovery returns no candidate for unresolved suffixes and
reattach rechecks under BEGIN IMMEDIATE before predecessor CAS. Current auth,
held inbox cuts, receipts, task payload/provenance and terminal history remain.
Restart reserves only the existing one-use parent metadata grant. No Worker
metadata grant, task, input, tool, result delivery or dispatch is recreated.

A preparing child with only an in-memory metadata grant still requires its
original server witness. A confirmed-but-unadmitted setup, blocked/failed run or
unknown effect intentionally remains reconciliation-required under these ports,
even after actual cleanup. This slice does not reopen historical work or claim
a general descendant reconciliation mechanism.

Bounded author evidence: six new ordinary Store tests plus the existing terminal
regressions pass (31/31 total, no skips). They exercise accepted and Stopped
Workers, held task/payload retention through restart, Failed/unknown/unaccepted
and unfinished cancellation refusals, confirmed setup without admission,
residual queued/claimed task and live grant drift, committed Completed/Failed
and exact cancelled tools, and Bound/Prepared/DeliveryUnknown versus fully
finished native responses. A post-retirement result drift also refuses both
candidate discovery and exact predecessor reattach without writes. Refusal
snapshots include complete task, payload, tool-delegation and result rows.
Executor callbacks in these Store tests are synthetic; they do not establish
native cleanup, server shutdown ordering or process restart acceptance.
Feature-enabled all-target Store Clippy, workspace fmt and diff checks pass.
