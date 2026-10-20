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

## Not covered

Any of the following refuses the reconciliation and changes nothing:

- A window that was never credential-bound.
- A window with no Deep run.
- An interrupted turn in `running`, `starting`, `cancel_requested`, `failed` or
  `blocked`, where delivery is uncertain and the native session may be mid-turn.
- Unfinished Worker descendants.

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
