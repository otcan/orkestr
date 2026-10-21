# Plan: archiving retired sub-threads

Status: plan only, nothing implemented. It covers what happens to sub-chats
(V1 worker sub-threads such as "Parent / Worker N", and imported worker
conversations) once they are retired.

## Requirements

1. **Keep everything.** An archived sub-thread keeps its full history and is
   never deleted. This covers imported V1 messages, native messages, accepted
   replies, payload text and attachment metadata.
2. **Keep the parent relation.** An archived sub-thread stays linked to its
   parent and keeps that link even if the parent is archived or migrates later.
3. **Read-only.** An archived sub-thread admits no input, timers, Workers or
   steering. Its history remains readable and exportable.
4. **Reversible.** Archiving is a state change, not a data move. Unarchiving
   restores the previous state.

## Model

- **Native and imported sub-chats.** Add an owner-scoped
  `conversation_archive` row (`owner_id`, `conversation_id`, `archived_at_ms`,
  `reason`, `revision`) with an append-only audit table, in the same style as
  `legacy_worker_transitions`.
  - The conversation, its events, messages and archived history are untouched.
    Today's append-only triggers on archived history already rule out
    deletion.
  - Lineage (`conversation_lineage`, write-once) already holds the parent
    relation, so archiving needs no new parent column.
- **Linked V1 sub-threads.** A V1 worker that retires in V1 drops out of the
  V1 active list, and the sidebar stops listing it. Before that happens, the
  operator imports it, which keeps its history and parent:
  1. `thread_history.py v1-export` and `v2-import` record history and lineage.
  2. Mark the new conversation archived.
  3. `thread_workers.py apply` records the `archived` disposition in
     `legacy_worker_links` when the parent is already in V2.

## Enforcement

- **Admission.** Every path refuses an archived conversation with
  `409 conversation_archived`:
  - message intake, window admission, steering and timers (including
    occurrences already scheduled, which become terminal "skipped (archived)"
    rows);
  - Worker task creation and the WhatsApp adapter, whose binding is closed
    with an owner notice.
- **Delivery.** A running turn is never cut off. Archiving waits until the
  window is closed, or is refused with `409 conversation_active`.
- **Reads.** Snapshot, archived history, accepted results and export stay
  available.

## Sidebar and UI

- Archived sub-chats move out of the activity list into a collapsed
  "Archived" section under their parent. They keep their position by last
  activity and show a read-only badge.
- They never count toward unread.
- Opening one shows the full transcript read-only, without a composer.
- `GET /api/v2/sidebar?archived=include` lists them for search.

## Operations

- **Commands.**
  - `thread_history.py v2-archive --conversation C [--reason …] [--apply]`
    is dry-run first.
  - `v2-unarchive` is its inverse.
  - Both are revision-guarded and audited.
- **Bulk.** "Archive every retired sub-thread of parent P" plans from the V1
  registry: the threads that are retired, have their history imported, and
  whose lineage matches P. The bulk run applies one conversation at a time
  and reports each one.
- **Rollback.** Unarchive. History was never moved, so nothing needs to be
  restored.

## Tests to add with the implementation

- Store:
  - archiving never changes event, message or archived-history counts;
  - triggers refuse deletes;
  - lineage survives archive and unarchive.
- HTTP: every admission route returns `409 conversation_archived`, and every
  read route still returns `200`.
- UI, headless at desktop and phone widths: the archived section is collapsed
  under its parent, the transcript is read-only and there is no composer.
