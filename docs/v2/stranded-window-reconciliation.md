# Stranded execution window reconciliation

An execution window is opened by one server process. Its private window credential
lives only in that process's memory. `retire_execution_window` needs that exact boot ID
and credential, plus `accepted` or `stopped` terminal evidence.

Suppose the process stops while the window still has work. For example, Fast and Deep
proposals are waiting for owner acceptance. No later process can then retire the
window: Core keeps it `reconciliation_required` and the manager keeps it `reconciliation`.
That conversation can then never open another window. Before concurrent conversations,
the window also blocked every other conversation of the owner.

## Recovery

Recovery happens in four steps. Each step is idempotent.

1. **Core negative mark.** A process that does not own the window marks it
   `reconciliation_required`. This is the same mark that a status read applies today.
2. **Core plan (read-only).** A plan is made only under all of these conditions:
   - The window is credential-bound.
   - Its supervisor is still the window's own incarnation, so no takeover has happened.
   - Every unresolved run in that incarnation is a Deep or Fast `awaiting_acceptance`
     run with exactly one completed proposal, a busy binding and no live descendants.
   - Descendant effects are clear.

   The prior run is the window's last Deep run.
3. **Manager `reconcile`.** The window must be `reconciliation` or `expired`, so it
   already has no budget. The manager must own no live egress, and its original
   children must all be reaped. The manager samples no clock, so a reboot or clock
   change cannot keep the window blocked. The record moves to `retired` with outcome
   `abandoned`, `accepted` or `stopped`. The original reason is kept.
4. **Core commit.** Core commits only the exact plan that the manager recorded. For
   example, a concurrent acceptance causes a conflict and nothing is written. The
   commit does the following:
   - Records an `execution_window_reconciliations` audit row: actor, decision, outcome,
     prior run, terminal event, and whether the hard deadline had passed.
   - Marks each unaccepted proposal as abandoned. A `production_run_abandonments` row is
     written and the run becomes `cancelled`, with terminal kind `abandoned`. The run is
     never `succeeded`, and acceptance is refused afterwards. Its binding is released
     exactly as acceptance would release it, so the conversation can resume its native
     session.
   - Releases inputs that were admitted to the window but never consumed by Deep, so
     they can be admitted again. The original receipt is archived in
     `execution_window_released_inputs`.
   - Revokes the lost window credential, so any surviving holder is fenced.
   - Writes `production_abandoned_retirements` provenance, sets the supervisor deadline
     to zero and closes the window.

Observations, payloads, messages and receipts are kept. Nothing is dispatched again.

## Triggers

- **Automatic (`startup`).** On the first owner-authenticated window request after a
  start (status poll or admission), every unfinished window is reconciled with
  `abandon_unaccepted` when both of these hold:
  - The window's hard deadline has passed.
  - The current conversation's task in this process does not own the window.

  Core needs the owner's credential for every mutation, so there is no
  credential-less boot hook.
- **Owner (`owner`).** Use `POST /api/v2/conversations/{id}/window/reconcile` with
  `{"window_id", "generation", "decision"}`. The decision is either:
  - `abandon_unaccepted`: allowed before the deadline as an explicit owner choice.
  - `retire_resolved`: accept-then-retire. The owner first accepts or stops each pending
    run through the normal endpoints.

  The endpoint returns 409 `window_live` while this process still runs the window.

## Deadline-cancelled Workers (0052)

A Worker whose deadline cancellation was requested (`cancel_requested`) but never
acknowledged before the process stopped used to block the window: its run had
no terminal evidence, and its control stayed pending. The plan now fails such a
Worker when all of these hold:

- its lease deadline has passed, so Core already refuses every effect of the
  lost child;
- the exact issued cancellation receipt exists (`cancel_requested`,
  delivery unknown) at the run's current lease generation and fence;
- its delegation and Worker binding belong to this window's context.

At commit the Worker run becomes `cancelled` with a `production_run_failures`
row (cause `cancel_unacknowledged`) and terminal kind `failed`; it is never
stopped, accepted or re-executed. Its binding is marked `lost` at the next
generation, because the native session's last turn is unknown. The pending
control and its `cancel_requested` receipt stay as history. Workers are failed
before their Deep parent is abandoned, under either decision. Any other
pending descendant effect still refuses.

## Failed opens (0052)

A window whose open failed before it ran anything of its own (for example,
broker readiness or Fast setup was refused) has no Deep run to anchor on. The
plan closes it with outcome `failed` and an `execution_window_open_failures`
audit row. The cause is derived from durable state:

- `credential_unissued`: the manager admitted the window, but no credential was
  issued;
- `credential_unbound`: the credential was issued but never bound;
- `setup_incomplete`: the window was bound, but no run exists.

A successor opening has already taken over its retired predecessor's
supervisor: new incarnation and generation, readiness and workspace
association, and resume reservations for the predecessor turns. Reconciliation
reverts exactly those effects. It requires that no run, busy binding or
per-generation native request exists under the new incarnation. Reservations
move to `execution_window_failed_resume_metadata` and are never confirmed. The
conversation then continues from the same retired window (`restored_window_id`).
Successor recovery, idle issuance, predecessor reattachment and Fast companion
recovery all see through failed windows to that retired window.

A first window has no retired lineage. Its bootstrap supervisor's lease is
zeroed. When every window of a conversation failed this way, the next opening
bootstraps again: the supervisor is taken over at the next generation, and the
never-used Fast and Deep bindings are `retired` for fresh ones.

Inputs the failed window admitted are released for re-admission
(`execution_window_open_failure_inputs`, one row per failure since 0068), and
its credential is revoked. The manager records the window `retired` with
outcome `failed` and no run.

A released **timer occurrence** has no sender who could send it again, so the
same commit puts its dispatched queue intent back in line (`queued`), once.
This happens only when no run of any role exists for its event (its Deep turn
never executed, and Fast only ever gets a fixed note for a timer), the input
is not held, and no earlier failed opening released it. The dispatcher then
opens the next window for it. If that window fails to open too, the input is
released again but stays `dispatched`; the WhatsApp adapter refuses it as
`timer_window_ended_without_run` with its `input_failed` operator alert.

Every committed failed open logs one operator alert line on the server:
`ALERT orkestr-v2-server window_open_failed conversation=… window=…
generation=… cause=… actor=… released_inputs=… timer_retries=…`
(identifiers only).

## Lapsed runs (0054)

A service restart or a dead broker can leave a Worker, Deep or Fast run
`starting`, `running` or `blocked`. In that state it has unknown delivery and no
terminal observation. Its lease has passed, so Core already refuses every effect
of the lost child, but nothing made the run terminal. Its window could not
retire, and a parent proposal waiting on it could not be accepted.

Before planning the window decision, both the automatic and the owner path
**settle** such runs. A run is settled only when all of the following hold:

- The process holds no custody of the window.
- The manager reports no live budget for the exact window: it is not `active`
  or `draining`.
- The window is `reconciliation_required`.
- The run's lease has passed, and it has no issued control.

Each settled run becomes `cancelled` with a `production_run_lapses` audit row:
cause `lease_expired_process_gone`, its prior state, the lease it lapsed under,
the actor, and the evidence event (its latest observation). Its terminal kind is
`failed`. Children settle before parents.

- A Worker's binding is lost.
- A Deep or Fast binding is released at the next generation, so the conversation
  resumes the same native session. The interrupted turn is never re-run.
- A parent Deep proposal stays acceptable: its children are now terminal.

A blocked Worker after a `lost` observation keeps its 0053 decision.

When the window's last Deep turn lapsed, the window closes with outcome
`failed`, naming that turn. A `production_lapsed_retirements` provenance row lets
the successor reattach that native session. `execution_window_reconciliations`
was rebuilt only to widen its outcome CHECK.

## Acceptance grace

The automatic path abandons a proposal still awaiting acceptance only once the
window's hard deadline has passed by more than 24 hours. Until then the owner
can accept it, and the next automatic pass closes the window as accepted. The
owner can also abandon it at any time with the explicit endpoint.

## Worker setup when the parent proposes first (0054)

No new delegation is admitted under a parent that no longer runs. A Worker still
in native setup when its parent proposes therefore never runs. The scheduler
ends it as follows:

- Its task is recorded in `worker_task_failures` with cause
  `parent_left_running_during_setup`, and the task list shows it as `Failed`
  with that cause.
- Its unused setup binding, including confirmed readiness, is lost and no longer
  counts as unresolved setup, so the window still retires.
- Runtime reaps the setup child as before.

## Generalized settlement (0055)

The rule is now general rather than per shape. It applies to a window in
`reconciliation_required` that is past its hard deadline, with no live owner and
no live manager budget:

- **Lapsed runs fail.** Every nonterminal run of any role whose lease has passed
  becomes `failed` with cause `lease_expired_process_gone`. This covers every
  state: `starting`, `running`, `blocked`, `cancel_requested`, `failed`, and
  `cancelled` without evidence, whatever the run's last observation and any
  pending control.
- **Proposals without a readable completion fail.** A proposal that does not
  have exactly one readable completion becomes `failed` with cause
  `proposal_execution_missing`.
- **Settlement repeats.** A parent's terminal update can fence a child it held,
  so settlement runs again until nothing lapsed is left.
- **Proposals are split by whether the owner can accept them.**
  - A Deep or Worker proposal on its own busy session can be read and accepted
    by the owner. It keeps the 24-hour acceptance grace.
  - A Fast proposal of a window no process owns has no readable execution
    record: its status needs the window's live Fast scope. It is abandoned with
    cause `proposal_execution_missing`.
  - Every abandonment records its cause in `production_abandonment_causes`.
  - Worker proposals can now be abandoned like Deep and Fast ones.
- **The window always becomes terminal.** This happens once the grace has
  passed, or earlier once the owner has accepted every acceptable proposal. The
  next window then opens from the window's last Deep turn.

A property test checks this for every combination of Fast × Deep × Worker ×
state × observation, both within and after the grace.

## Not covered

Any of the following refuses the reconciliation and changes nothing:

- A window whose Deep turn is interrupted in `running`, `starting`,
  `cancel_requested`, `failed` or `blocked`, where delivery is uncertain and
  the native session may be mid-turn.
- A Worker whose lease has not yet expired, or that is unfinished in any state
  other than a deadline-cancelled `cancel_requested`.
- A window that ran only some roles before failing (for example a Fast turn but
  no Deep turn).
- A window the manager never admitted. No credential is issued without a
  manager acknowledgement, and the manager's own generation must stay in step.

## Clean stop with an unresolved window

Stopping a window task whose window cannot be retired, for example because proposals
still await acceptance, no longer fails the service stop. The local controller first
checks custody. If every original owned child was reaped by the original cleanup
deadline, the controller records the window as *released*: the window is still
unresolved, but this process holds no custody of it. The stop is then clean, and the
manager independently marks the window `reconciliation` with reason `manager_stopped`.
The window is left for the reconciliation above. The stop is still unclean only when
custody itself is uncertain, meaning children remain or the original task outcome is
unknown.

A conversation that only *observed* a window left by a previous process is also
released, because it never had custody. Both cases cover the stop that blocked the
rollout.

## Cross-conversation blocking

With concurrent conversations, an unresolved window blocks only its own conversation
and does not use a live slot. Reconciliation is what lets that conversation open a
window again.
