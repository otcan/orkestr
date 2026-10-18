# Admission receipt: role and replay dispatch safety

Source extension against runtime migration 379d0b5e and its consumed e2de7312
application port. This narrowly patches the reviewed start path; coordinator must
reconcile later port branches before integration. No adapter/schema is implemented.

admit_run(owner, RunAdmission) now returns RunAdmissionReceipt containing owner_id,
run: RunRecord, session: SessionBinding and dispatch: AdmissionDispatch (Fresh or
Replay). All types remain application-only and native Future + Send is unchanged.

Fresh is a per-invocation transaction outcome: only the invocation that inserts
the Starting admission and acquires the session turn may receive it. Concurrent
identical calls receive Replay; changed payload conflicts. Never store/replay Fresh
as part of the idempotent receipt. Replay cannot start a provider even when the
stored state is Starting, Running or terminal. Unknown dispatch after a crash is
quarantined for reconciliation, not automatically retried. This is not proof of
exactly-once external execution or a reusable durable dispatch token.

Before start, runtime validates receipt owner against authenticated owner; run task,
conversation and session against the requested task/claim/execution lease/supervisor;
returned session ID/conversation against the run; returned lease generation against
execution lease. Derive role only from receipt.session.role. Any expected-role
argument is an assertion: mismatch refuses start, never relabels the session.
Provider start requires Fresh, run Starting, positive current lease/fence and an
appropriate confirmed session. Replay returns existing result without start or an
explicit non-dispatch blocker. A missing dispatch must not trigger blind recovery.

Admission and cancellation remain separate. CancelReceipt authorizes only an
interrupt-control envelope, never start/poll. Deep inbox and execution leases stay
separate; worker execution must not consume a second deep claim. A receipt is not
effect dispatch authority. A future durable dispatch claim, if needed, requires
its own reviewed store transaction and crash semantics; no runtime store is allowed.

Required runtime regressions: mismatched role/owner/session/scope never calls start;
active and terminal Replay never calls start; identical concurrent admissions yield
at most one Fresh; Fresh is never returned from persisted replay. Core SQLite must
also prove atomic admission rollback, uniqueness and restart unknown-dispatch
quarantine. Spy tests or compilation cannot establish these durable cases.

No root manifest/lockfile, dependencies, SQL, migrations or CI are changed. Source
checks only; typed tests and durable acceptance remain pending. Core stays LIGHT.
