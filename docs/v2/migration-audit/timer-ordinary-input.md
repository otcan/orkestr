# Timer ordinary-input bridge proposal

This source checkpoint requires Core's reserved migration 0029, shared intake
helper, and eligibility filters before registration or exposure. No live timer
has been activated. Imported schedules remain paused; ambiguous cadence and
unknown timezone remain held.

`timers::input::Store` methods use the existing ordinary Store current-credential
`BEGIN IMMEDIATE` boundary. Issuer-bound Store handles refuse this interface.

- `enable_timer_input(credential, owner, TimerEnableRequest, trusted_now_ms)`:
  explicit target-owner enable; expected revision and idempotency key required.
  Captures the conversation's current Deep Stop event sequence in the same
  transaction. Exact replay cannot refresh authority after a new Stop. An older
  inert enable must be disabled and explicitly enabled with a fresh key/revision.
- `admit_timer_input(credential, owner, TimerInputRequest, trusted_now_ms)`:
  server-side due controller only. The request contains a generation-bound claim
  and new target-owner supplied text. Checks current auth, generation, target,
  due time and Stop watermark, then advances cadence, calls Core's sole
  `intake::admit_in_transaction(&mut SqliteConnection, owner, conversation, input)`
  and records provenance before one commit. Stable native key is `timer:<claim UUID>`.
  Same occurrence/key/text replays exact native receipt; different content refuses.
  Failure rolls back cadence, claim, message, inbox, outbox and provenance together.
- Existing `control_dormant_timer` is the disable/Stop/rollback contract, with
  expected revision, action and request key. It cancels claims and advances
  generation atomically. Stop/rollback are terminal; disable permits fresh enable.
- Existing `dormant_timer_receipt` is a current-auth read of state, source digest,
  revision, generation, next due time and dormant reason. It grants no authority.

The additive SQL is `timers/input/schema-proposal.sql`; Core alone registers the
numbered migration. `ordinary_input_holds` unions existing Deep Stop holds with
cancelled/stale/terminal timer-input provenance. Core must use it in all ordinary
queue selection, claim validation, Fast admission/replay and relevant status
eligibility paths. The old Stop-specific read receipt remains Stop-specific.
Do not expose this bridge while those filters are incomplete. Cancellation fences
queued work; already dispatched effects require their separate runtime safeguards.

Deep owns HTTP registration. UI should use the enable/control/read contracts
above and display dormant reasons. Request clocks and due claims must come from a
trusted bounded controller, never an unauthenticated client clock. No legacy
prompt, credential, session, native binding or route is imported. Native input
has ordinary outbox semantics only after explicit owner enable; no external
provider call occurs within this module.

Three new Store tests cover exact replay/content conflict/disable hold, native
validation failure atomicity/current-auth refusal, and inert-enable refusal.
They are UNEXECUTED pending exact Core helper/schema/filter integration and build
admission. Rustfmt and diff checks validate source formatting only. Reopen,
two-pool race, actual Stop, and runtime claim refusal need registered acceptance;
this checkpoint does not claim those results.

Core registration
-----------------

Migration 0029 installs the proposal tables and `ordinary_input_holds` view.
The ordinary intake writer is factored into the transaction-local
`intake::admit_in_transaction`; its caller owns authentication and commit.
Deep claim selection, claim verification/order, Fast admission, queue age and
eligible-input reads use the shared hold view. Current execution authorization
also checks that view, so disable/rollback after admission refuses reserve,
consume and execution callbacks. Cancellation-purpose authority remains usable.
Committed observation replay retains its existing authenticated precedence.

Author checks: twelve timer tests (including a real ordinary supervisor with
admitted candidate disabled before reservation), nine preflight/upgrade tests.
No scheduler route or external provider activation is included.
