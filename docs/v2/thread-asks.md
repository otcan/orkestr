# Thread asks: one thread's agent asks another

A running Deep turn can ask another conversation of the same owner for
something and get that thread's answer back. The path is V2-only. It never
uses the V1 CLI, an owner session or browser pairing.

## Authority

A thread asks another thread only because the owner told it to. The asking
Deep run must be serving an input the owner authored: the owner's own message
(from his web session, or a WhatsApp message the adapter verified as the
owner's), or the returned answer of a request that itself passed this check.
Group members, timers, V1-local senders, unattributed machine inputs and
another thread's request are refused with 403 `thread_ask_not_owner_commanded`.
Core records the verified author of each admitted input in `message_authors`:
the adapter states it (`author` on `POST /messages`), and a browser session is
the owner.

- The owner issues a grant for the asking conversation:
  `PUT /api/v2/conversations/{id}/thread-ask-grant` with `{}` (every other
  conversation of the owner) or `{"targets": [ids]}` (an explicit allowlist).
  The grant is shown once and only its hash is stored. A new issue rotates it,
  and `DELETE` revokes it.
- The agent sends the grant in `x-orkestr-thread-ask-grant` and sends no
  cookie, bearer or Origin. The grant works only while its conversation has a
  dispatched Deep run that is `starting` or `running`. Each request is pinned
  to that run. The grant is checked in a read transaction before any write
  lock is taken, so a forged header can never hold the SQLite write lock.
- A `request_key` replays only within the same asking run (unique per
  owner, source, run and key). The same key from a later turn creates a new
  request, never an old answered or failed one.
- Refusals: another owner's (or an unknown) conversation returns 404
  `thread_ask_target_not_found`. A target outside the allowlist returns 403.
  Asking itself returns 400. A restricted or archived target returns 409.
  A source that is restricted or archived now is refused on every request.
  More than 4 unsettled or 12 accepted requests per hour returns 429. A turn
  that answers a forwarded request, or handles a returned answer, counts as
  one hop; a second hop is refused (409 `thread_ask_chain_too_deep`). Asking a
  conversation that is itself waiting on this one is refused (409
  `thread_ask_cycle`), and asking without a window dispatcher is refused (503
  `thread_ask_no_dispatcher`) instead of leaving the request unprocessed.
- Every authenticated attempt, refused or accepted, is appended to
  `thread_ask_audit`. The audit records the source conversation and run, the
  grant generation, the requested target, the request key, the SHA-256 of the
  text, the outcome and the time. The audit is append-only. At most 20
  refusals per conversation per 10 minutes are audited; beyond that, attempts
  are refused (429) without any write.

## Delivery and return

1. `POST .../thread-asks` admits one ordinary input into the target
   conversation, keyed `thread-ask:{ask}`. Its header names the asking thread
   and says it comes from that thread's agent, not the owner. The agent's text
   is quoted line by line (`> `), so it cannot pose as an Orkestr header.
   These inputs and their replies are excluded from the Fast history digest,
   like timer inputs. The request row
   pins the exact message and event IDs.
2. The trusted timer scheduler (it runs once per second and stops during a
   deploy drain) queues the target's Deep window intent
   `thread-ask-window:{event}`. It does this only when a window dispatcher
   runs. The intent goes through the same queue and admission checks as timer
   occurrences.
3. The status comes from Core facts for that exact input. `sent` means the
   input is recorded but no target turn is admitted yet. `admitted` means the
   window was admitted but the agent has not started. `running` means the
   agent has the input, or its answer awaits owner review. `answered` means the
   completion was accepted, and the answer is the last progress payload before
   it. `failed` means the run failed, was blocked, stopped, or never accepted,
   or the input was withdrawn, or the window failed or closed without a turn.
   An unsettled request fails as `expired` 4 h 30 min after it was sent (the
   window lifetime ceiling plus grace), and the owner can cancel one with
   `POST .../thread-asks/{ask}/cancel` from either side (`cancelled_by_owner`).
   A failure that no run took also retires the still-queued target input and
   withdraws its queued intent, so it cannot run later or block a provider
   handoff. The scheduler observes read-only, takes the write lock only for a
   real transition, and walks open requests with a rotating cursor, so stuck
   requests cannot starve newer ones. The final outcome is stored once
   (write-once trigger).
4. The outcome returns exactly once. A write-once `return_path` decides how:
   - `tool_result`: the still-running asking turn calls
     `POST .../thread-asks/{ask}/collect`. The first collect fixes the return
     for that run; the same run may collect again while it runs, so a lost
     response loses nothing. Any other turn gets no answer.
   - `input`: after the asking run is no longer active, the scheduler admits one
     attributed input `thread-ask-reply:{ask}` into the asking conversation and
     queues its Deep turn. Failures return the same way with their reason.

Why both: a short answer fits in the asking turn. If the answer has to be a
tool result, it is lost once the turn ends. A later answer has to start a new
turn of the asking thread, and an input does that through the ordinary path.

## Provisioning

`v2/tools/thread_ask_provision.py` is the operator script. It logs in once
with the owner credential file, reads `GET /api/v2/thread-ask-grants`, and for
every eligible conversation makes sure a grant exists whose allowlist is
exactly the owner's other eligible conversations. It installs each grant as
`<grant-dir>/<conversation>.grant` (0600, optional `--chown`). Reruns change
nothing. A changed allowlist or a missing file rotates that grant, `--rotate`
forces rotation, and `--revoke` revokes and deletes. Restricted or archived
conversations lose their grant. Agents read the file when
`ORKESTR_V2_THREAD_ASK_GRANT_DIR` points at the directory.

## Agent instructions

`thread_ask.py instructions` prints the short rules to add to a thread's
instructions:

- Use it only when the owner asked for cross-thread work in this
  conversation.
- `thread_ask.py targets`, then
  `thread_ask.py ask "<thread name>" --text "<request>" --wait 240`.
- Relay the printed status as is. A request that is only sent is "not
  processed yet", never "delivered". A later answer arrives as a new message.

## Agent tool

`v2/tools/thread_ask.py` (same pattern as `desktop_lease.py`). It takes the
grant from `ORKESTR_V2_THREAD_ASK_GRANT` or a private `--grant-file`:

```sh
thread_ask.py --v2-url URL --conversation ID targets
thread_ask.py ... ask Hosting --text "..." --wait 240
thread_ask.py ... wait ASK_ID --timeout 300
```

The default request key comes from the target and the text. Core scopes it
to the asking run, so a retried command in the same turn is the same request
and a later turn asking again starts a new one. Returned answers render
`NO_REPLY` and Codex async questions explicitly. Every command prints `status_text`. That text
never reports `sent` as progress ("Sent to ..., not processed yet").

## Not in this change

- The grant is per conversation and owner-issued, and it is gated on a
  running turn. A broker-injected per-run capability, with no environment
  variable or file, belongs with the TASK-52 typed-tool channel.
- WhatsApp export of the asking thread's follow-up turn: the owner route
  `GET /api/v2/conversations/{id}/thread-ask-inputs?after_sequence=N` lists
  returned outcomes admitted into the conversation. The adapter change that
  exports those turns is a separate PR, stacked on the adapter branch.
- The UI shows these inputs as owner messages with the attribution header. A
  separate badge is not implemented.

## Deployment note

Migration 78 adds tables, which disables the release train's automatic code
rollback for this train. Ship it in a train with nothing else risky.
