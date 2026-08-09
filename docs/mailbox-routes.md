# Mailbox routes

A main-instance mailbox can have one active route to one explicitly authorized
thread. Routes are configured with `orkestr mailboxes routes` or the matching
`/api/mailboxes/:mailboxId/routes` endpoints. The Ops **Mailboxes** tab shows
the active route and its durable source, work, and context counts.

Routes can target an existing authorized thread. Administrators may instead
provision a fresh destination: Orkestr rejects any existing matching thread
identity and grants that new thread only the named mailbox permissions required
by the selected route mode (`read`, `subscribe`, `manage`, plus `process` for
immediate processing). It never reuses or replaces grants on an existing
thread during this flow.

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
