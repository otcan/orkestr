# Concurrent conversation windows

Beta mode (`ORKESTR_V2_BETA_CONFIG`) previously ran exactly one execution
window per owner. Opening a window in another conversation required the active
conversation to finish, or the request was refused with `409 window_busy`.
Several conversations can now each hold a live window, with its Deep turn and
its Fast and Worker sessions, at the same time.

## Why there was only one window

Four layers enforced the single-window limit independently:

1. **Runtime.** `window_runtime::Controller` retained one `current`
   conversation controller. When a request arrived for another conversation,
   the controller checked that the current conversation was idle, shut it down,
   and then built a new controller.
2. **Core admission.** `admit_execution_window_authenticated` refused a fresh
   window (`Busy`) while any other conversation of the owner had an unclosed
   window.
3. **Core authority.** `bootstrap_execution_window_authenticated` and
   predecessor recovery (`all_prior_retired`) required every window, supervisor
   and run of the owner to be retired, across all conversations and namespaces.
4. **Root manager.** The manager ledger refused admission while any window was
   unretired (`other_window_unretired`). The manager also kept one child set,
   one relay pool and one budget, so concurrent windows were not possible.

A lost or uncertain window in any conversation therefore blocked every
conversation.

## Design

- **Per-conversation custody.** The Runtime controller keeps one retained
  `ConversationController` per conversation. Each one has its own one-shot
  authority, local handles, manager scope, scratch directory and derived
  namespace and supervisor key. Stop, Steer, Accept and handle snapshots look up
  only the exact conversation. Controllers are never evicted, which keeps their
  handle generations and one-shot history (bounded at 1024 per process).
- **Owner-wide live capacity.** `max_active_windows` in the beta configuration
  sets the cap. It is optional, defaults to 8 and must be between 1 and 12.
  Core counts live windows in the `opening`, `active` and `retiring` states
  that have not reached their hard deadline. After the deadline a window holds
  no egress and no live provider. For example, a window whose runs still await
  acceptance stays unresolved for its own conversation, but it uses no slot and
  never blocks another conversation. The manager likewise counts only
  `active` and `draining` windows.
  `admit_execution_window_capped_authenticated` checks that count atomically
  in the same transaction that admits the window. The Runtime opens fresh
  windows one at a time under a single `opening` lock. Follow-up input to an
  already-live window needs no new slot.
- **Idle reclamation.** Once every role is accepted, a window stays open for
  follow-up input until its deadline. When a fresh window needs a slot and the
  capacity is full, the Runtime retires the oldest idle live window of another
  conversation. A window is idle when every role is accepted and Core shows no
  pending input, run or descendant, which is the former conversation-switch
  precondition. The check and the stop run under that conversation's
  operation lock, so no follow-up input can be admitted between them.
  Conversations with queued intents are never reclaimed.
- **Durable queue.** A fresh-window intent that cannot start is recorded in
  `execution_window_queue` (migration `0047`) and answered with
  `202 Accepted` and an `ExecutionWindowQueued` receipt. An intent also queues
  when its conversation already has queued intents, so per-conversation order
  is kept. The dispatcher drains rows in FIFO order, and only the earliest row
  of each conversation is eligible. Dispatch rebuilds the window tuple from
  the conversation's current state: fresh, successor or follow-up. Core admits
  the input and marks the row `dispatched` in a single transaction, so an
  intent is never admitted twice. Identical retries return the queue receipt.
  A row whose input becomes held, consumed, or blocked by reconciliation is
  `withdrawn`. Withdrawal never drops anything: the message stays in history
  and the owner can send it again. `GET /api/v2/conversations/:id/window/queue`
  reports the capacity, the number of live windows and that conversation's
  queued entries.
- **Dispatcher authority.** Dispatch uses the owner's most recent
  authenticated browser session, held only in memory. Core authenticates it
  again on every call. After the session expires or the owner logs out, and
  after a restart, queued rows wait until the owner's next authenticated
  request.
- **Scoped retirement.** `all_prior_retired` now checks only the requested
  conversation. That covers its windows, its runs, and its supervisors: those
  sharing its namespace and key, those its windows used, and those with
  readiness for its sessions. An uncertain window still blocks its own
  conversation. It no longer counts as live and no longer blocks other
  conversations.
- **Root manager.** Each admitted window has its own `Window`, which holds the
  original child set, durable budget and relay pool. One egress listener routes
  each authenticated peer only to the window whose bound broker owns it.
  Uncertainty, expiry and retirement act on one window only. Server loss and
  manager stop mark every live window. The ledger enforces its own fixed
  ceiling of 16 live windows. That ceiling stays above Runtime's maximum of 12
  because Core closes a window before the manager records its retirement.

## Restart

Graceful shutdown stops every conversation at the same time, so all windows
share the manager's single 30-second margin. After a crash or restart, the
first authenticated request starts a one-time sweep. The sweep marks every
window left unfinished by the previous process as `reconciliation_required`.
Each such window then blocks only its own conversation and frees its capacity
slot. The manager also marks its unfinished windows as reconciliation at
startup. Queued rows survive the restart and start after the owner's next
authenticated request.

## Evidence

- Core: `execution_window::queue_tests` covers capacity across three
  conversations, isolation of uncertain windows, FIFO order, idempotency,
  exactly-once dispatch, withdrawal and reopen durability.
- Runtime: `window_runtime::dispatch` tests cover queueing at saturation,
  replay, the absence of handle leakage, exactly-once dispatch despite a failed
  transport, the restart sweep and request rebuilding.
- Manager: `test_codex_service_windows.py` and
  `test_codex_service_conversations.py` cover separate custody and budgets,
  capacity, per-window uncertainty, expiry and shutdown, server loss and
  restart.
- Real HTTP with the root manager and synthetic natives
  (`tests/service_roles_http.py`, capacity 2): a second conversation's Deep
  turn runs and finishes while the first conversation's Deep turn is held. A
  third conversation queues (`202`). Once the second window is idle it is
  reclaimed and the third starts by itself. The first conversation's next
  input joins its still-open window. Later windows reclaim idle slots inline,
  and shutdown stays clean.

## Limits

- Conversations still share the configured workspace directory and provider
  account. Concurrent Deep turns that edit the same files are not coordinated.
- Clearing a window in `reconciliation_required` remains an operator
  procedure. The difference is that it no longer blocks other conversations.
- Worker sandbox concurrency (four slots per process) is shared by all
  conversations.
