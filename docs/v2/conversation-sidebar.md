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

Opening a linked chat shows its recent history:
`GET /api/v2/v1-threads/{thread}/messages[?before=<cursor>]`, 50 messages per
page, oldest first, with each text capped at 16 KiB. Only threads that the
sidebar lists can be read. Any other thread returns `404`, whether it is
unbound, retired, a task agent or belongs to someone else. The page carries:

- `writable`: false for a thread whose V1 binding delegates its runtime to V2
  (`remoteThreadId` set and `remoteRuntimeEnabled` not `false`);
- `working`: V1 reports a running turn, or an owner input is still queued;
- per message, `coordinator`: an assistant post from the attached coordinator
  session (V1 source `api-session`), labelled "Coordinator".

The view polls every 2.5 s while V1 works and for about two minutes after a
send, otherwise every 8 s, and shows "typing…" while `working`.

## Writing to a linked V1 chat

`POST /api/v2/v1-threads/{thread}/messages` with
`{"client_message_id": "<uuid>", "text": "…"}` (at most 16 KiB) posts owner input
into the same V1 thread. The server forwards it through the private loopback
client as V1 web UI input, `POST /api/threads/{thread}/ui-input`, with
`clientMessageId: "orkestr-v2-<uuid>"` and `replyDelivery: "ui_only"`. V1 records
it as owner input and runs it as usual: for "Orkestr Rust" the V1 fast layer
(its Codex executor) answers, and it may wake the coordinator through its
existing escalation. Nothing routes it to another runtime.

- **Exactly once.** V1 dedupes on `clientMessageId` per thread. The composer
  keeps the key until V1 answers definitely, so a retry after a timeout or a lost
  response (`504 v1_receipt_unknown`) returns the first message (`200`,
  `duplicate: true`) instead of creating a second one. The same key with other
  text is `409 idempotency_conflict`.
- **Delegated threads.** A thread delegated to V2 is refused with
  `409 v1_thread_delegated`, and the view hides the composer. Migrated threads
  are normally listed as their V2 conversation, and the UI writes to that
  conversation directly. So an input never reaches both V1 and V2.
- **Replies stay in the app.** `ui_only` creates no WhatsApp reply-delivery
  intent. The scoped group relay sends only replies whose parent is an input it
  routed itself. So the fast layer's answer to app input is not sent to the group.
  - **Caveat (#164).** A coordinator `api-session` post without an explicit
    parent is parented to the newest relay-routed owner input of the last 6 h
    (`ORKESTR_API_SESSION_RELAY_PARENT_MAX_AGE_MS`). The relay then delivers it
    once to WhatsApp, even when the coordinator was answering a message sent
    from this app. This is accepted behaviour.
- Other refusals: `404` (not listed, or V1 does not know the thread), `409
  v1_refused` (a definite V1 4xx), `400` (malformed body or key).

## Old V1 deep links

V1 links such as `/instance/ins_…/thread/thr_…` keep working on the Rust app's
domain. The public references are V1's (`packages/storage/src/public-references.js`:
a prefix and 22 base64url characters); V1 reports them as `publicRef` and
`canonicalPath` in its thread summary.

- `GET /instance/{ins}/thread/{thr}` (also with a trailing slash) answers
  `303` to `/#v1-link/{ins}/{thr}` without authentication and reveals nothing.
  Malformed references are a plain `404`.
- After sign-in the UI calls `GET /api/v2/v1-links/{thr}?instance={ins}` (owner
  only). A thread imported into a V2 conversation (lineage or archived source)
  answers `{"kind":"conversation","conversation_id":…}`. A thread the sidebar
  lists answers `{"kind":"v1_thread","thread_id":…}` and opens its linked
  entry. Anything else is `404`: unknown, retired, task agent, another
  instance, or V1 not configured.
- The UI then replaces the fragment with the conversation's own. When a link does
  not resolve, it says so and keeps the default conversation.

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

## Sub-chat toggle placement

A parent's sub-chat toggle (`N ▸`) sits at the right edge of its row. Earlier
the toggle sat at the left and pushed the parent's avatar and name to the
right, so a top-level chat with sub-chats (for example "Orkestr Rust") looked
indented under the chat above it. The data was correct; only the rendering
misled. Top-level rows now always share one avatar column (checked headlessly),
and only real sub-chats are indented, with a guide line.

## Chat icons

Chats show their Orkestr icon from the V1 app: "ORKESTR" over the chat name,
or "W<n>" for worker sub-threads, on the green WhatsApp-style disc.
`GET /api/v2/thread-icons/{thread}` (owner cookie or Bearer) serves it for
any V1 thread the sidebar knows. That covers linked V1 chats and the V1
sources of imported conversations. Native chats without a V1 thread keep
their initials.

- **V1's saved picture.** When the operator makes V1's saved icon directory
  readable (`ORKESTR_V2_V1_CHAT_ICONS_DIR=<V1 home>/whatsapp-bridge/outbound-media/chat-icons`),
  the server serves V1's own JPG. The file is found through V1's association:
  `<name>-<sha1(chatId:title)[..10]>.jpg`, where the title is the binding
  display name.
- **Drawn icon.** Otherwise, and for chats V1 never saved a picture for, the
  server draws the same SVG with V1's algorithm. Long lines are squeezed
  into the canvas when V1's narrow font is unavailable.
- **Label.** As in the V1 web UI, the binding display name labels a chat
  (or its chat id, if there is no display name), and a worker uses its
  thread name.

## Composer: Enter, Attach and Paste text

- **Enter and Shift+Enter.** Enter sends; Shift+Enter inserts a newline.
  Enter never sends while an input method is composing (`isComposing`, or
  keyCode 229) or while the composer is busy. This applies to both the native
  and the linked V1 composer.
- **Attach.** Opens the file picker: up to 8 files and 16 MiB per message.
- **Paste text.** Opens a box for long text, which is attached as
  `pasted-text-<time>.txt`. Files upload at once and show as removable chips
  until the message is sent.
- **Native conversations** (`POST /api/v2/conversations/{id}/message-attachments`):
  - **Storage.** The server stores the files in the conversation attachment
    store, idempotent per request key.
  - **Local copy.** It writes each file as
    `<dir>/<conversation>/<sha256><ext>`. `<dir>` is
    `ORKESTR_V2_ATTACHMENT_EXPORT_DIR`, or `<home>/message-attachments` by
    default; the group is `ORKESTR_V2_ATTACHMENT_EXPORT_GROUP`. The provider
    must be able to read that directory.
  - **Note.** The server returns a note in the WhatsApp adapter's format:
    file name, type, size, reference and local file. The composer appends
    the note to the message, so the model opens the file with its file or
    image tool. The note is part of the frozen input, so a retry resends the
    same text.
- **Linked V1 chats** (`POST /api/v2/v1-threads/{thread}/uploads`):
  - **Upload.** The server uploads the files to V1 as the V1 web UI does:
    `POST /api/threads/:id/uploads` with base64 file contents.
  - **Upload ids.** It keeps V1's attachment descriptors for an hour under
    upload ids. The composer sends those ids with the input
    (`attachment_ids`), and the server passes the descriptors to V1
    `ui-input` as `attachments`.
  - **Rules.** Ids belong to their thread. Unknown or expired ids are refused
    with `409 v1_upload_expired` before V1 is contacted. A message with
    files but no text is sent as `Attached: <names>`.

## Work slots

The owner-wide "N of M work slots in use" line is no longer shown in the chat
list. It remains in a conversation's "Connection and work details"
diagnostics.

## Message times and receipts

Every message shows its time in Europe/Berlin, with EU summer time: switch
at 01:00 UTC on the last Sunday of March and of October. Today's messages
show `16:42`; older ones `21 Oct, 16:42` or `21 Oct 2025, 16:42`. Hovering
(title) or tapping the time shows the full date (`Tue 21 Oct 2026, 16:42:05 CEST`)
and any recorded receipts.

- **Native conversations.** `GET /api/v2/conversations/{id}/message-times?after=&limit=`
  returns the durable event time (`events.occurred_at`) of each owner input
  (`message_accepted`) and each accepted reply (`execution_accepted`), keyed
  by conversation sequence.
- **Receipts for exported replies.** For a reply exported to V1 (a
  WhatsApp-delegated conversation), the receipts are what V1 recorded on its
  mirror message, matched by `remoteMessageId` = the acceptance event:
  - `remoteMirrorAck` (`delivered` becomes "✓ Handed to V1"; `suppressed`
    becomes "Not sent (no reply)"), with `acknowledgedAt`;
  - V1 `deliveryState: delivered` with `deliveredAt` becomes "✓ Sent to
    WhatsApp", or "✓ Delivered in the app" without a WhatsApp send.
- **Linked V1 chats.** Their history carries `created_at_ms` and the same
  receipts per message.
- **Archived (imported) messages** show their V1 `createdAt` the same way.
- **Nothing is inferred.** A receipt without a recorded time shows no time.
  Owner inputs carry no delivery receipts. WhatsApp's own delivered and read
  acknowledgements are not recorded by V1, so they are never shown.
