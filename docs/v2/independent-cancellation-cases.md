# Independent fixture cancellation acceptance cases

Status: authored procedures only; all C01–C08 are pending. No adapter source or
executable cancellation handoff has been reviewed or run. Contract baseline is
Core `537b7add3106b5089dc7d5188bfcd84ceda52b69`, with matching UI consumer
`450f8399431902e7fc6a6ab9f2ce5e12e8b57764`. Their compatibility reviews do not
approve future persistence or provider control.

Use synthetic owners/projects/messages and public fixture bootstrap, readiness,
admission, reserve/consume and cancellation ports only. Ordinary Store and
production starts must remain unavailable. Each independent case owns its home,
SQLite connections and child processes. No private context reconstruction,
provider/native locator artifact or live inference is permitted.

## Oracles and required handoff

Capture complete ordered rows in one read-only transaction before/after each
operation: supervisors, readiness, runs, issued lease history, reasoning inbox,
bindings, conversations, events, public outbox, observations, plus the exact
cancellation request/control-outbox tables introduced by the reviewed migration.
Include all columns and retain values in memory; do not print verifiers or tokens.
Refusal requires exact equality, not counts alone. Positive operations compare
only the explicitly permitted row/sequence changes and preserve unrelated scope.
Validate foreign keys and canonical replay bytes separately from projections.

Core must supply the exact adapter SHA, migration/table list, public way to obtain
the issued cancellation acknowledgement envelope, and typed opt-in checkpoints
before commit after all cancellation writes, and after commit before reply. The
same two windows are required for Stopped acknowledgement. No guessed table,
endpoint or checkpoint name is acceptance evidence. If a public facility is
missing, leave the affected case pending and request it; do not duplicate store
logic or serialize private supervisor authority.

## Cases

| Case | Independent actions and required result | Status |
| --- | --- | --- |
| C01 Request idempotency | Cancel Candidate and Reserved separately. NotDispatched commits exactly once with schema 3, fences execution, erases outstanding dispatch verifiers, retains occupied binding. Retry same principal/run/key across independently opened pools returns original receipt with no writes. Wrong owner and cross-run/key reuse follow the published scope policy without leaking another receipt. | Pending |
| C02 Consume/cancel race | Race independent connections at Reserved. If cancel wins, old reservation cannot consume and no fake I/O occurs. If consume wins, cancellation is Unknown/CancelRequested, never confirmed stopped. Assert one legal serialization, no surviving execution capability after cancellation, and no double consume. | Pending |
| C03 Refusal and terminal truth | Try wrong owner/context, unrelated project run, expired context, malformed key bounds and new cancel after Failed/Blocked/AwaitingAcceptance. Require the published error and full-row equality. An already committed same-key receipt may replay without rewriting terminal truth. Then exercise the untouched valid authority. | Pending |
| C04 Control-only authority | After DeliveryUnknown cancellation, old execution completion/renew/reserve/consume cannot regain authority. Issued CancellationAcknowledgement token cannot Started/renew/dispatch. Forged purpose, fence, lease generation/deadline, owner/session/run/attempt and wrong provider identity refuse unchanged. Exact valid acknowledgement remains usable. | Pending |
| C05 Stopped receipt | Exact issued control token appends contiguous Stopped once from CancelRequested: schema 4, Cancelled receipt, matching source IDs, canonical event/outbox and projection atomically. Same sequence/body replay returns original receipt after pool reopen, expiry and authorized successor takeover; changed body conflicts. New stale evidence refuses. No session reuse. | Pending |
| C06 Atomic rollback | Inject reviewed write failures at cancellation request/control-outbox/event and Stopped observation/event/outbox/projection boundaries. Require exact prior rows/cursor/token history and original receipt preservation. Remove failure and perform legitimate operation with no sequence hole or spent verifier. | Pending |
| C07 Cancellation process loss | Own child bootstraps through public APIs and arms typed cancellation checkpoint. Parent SIGKILLs only that child before commit or after durable commit before reply. Fresh exec opens exact home; immediate full-row snapshot proves rollback or complete commit. Same-key retry under publicly authorized context returns original committed receipt without another event/control row. | Pending |
| C08 Stopped process loss | Repeat actual owned SIGKILL before/after acknowledgement commit. Before commit: zero partial observation/event/outbox/projection changes. After commit: exactly one durable schema-4 receipt and exact replay after fresh-process authorization; changed replay Conflict, new stale evidence refused and sequence gap absent. | Pending |

For C07/C08, retain only public immutable input and public predecessor artifacts.
A fresh process must use documented bootstrap/reattach authorization; live-context
Busy and real deadline takeover are distinct assertions. Pool reopen or discarded
successful return is not process SIGKILL or a failed transport acknowledgement.
A completed committed-reply-loss probe does not prove general process recovery.

Report each executed case with exact implementation and test SHAs, required wrapper
commands, independent pass/fail counts, binary provenance and CI status. Keep
process, pool-reopen and injected rollback evidence separate. These procedures
provide no browser/native, approval/effect, lifecycle or production dispatch credit.
