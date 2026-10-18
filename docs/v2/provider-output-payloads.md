# Ordinary provider output and removable payloads

Runtime consumes Core source `d690858337ac9266a860ffea5ec27c636edcb2ad`
(application, contracts and SQLite paths only). The existing append operation
commits Started, bounded Progress and CompletedProposal in order. A completion
proposal projects AwaitingAcceptance; it never accepts its own result.

The output pump retains the exact pending event and sequence until a durable
receipt is returned. Progress is stored separately from metadata events; the
execution projection exposes its PayloadId. Removing text leaves the event and
receipt identity intact, and historical retries cannot recreate removed text.

Browser routes:

- `GET /api/v2/conversations/:id/payloads/:payload_id` returns the canonical
  ProviderPayload with text, or `text: null` after removal.
- `DELETE` at the same path requires the browser cookie, exact Origin/Host and
  CSRF token. Successful removal and repeated removal return 204.

The owner comes only from the authenticated browser session. A bearer token or
mixed bearer/cookie request cannot use these routes. Cross-conversation or
missing payload IDs return 404. Invalid IDs return 400; unavailable storage
returns 503. Successful responses use no-store. This is logical removal, not a
filesystem, WAL or backup erasure guarantee.

Tests exercise the actual ordinary Store output pump with an owned synthetic
protocol process, and the actual HTTP router with an ordinary scoped payload.
These are separate checks; a complete HTTP-to-owned-broker execution composition
and a canonical subscription acceptance run remain additional gates.
