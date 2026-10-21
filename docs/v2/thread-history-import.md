# Per-thread V1 to V2 history move and rollback

Status: implemented for the parallel run (workstream A5). Moves the history of
one selected V1 thread (or a set) into a V2 conversation as archived,
non-executable history, supports idempotent delta re-import at cutover, and
appends V2-era messages back to the V1 thread for rollback. No live import is
performed by CI or by default commands; every writing command needs `--apply`.

## Components

| Piece | Location | Role |
| --- | --- | --- |
| Contract | `v2/crates/contracts/src/archived_history.rs` | `ArchivedImportRequest/Receipt`, status, page DTOs and bounds |
| Store | `v2/crates/store-sqlite/src/archived_history/`, migration `0046_archived_history.sql` | Append-only archive tables linked to an owned conversation; no references to messages, events, inbox, outbox or runs |
| HTTP | `apps/server/src/archived_history_http.rs` | `POST/GET /api/v2/conversations/{id}/archived-history`, `GET …/archived-history/status` (owner Bearer or browser cookie+CSRF; 8 MiB body limit) |
| CLI | `v2/migration/thread_history.py` | `v1-export`, `v2-import`, `v2-status`, `v2-export`, `v1-append` |
| E2E | `v2/acceptance/thread_history_e2e.py` | Real server, synthetic V1 home; run in CI after the locked build |

## Semantics

**Snapshot.** `v1-export` opens `thread-messages.sqlite` and `threads.sqlite`
read-only and copies them with the SQLite online backup API, which includes
committed WAL frames. Only the selected threads' rows are extracted; the full
backup copies (all threads) are deleted unless `--keep-backups`. If a thread
has no sqlite meta row, its legacy `thread-messages/<id>.json` is authoritative;
otherwise a readable legacy JSON copy is kept as private evidence with
divergence counts. Thread registry data is reduced to an allowlist (id, name,
publicRef, timestamps, parent, kind). Executor/provider bindings, chat IDs,
connector routes, secrets, OAuth, browser profiles, outbox and bridge journals
are never exported. Attachments are copied (content-addressed, SHA-256) only
from the thread's own `uploads/<thread>` directory; anything else, including
symlink escapes, becomes an unavailable reference with a reason count.

**Consistent cut.** The export stops before the first *recent* nonterminal
message (`queued`, `running`, `pending_delivery`, `awaiting_ack`, …; default
window 24 h), so in-flight turns are not frozen half-written. Long-stale
nonterminal messages are exported with their state. `--include-unsettled`
exports everything (use at cutover after V1 is fenced). Rows that cannot be
represented faithfully (bad role, >1 MiB text, invalid Unicode, oversize
fields) are quarantined locally with their IDs listed in the private manifest.

**Mapping.** Each message keeps source ID, position, cursor, role, phase,
state, source kind, exact `createdAt`/`updatedAt` strings, text and attachment
metadata. Identity digest (pinned in Rust and Python tests) covers ID,
position, role, phase, created_at, text and attachments; volatile delivery
state is stored but excluded. Per-source checksum chains digests in position
order. `snapshot_id` is derived from source instance, thread, content hash and
watermark, so re-exporting unchanged data yields the same ID.

**Group participants.** A user message from a non-owner group participant
(V1 `senderTrustLevel`/`senderEffectiveRole` other than `owner`) keeps its
author: its text becomes `<label>: <text>` after the `[WhatsApp: <group>]`
header, with the label from `senderLabel`, else `senderParticipantId`. Owner
and assistant rows are unchanged. Because the label is part of the text, a
thread with participant messages that was exported before this mapping yields
a different snapshot; import it into a new conversation.

**Import.** Per `(conversation, source_instance, source_thread_id)` the server
keeps a cursor (max imported position). `v2-import` reads it and sends only
later messages (delta) in ordered batches of ≤500 messages / 4 MiB. The server
treats same-ID-same-digest as duplicate, and quarantines (never overwrites)
changed content, a different ID at a taken position, or a new message at or
below the cursor. Rows are append-only (triggers) and re-verified against their
digest on read. Archived rows are not native input: the conversation sequence,
messages, events, reasoning inbox and outbox are untouched, so nothing can be
dispatched, replayed or delivered from an import.

**Lineage.** After an applied import, `v2-import` records the thread's V1
lineage (`PUT …/lineage`: source thread and, for a worker sub-thread, its V1
`parentThreadId`; task agents get no parent). It is write-once, so the import
keeps its parent link for the sidebar's sub-chat grouping. `v2-lineage`
backfills conversations imported earlier from the V1 registry (read-only).
See [conversation-sidebar.md](conversation-sidebar.md).

**Rollback.** `v2-export` pages the native conversation (owner inputs plus
accepted replies with payload text) after an optional sequence into a private
digest-sealed archive. `v1-append` appends those entries to an already
migrated V1 sqlite thread as `state=archived`, `source=orkestr-v2-archive`,
deterministic IDs `v2-<conversation>-<sequence>`, and bumps the thread meta
revision. It writes no bridge-journal, outbox or queued rows, so V1 neither
replays nor delivers them. Repeating it is a no-op. A thread without a meta row
is refused because V1 would rebuild it from JSON and drop appended rows.

## Operator commands

Use the reviewed checkout, private output directories (`umask 077`), and a
private credentials file `{"username": …, "password": …}` with mode 0600. The
V2 origin defaults to the URL; pass `--origin` if the server has an explicit
`ORKESTR_V2_ORIGIN`. All reports are JSON counts/IDs/checksums only.

```sh
M=v2/migration/thread_history.py
V1_HOME=/path/to/v1/home          # read-only use
OUT=/var/tmp/orkestr-history/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p -m 700 "$OUT"

# 1. Snapshot one thread (repeat --thread for a set).
python3 -I -B $M v1-export --v1-home "$V1_HOME" --thread THREAD_ID \
  --source-instance orkestr-v1-production --out "$OUT/bundle"

# 2. Preview, then import into a new conversation (idempotent by request key)…
python3 -I -B $M v2-import --bundle "$OUT/bundle" --thread THREAD_ID \
  --create-name "THREAD NAME" --v2-url http://127.0.0.1:19822 --credentials-file CREDS
python3 -I -B $M v2-import --bundle "$OUT/bundle" --thread THREAD_ID \
  --create-name "THREAD NAME" --v2-url http://127.0.0.1:19822 --credentials-file CREDS --apply
#    …or into an existing conversation: replace --create-name with --conversation UUID.

# 3. Cutover delta: fence V1 for the thread, export again (optionally
#    --include-unsettled) and re-run step 2 with --conversation; only messages
#    after the cursor are sent. Expect "verified": "exact_match".
python3 -I -B $M v2-status --conversation UUID --v2-url … --credentials-file CREDS
```

Rollback of one thread to V1 (after stopping V2 admission for the scope):

```sh
python3 -I -B $M v2-export --conversation UUID --out "$OUT/rollback.json" \
  [--after-sequence N] --v2-url http://127.0.0.1:19822 --credentials-file CREDS
python3 -I -B $M v1-append --archive "$OUT/rollback.json" \
  --v1-db "$V1_HOME/thread-messages.sqlite" --thread THREAD_ID          # dry run
python3 -I -B $M v1-append --archive "$OUT/rollback.json" \
  --v1-db "$V1_HOME/thread-messages.sqlite" --thread THREAD_ID --apply  # append
```

`v1-append --apply` writes the live V1 store and needs write access to it; take
a V1 state backup first. Bundles and archives contain private message text:
keep them 0700/0600 and delete them after verification.

## Limits

- Attachment bytes stay in the private bundle; V2 records only metadata and
  hashes. Uploading them into V2 attachment storage is a follow-up.
- The V2 web UI renders archived history read-only at the top of each
  conversation, before native messages, in visually distinct "Archived" rows.
  It pages forward from the oldest entry (50 per page, smaller after an
  oversized page) and keeps at most 2000 rows mounted; attachment bytes are
  not shown, only names and availability.
- Rollback restores text and roles, not V2 run/worker internals; it is a
  reconciliation archive, not a lossless reverse migration.
