# v1 admission dispatch result extension

Base: d4cf693435378ed232d97df60727ea6e54d9b90b, explicitly selected by the
runtime consumer. This extension preserves its async-trait 0.1.89 dependency,
u64 generations, role-bearing RunAdmission and cancellation-only purpose.
Coordinator owns dependency/lock integration; no lock changes are made here.

application::runtime::RunAdmissionResult { admission: RunAdmission, is_new: bool }
is returned by admit_run. Only the transaction invocation that first commits the
Starting admission and atomically claims the session turn/hands off the inbox may
return is_new=true. Concurrent identical calls have at most one true result.
Every identical replay returns the original admission with is_new=false, even if
its purpose is Execution. Changed semantic input conflicts. The boolean is a
per-call outcome, never a persisted original receipt that can be replayed true.

Runtime validates owner/conversation/session, authoritative role, Execution purpose
and valid lease/fence before starting. is_new=false must return an existing result
or explicit non-dispatch blocker and must NEVER call provider.start. Active and
terminal replay are equally non-dispatching. A crash after commit but before start
leaves dispatch unknown and requires recovery/reconciliation, not automatic retry.
This prevents replay starts; it does not prove exactly-once external execution or
introduce a durable reusable dispatch token. Cancellation control is never start
or poll authority. Any later dispatch-claim protocol needs separate reviewed core
transactions and crash tests; runtime must not add a persistent store.

Required regressions: expected-role mismatch causes no start; identical active and
terminal replay causes no start; simultaneous identical admission has one fresh
result; crash/reopen cannot reissue fresh dispatch. Core must prove these against
SQLite, not only runtime spies. No adapter is implemented by this source extension.

This two-file patch changes no root/lock, SQL, migration, CI or dependency pin.
It is independent of the earlier receipt extension against379d0b5e: coordinator
must select/reconcile one consumed port base, not combine incompatible signatures.
New typed build/tests remain pending. Core remains LIGHT.
