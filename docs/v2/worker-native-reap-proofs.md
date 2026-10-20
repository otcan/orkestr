# Original Worker native cleanup witnesses

`WorkerReaps` is trusted, in-memory factory state. It records every attempted
Worker native launch before `PreparingCodex::open*`, including a setup that
later fails before any durable Worker run exists. Each obligation is bound to
the actual metadata grant and then the exact consumed dispatch. The original
`ReapedBroker` must match namespace, incarnation, owner, session, run and initial
dispatch fence. Renewal retains this same native transport scope.

A failed or dropped launch witness permanently prevents factory retirement.
There is no PID, child-count, deadline, database reconstruction, caller boolean
or alternative constructor that can satisfy an obligation. Up to 2,048 parent
identities are recorded and 2,048 aggregate original parent/Worker witnesses are
reserved, including room for the current parent. Reaching either limit refuses
new work instead of discarding old evidence. An unresolved Worker does not by
itself erase later independent work or its original witnesses.

Completed Worker proposals retire their owned pump with no locally pending
tool/result work. The consuming transition detaches the exact original child
before dropping its execution authority. Its original wait proof remains in
`WorkerReaps` while the durable run stays `awaiting_acceptance` and its binding
stays busy; cleanup does not accept output. Later owner acceptance uses current
authentication and exact completion/revision correlation. Execution deadlines
do not erase a completed proposal after its original process is reaped. A Worker Stop retains its original
issued `ActiveControl`, then consumes it into `RetiringBroker` only after the
canonical interrupted terminal is committed. Both paths poll owned retirement
with a three-second bound. ACK-only, failed, blocked, expired, lost setup and
unknown paths do not supply proof. Core's separate descendant predicates still
refuse all unresolved persisted tools/results, setup or cancellation suffixes.

## Shared factory integration

The factory creates one `WorkerReaps::new(owner, conversation, namespace)` and
passes clones in `WorkerConfiguration.reaps` for **every** parent turn. A new
ledger per scheduler would lose historical obligations and is incorrect.

An ordinary parent proposal closes new task admission and durably holds queued
or claimed tasks. Already consumed children may finish under their unchanged
lineage, context, window and execution deadlines. No new child grant or parent
execution can be issued. Parent acceptance still refuses every unresolved child
decision; Stop, failure, replacement and revocation still fence descendants.
Migration 0044 changes this transition without restoring historical blocked rows.

Before dropping a scheduler after parent acceptance, Stop or shutdown:

1. Call `WorkerSchedule::quiesce()` to close task registration and fresh claims.
2. Bounded-poll `WorkerSchedule::drain().await`; it only checks exact terminal
   status, consumes already-issued Stop control, or collects original cleanup
   evidence. It performs no fresh setup, claim, inference or result delivery.
3. A refusal or timeout preserves an unresolved obligation. Runtime Drop still
   requests owned cleanup, but cleanup alone does not permit restart.

After an accepted parent continuation, keep the same ledger open. New parent
turns may create independent Workers while prior original proofs remain held.
Do not finalize at a per-turn boundary.

Only on final context retirement call
`WorkerReaps::finish(parent: ReapedBroker)`. It freezes new launches on every
outcome and is single-use. Success returns opaque, non-Clone `WorkerReapProofs`
retaining the original parent and all original Worker witnesses. Keep that
bundle alive across `retire_terminal_supervisor` and drop it afterward. Core's
current auth, exact terminal provenance and transaction-local negative gates
remain mandatory. An empty `ChildSet` is only an additional resource barrier.

The separate [stopped continuation handoff](worker-stopped-continuation.md)
retains prior parent proofs without final freeze. It does not reset or discard
any Worker obligation.

This leaf does not itself enable shared factory restart. Factory wiring and
actual HTTP/process qualification are separate integration requirements. Module
tests cover refusal and retention bounds; they never mint fake Runtime proof.
No actual provider account or production state is part of these tests.
