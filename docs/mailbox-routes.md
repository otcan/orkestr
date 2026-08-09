# Mailbox routes

A main-instance mailbox can have one active route to one explicitly authorized
thread. Routes are configured with `orkestr mailboxes routes` or the matching
`/api/mailboxes/:mailboxId/routes` endpoints. The Ops **Mailboxes** tab shows
the active route and its durable source, work, and context counts.

Routes can target an existing authorized thread. Administrators may instead
provision a fresh destination: Orkestr rejects any existing matching thread
identity and grants that new thread only the named mailbox permissions required
by the selected route mode (`read`, `subscribe`, `manage`, plus `process` for
immediate processing). This is a recoverable provisioning saga: the fresh
thread is marked while it is being provisioned, and any later grant or route
creation failure removes its exact grant and deletes the fresh thread. If that
cleanup cannot complete, the thread remains visibly marked as failed. Orkestr
never reuses or replaces grants on an existing thread during this flow.

Route modes are intentionally distinct:

- `append_only` records the normalized mailbox source in the destination's
  history and never starts a turn.
- `process_immediately` additionally requires the exact `process` mailbox
  grant. It sanitizes the message as an external mailbox actor, queues one
  passive input only while the destination is idle, and starts with read-only,
  no-network mailbox restrictions. Its durable work record links the queued
  message and Codex turn, then reports accepted, running, completed, or failed
  without replaying an ambiguously accepted input. The mailbox policy also
  rejects app-server tool, MCP, connector, auth, browser, desktop, and
  messaging requests at the runtime boundary.
- `context_next_turn` starts no turn. It stores pending context, atomically
  reserves it for the next authenticated human queued input, and keeps later
  arrivals pending for a subsequent turn.

Legacy mailbox listeners remain append-only, but an active listener and a route
cannot be co-enabled for the same mailbox; revoke the listener before route
promotion. Each ingress first receives an immutable normalized source record;
delivery, processing, and context status are reported separately by `orkestr
mailboxes routes status --mailbox-id …`. Route revocation cancels unstarted
work, including `context_pending`, and pending context. Accepted turns are not
deleted, but all later route actions revalidate the route generation and current
mailbox grants.
