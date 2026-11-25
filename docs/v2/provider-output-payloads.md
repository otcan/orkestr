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

## Size of one reply

A reply is the run's last progress payload. It holds at most 32 KiB
(32,768 UTF-8 bytes, `MAX_PROVIDER_PROGRESS_BYTES`); until Core migration
0102 the bound was 8 KiB. A longer reply is cut on a character boundary and
ends with the note "(Reply cut at the 32 KB message limit; the rest was not
delivered. Ask for it as a file.)", so the turn still completes.

| Layer | Bound |
|---|---|
| Codex: one streamed delta (broker and Runtime) | 8 KiB |
| Codex and Claude: one agent message, text block or `result` (broker cuts, Runtime agrees) | 32 KiB |
| Broker to Runtime: one output frame (ASCII-escaped JSON, up to six bytes per text byte) | 256 KiB |
| Runtime to broker: one frame; a contained provider's raw frame | 64 KiB (unchanged) |
| Core `production_payloads.text` (CHECK) | 32,768 bytes |
| A thread-ask answer stored for the asking conversation | 8 KiB, cut with its own note |
| API: one payload / a batch of payloads | served whole / 1 MiB per batch, the rest read singly |

Migration 0102 rebuilds `production_payloads` with the wider CHECK. It keeps
every row with its rowid, columns, keys and NULL (removed) texts, and recreates
the 0059 index; nothing else refers to the table. Rollback restores the
pre-upgrade database with its old binary, as for every migration: an older
binary refuses schema 102. While no stored text exceeds 8 KiB the table can
also be rebuilt back to its 0014 definition (the test downgrade fixture does
exactly that).
