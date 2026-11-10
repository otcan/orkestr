# Independent runtime transaction probes

Status: authored procedures, **not executed or passing acceptance**. Contract basis:
application runtime port v5 at `8acc370d0ced3c808d5af02c1b70ef95557b0a24`;
fixture context reviewed at `6975afac0759ac5dc6c6f81dabed3a8b5b8bd6ab`.
Consume an exact implementation commit after source review, not a moving branch.
The fixture context alone implements no readiness/admission/reserve/consume path.

## Execution boundary

Use synthetic owners, projects, messages and ExplicitFixture identities only.
Each case owns a fresh isolated home and database. Open two independent Store
pools against that database; clones sharing a pool are insufficient race evidence.
Use a barrier immediately before competing calls, retain both results, then close
both pools and open a third pool before checking committed state. A retained live
fixture handle may reattach to that pool; this is pool reopen, not process restart.
A process-restart claim requires an explicitly reviewed recovery bootstrap.

Build/test only through the assigned Cargo wrapper with the verification lane's
isolated home/target. No provider inference, production profiles or HTTP runtime
routes are needed. Never create an alternative schema/store or hand-write rows to
manufacture authority. Read durable projections through published fixture queries;
if unavailable, request Core's narrow read-only oracle instead of guessing tables.

For every result record exact commit, source/test hashes, wrapper command/exit,
individual assertions, independent connections used, failpoint location and whether
reopen occurred. Nested scenario counts remain separate from Rust runner counts.
Missing prerequisites are pending, never skipped-as-passing or replaced by Spy.

## Cases and durable oracles

| Case | Procedure | Required oracle after independent reopen |
|---|---|---|
| R01 atomic admit/ack | Obtain one real durable inbox claim and ready deep binding under the fixture supervisor. Race identical admit_run calls across pools. | Exactly one Starting attempt and acknowledged claim, linked together; one FreshCandidate, other Replay/reconciliation without another dispatch key. Original IDs persist. |
| R02 changed replay / wrong authority | Replay same admission key with changed semantic input; substitute fast/worker, consumer, owner, conversation, session, generation or fence one at a time. | Refusal; no extra attempt, claim acknowledgement, candidate or reservation. Compare complete scoped baseline projections, not only total row counts. |
| R03 admission rollback | Core failpoint fails after attempt insertion but before claim acknowledgement, inside the same transaction. Reopen and retry original request. | Neither partial attempt nor acknowledgement survives; retry inserts once with one legitimate candidate. An ordinary postcommit connection loss is a different case. |
| R04 reservation race | Race claim_provider_dispatch for the same valid fresh candidate across pools. Repeat original call after reopen; forge enum/key or change request content separately. | One reservation winner only; retry/forgery cannot mint another reservation. Run/binding/supervisor identity and original key association persist. |
| R05 consumption race | Race consume_provider_dispatch for one reservation across independent pools. Put a FAKE I/O counter strictly after a successful DispatchNow return. | Exactly one DispatchNow and at most one FAKE call; durable DeliveryUnknown precedes that call. Other contender/reopen returns reconciliation, never permission. |
| R06 consume lost ACK | Reviewed failpoint commits DeliveryUnknown, then withholds/fails reply before caller receives DispatchNow. Caller must make zero FAKE calls. Reopen; recreate only the FAKE provider and retry original reservation. | DeliveryUnknown survives and retry returns reconciliation; zero redispatch. Preserve original reservation/run identity. Provider recreation alone is not reopen evidence. |
| R07 takeover fence | Reserve under supervisor A. Use Core's test-only expiry control; race exact-predecessor takeover across pools. Retry old admission/reservation from A after winner B commits. | One new incarnation; A is fenced and its predecessor reservations quarantined in that same takeover transaction. No old consume permission; other namespace/key remains unchanged. |
| R08 unavailable / unresolved readiness | Call through ordinary Store or fixture context lacking published readiness. Inject reviewed store errors before consumption commits. | Explicit unavailable/refusal and zero FAKE I/O. Unknown commit outcome requires reconciliation, not an assumption of rollback or retry permission. |

For R05, an ordering spy is insufficient: observe committed state from a separate
connection at the fake I/O boundary. For R06, a trigger-induced SQL rollback does
not simulate a committed reply lost to the caller. If a process failpoint is
published, own the child handle, wait for its committed checkpoint, kill/wait only
that child, and reopen its exact home; never kill by port or process pattern.

## Concrete handoff needed before execution

At the reviewed fixture-context checkpoint, all R01–R08 remain pending. Core must
publish the exact transaction implementation SHA and its reviewed fixture methods
for ready deep binding/inbox claim setup; read-only attempt/ack/reservation state;
transaction rollback injection; committed-consume-before-reply checkpoint; and
bounded supervisor expiry/takeover controls. No arbitrary clock setter, raw SQL
write authority, production effect endpoint or fake durable ID is requested.

Review transaction scope, candidate verification, owner/session/attempt association,
store clock/fences, rollback and commit-before-reply ordering before compiling the
candidate. Then run bounded isolated wrapper checks and independent cases against
that same SHA. Coordinator independently reviews these authored procedures/tests;
Verification does not approve its own acceptance work.
