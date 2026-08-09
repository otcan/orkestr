# Mailbox routes

A main-instance mailbox can have one active route to one explicitly authorized
thread. Routes are configured with `orkestr mailboxes routes` or the matching
`/api/mailboxes/:mailboxId/routes` endpoints.

Route modes are intentionally distinct:

- `append_only` records the normalized mailbox source in the destination's
  history and never starts a turn.
- `process_immediately` additionally requires the exact `process` mailbox
  grant. It sanitizes the message as an external mailbox actor, queues one
  passive input only while the destination is idle, and starts with read-only,
  no-network mailbox restrictions.
- `context_next_turn` starts no turn. It stores pending context, atomically
  reserves it for the next authenticated human queued input, and keeps later
  arrivals pending for a subsequent turn.

Legacy mailbox listeners remain append-only. Each ingress first receives an
immutable normalized source record; delivery, processing, and context status
are reported separately by `orkestr mailboxes routes status --mailbox-id …`.
Route revocation cancels unstarted work and pending context. Accepted turns are
not deleted, but all later route actions revalidate the route generation and
current mailbox grants.
