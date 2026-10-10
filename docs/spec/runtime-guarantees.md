# Runtime guarantees (v0)

Status: draft v0. Each guarantee below has an id and the test that proves it.
Tests run against the `simulated` provider with fault injection, so they need
no credentials. They belong in `test/conformance/` (adapter-level) or
`test/agent-job-*.test.js` (runtime-level). A guarantee without a passing test
is a *target*, not a claim. Marketing copy may only cite guarantees whose
tests are green.

Terminology is defined in [agent-job.md](agent-job.md).

## Guarantees

| id | Guarantee | Test sketch |
| --- | --- | --- |
| G1 Durable admission | Once the trigger endpoint returns 2xx, the run exists on disk and will reach a terminal state, even across process restarts. | Admit, then kill -9, restart; assert the run reaches a terminal state. |
| G2 Run dedupe | Two trigger events with the same `run_key` produce one run. The second admission returns the first run's id. | Deliver the same webhook twice, including concurrently. |
| G3 Effect at-most-once with a reconcile hook | For tools with a `reconcile` hook, or with remote idempotency, a committed external effect is never performed twice for the same `effect_key`, whether the process crashes before, during or after the call. | The simulated PR tool crashes at each checkpoint; assert the external PR count is 1. |
| G4 No silent guess | An effect whose outcome cannot be determined becomes `unknown` and blocks the run in `awaiting_approval`. It is never re-executed automatically. | A tool with no reconcile hook, crashed after `intended`. |
| G5 Bounded attempts | A run makes at most `max_attempts` attempts across all providers, and interrupted attempts count. Repeated crashes end in `failed` (`recovery_loop`), not an infinite loop. | Crash at the same seq N times. |
| G6 Default-deny tools | A tool call not matched by `allow` or `approval_required` is rejected before execution and audited as `deny`. This holds for every adapter, including adapters with their own tool loop (see the adapter interface, "permission hook"). | Conformance: call an unlisted tool through each adapter. |
| G7 Approval binding | An approval executes exactly the effect it was granted for (`effect_key` + `args_hash`) at most once, and only before `expires_at`. | Change the args after approval; approve twice; expire. |
| G8 Spec pinning | A run executes the spec version it was admitted with (`spec_hash`), even if the job file changes. | Edit the job mid-run. |
| G9 Complete audit | Every terminal run has a sealed audit record containing the trigger, all attempts, every tool decision, approvals, effects and the outcome. No secret value appears in it. | Diff the audit against the fault script; grep for a canary secret. |
| G10 Notification once | Each `(run, event, channel, target)` notification is delivered at most once (connector outbox idempotency). | Crash during notify; restart. |
| G11 Cancellation | `cancel` moves a non-terminal run to `cancelled` within one lease interval. No new effect is started after the cancel is recorded. | Cancel during a tool call and during backoff. |

## Non-guarantees

* **No exactly-once for arbitrary tools.** Tools without reconcile or remote
  idempotency are at-most-once. After a crash their outcome may be `unknown`
  (G4), and a human decides.
* **No determinism of agent output.** A resumed or failed-over attempt may
  reason differently. Orkestr guarantees effects, not tokens.
* **No mid-turn token resume.** Resume happens at checkpoint granularity.
  Work in flight inside a model turn may be redone. Read-only tools may run
  more than once.
* **No guarantee across a lost data directory.** Durability is bounded by the
  storage under `ORKESTR_HOME`. Backups (`state-backups.js`) are the
  operator's responsibility.
* **No ordering between runs** of different jobs, and none between runs of
  the same job beyond `concurrency: queue` FIFO.
* **No timing SLA.** Schedule triggers fire at or after the scheduled time.
  Missed fires while the process is down are coalesced into one run per
  trigger on boot.
* **Provider limits are not hidden.** Rate limits and auth failures surface
  as `provider_error` and may trigger fallback. Orkestr does not proxy or pool
  provider credentials.
* **No sandbox guarantee in v0** beyond what each adapter reports through its
  capabilities (see `sandbox` in the adapter interface).

## Failure model

Covered: process crash (SIGKILL), host reboot, deploy drain
(`deploy-drain.js`), adapter subprocess death, provider timeout, provider
5xx/429, network partition to the provider, and webhook redelivery.

Not covered: disk corruption, clock jumps beyond lease length, and two
Orkestr instances sharing one `ORKESTR_HOME` without the storage lock.
