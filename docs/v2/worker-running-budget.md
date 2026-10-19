# Bounded owner-task Worker continuation

Schema 36 adds an optional owner `execution_budget_ms` to task requests and a
nullable persisted task column. Absent preserves legacy wire bytes, v1 digest
and the hard lifetime bound. Present explicitly opts into a finite total budget
between `lifetime_ms` and one hour; `lifetime_ms` then bounds the initial lease.
Changing this value under an existing key conflicts. Existing rows remain NULL.

Schema 35 adds an initially empty `worker_running_budgets` ledger. Existing task
lifetimes and generic renewal retain their previous hard bounds. No existing task
receives a budget during upgrade.

Trusted server setup may explicitly opt in before moving the genuine consumed
Worker dispatch into Runtime:

```rust
let renewal = store.authorize_worker_running_renewal(&dispatch, max_run_ms).await?;
```

This accepts only an explicitly owner-budgeted, owner-task-tagged Worker under its exact current machine,
context, incarnation and live consumed Deep parent. `max_run_ms` is 1..=3_600_000;
it is private host policy, never browser or provider input. The immutable absolute
deadline is anchored to original task creation, including setup time, and uses
the smaller of the owner budget and private host cap. Host opt-in alone cannot
extend a legacy task. Repeating
the same issuance preserves that deadline; a changed budget conflicts.

`renewal.hard_deadline_ms()` returns the captured effective absolute budget
(`Some`) or `None` for generic renewal. It is a scheduling hint, never authority.
When the current lease reaches that bound, composition must stop renewing and
schedule its existing durable Stop before expiry; the accessor cannot extend it.

Existing `renew_running(&mut renewal)` advances only the same Running run and
its admitted delegation, by at most 30 seconds from the transaction clock,
clipped to the immutable budget and current parent/supervisor deadlines. It
cannot revive an expired lease, pending Stop, revoked machine, terminal parent
or run. Generation CAS, committed historical replay and uncertain-reply rules
remain unchanged. It issues no input or dispatch capability. Runtime must perform
its existing quiescent same-process lease transition before further I/O.

After a successful durable renewal and Runtime transition, trusted composition
may call:

```rust
let tools = store
    .authorize_offline_python_renewed_parent(credential, &renewal).await?;
```

The returned opaque issuer uses the exact current Worker lease. Calling before
renewal, with a stale authority, after Stop, or with a foreign credential refuses.
Existing tool grants, results and deadlines remain unextended and stale; this
port does not reissue an old tool request or result delivery.

Author checks: five ordinary Store budget tests plus five existing renewal
tests cover owner-task restriction, immutable budget, legacy refusal, concurrent
CAS, stale tools, fresh tools, natural expiry, machine revocation, Stop and parent
terminal refusal. This is Store evidence; long-running native transport and HTTP
qualification belong to their owners.
