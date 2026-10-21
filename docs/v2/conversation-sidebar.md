# Conversation sidebar: activity order, linked V1 chats and sub-chats

The web UI sidebar lists every chat the owner has, newest activity first,
the way a messaging app does. One request, `GET /api/v2/sidebar` (owner
Bearer or browser cookie), returns the whole list. The UI polls it every
4 s. Nothing in it admits input, starts execution or grants authority.

## Entries

| Field | Native conversation (`v2:<uuid>`) | Linked V1 chat (`v1:<thread>`) |
| --- | --- | --- |
| `last_activity_ms` | newest event (`events.occurred_at`) or newest imported message | V1 `lastActivityAt` / `lastMessageAt` |
| `preview` | latest owner message or accepted reply (the reply's last progress payload); imported history if there is no native message | latest V1 message (`messages?limit=3`), cached by `lastMessageId` |
| `unread` | accepted replies after `max(read mark, owner's latest message)` | `1` when the last V1 message is an assistant reply after the read mark |
| `activity` | durable rows: an open window (opening/active/retiring), a running Fast role (`typing…`), a running Deep role or an opening window (`thinking…`), running Worker runs | V1 `working` / `foregroundWorking` / `runningCount` |
| `read_only` | `false` | `true` |
| `coordinator` | `false` | a live session is attached to the thread in the host live map (for example a Claude Code coordinator through V1 `api-session`) |
| `parent_key` | the V1 parent from durable lineage, else the V1 registry | V1 `parentThreadId`; map-only: `worker-<parent>-<suffix>` ids |

Previews are one line of at most 160 characters. Connector headers such as
`[WhatsApp: …]` are skipped. The list holds at most 400 entries
(`truncated`). A parent cut off by truncation leaves its children at the
top level.

Activity costs one durable window read per conversation. The Fast, Deep and
Worker roles are read only for open windows. Observation never sweeps or
reconciles a window. Fast replies live in the Fast store and do not count
toward unread or the preview.

## Linked V1 chats

These are the owner's chats that still run on V1:

- **Source.** With the private V1 loopback client configured
  (`ORKESTR_V2_DESKTOP_BROKER_CONFIG`, the same operator credential as the
  desktop broker), the server reads `GET /api/threads/summary?includeRetired=1`.
  That response is about 2.5 MB, read with an 8 MiB cap and a 5 s timeout. The
  server caches it for 15 s and serves a stale copy for up to 2 minutes.
- **Listed.** Threads bound to an enabled WhatsApp chat, plus their sub-threads
  whose parent chain reaches such a thread.
- **Not listed.** Retired threads, task agents, and threads already imported
  into a V2 conversation. An imported thread appears once, as V2.
- **Map only.** Without the V1 client, the host live map (`ORKESTR_V2_LIVE_MAP`)
  supplies the views (`v1_status: map_only`). These entries carry names,
  session activity and coordinator flags, but no previews or V1 runtime state.
- **Previews.** At most 6 V1 preview reads per request. The rest fill in on
  later polls.

Opening a linked chat shows its recent history read-only:
`GET /api/v2/v1-threads/{thread}/messages[?before=<cursor>]`, 50 messages per
page, oldest first, with each text capped at 16 KiB. Only threads that the
sidebar lists can be read. Any other thread returns `404`, whether it is
unbound, retired, a task agent or belongs to someone else. The view polls every
8 s and labels the chat "On V1" or "On V1 · coordinator". It offers no
composer: replies go through the chat's WhatsApp group until the thread moves
to V2.

## Read marks

`PUT /api/v2/sidebar/read {"key": "...", "marker": N}` (cookie + CSRF, or
Bearer) stores the owner's last view. A native key's marker is the
conversation sequence and is refused past the current sequence. A V1 key's
marker is the V1 message cursor. Marks only move forward: a database trigger
refuses moving one back, and an older mark is a no-op. The UI marks the open
entry at every poll in which its marker advanced or it shows unread.

## Sub-chats and lineage

V1 worker sub-threads (`threadKind: worker`, `parentThreadId`, for example
`worker-<parent>-<id>` "Parent / Worker 1") are grouped under their parent:

- A group is collapsed by default and sorts by the newest activity of any
  member.
- A collapsed parent shows the unread replies and the working state of its
  sub-chats.
- Selecting a sub-chat opens its group.
- A parent may be a native conversation or a linked V1 chat.

An imported conversation keeps its parent link in durable lineage. The
`conversation_lineage` table was added in migration 0057:
`PUT /api/v2/conversations/{id}/lineage {source_instance, source_thread_id,
source_parent_thread_id}`.

- **Write-once.** An identical replay returns `200`, a first write `201`, and a
  different lineage `409 lineage_conflict`. Triggers refuse updates and
  deletes.
- **Validated.** The source must be one of the conversation's archived history
  sources. Otherwise the request fails with `409 lineage_source_not_imported`.
- **Recorded at import.** `thread_history.py v2-import` records lineage after
  every applied import. The bundle registry now keeps `threadKind` next to
  `parentThreadId`. Task agents never get a parent.
- **Backfill.** Conversations imported before this change get their lineage
  with `v2-lineage`. Run it as a dry run first, then with `--apply`:

```sh
python3 -I -B v2/migration/thread_history.py v2-lineage --v1-home "$V1_HOME" \
  --source-instance orkestr-v1-production --v2-url … --credentials-file CREDS
```

Until lineage is recorded, the sidebar fills the parent from the live V1
registry. That covers only threads V1 still knows about, so run the backfill
once after deploying.

Retiring and archiving sub-chats later is planned in
[sub-thread-archive-plan.md](sub-thread-archive-plan.md).
