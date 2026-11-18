# Incoming WhatsApp messages for a connected assistant

The thread bridge MCP tool `list_incoming_whatsapp_messages` lets a connected
assistant (for example ChatGPT) read recent WhatsApp messages that other people
sent to one of the owner's connected accounts. It only reads what an existing,
already-authorized component keeps. It never sends, reacts, marks anything as
read, links an account, logs in, or creates a credential.

## Access

A call needs all of:

- OAuth scope `threads:read`;
- a bridge grant whose `observe` is `"all"`;
- the grant field `whatsappRead`, a list of account names (`"orkestr"`,
  `"german"`). The consent page lists the accounts enrolled for the owner, and
  approving it grants exactly those. For a connection approved before, the
  operator may add the field once the owner has approved it.

Anything else answers `bridge_whatsapp_not_granted` (or the usual
`insufficient_scope`, `bridge_grant_revoked`, `thread_bridge_disabled`). The
grant, and for `orkestr` the ownership of each group's thread, are checked
again after the read; a message whose thread left the grant is dropped.

## Enrollment

`ORKESTR_WHATSAPP_INCOMING_SOURCES` names a JSON file (owned by root or the
server user, not group/other writable, no symlink) that says which read path
backs each account of an owner. Without it, or for an account that is not
listed for the owner, the account is reported as `not_connected`, never as
empty. The file holds no credential. Its `refKey` (64 hex characters, random)
keys the opaque chat, sender and message references (HMAC-SHA256): without it
a reference could be reversed to a phone number by trying candidates. It opens
nothing; changing it changes every reference and voids open cursors.

```json
{
  "format": "orkestr-whatsapp-incoming-sources-v1",
  "refKey": "<64 random hex characters>",
  "accounts": [
    {
      "account": "orkestr",
      "label": "the Orkestr number",
      "ownerUserId": "owner",
      "kind": "scoped_relay_journal",
      "journalPath": "/path/to/scoped-relay/transport.sqlite",
      "ownerAuthorIds": ["<owner id>@lid"]
    },
    {
      "account": "german",
      "label": "your German number",
      "ownerUserId": "owner",
      "kind": "coordinator_bridge",
      "baseUrl": "http://127.0.0.1:<port>/",
      "tokenFile": "/path/to/coordinator.token",
      "ownerApprovedAt": "<ISO time of the owner's approval>",
      "assistantAuthorIds": ["<Orkestr number>@c.us", "<its LID>@lid"]
    }
  ]
}
```

### `orkestr`: the scoped relay journal

The scoped relay's transport journal records every input the Orkestr number
admitted in a bound group. The tool opens it read-only per call and returns an
input only when:

- its group is bound to a thread the grant observes now, and its author proof
  names this input, this group and that thread;
- it was written by a listed participant (it has an author proof): the owner's
  own inputs carry none, and the number's own messages are not `false_` inputs;
- the author is not one of `ownerAuthorIds`.

If the journal's `-shm` file is missing, nothing is recording into it, and the
tool reports `journal_not_recording` instead of opening it (opening a WAL
database without one would create files next to it).

Limits: messages from group members who are not listed are dropped by the relay
before anything is recorded and cannot be read; 1:1 chats with the number are
not recorded. The journal keeps everything since its relay started; the answer
reports `recordsSince` and `lastRecordedAt` (any input, including the owner's)
and marks the account `stale` after 24 hours without one.

### `german`: the coordinator bridge

The owner's personal account is read live through its bridge's coordinator
routes, with the coordinator's existing token (read from `tokenFile` per call,
sent only to the loopback `baseUrl`). Only three GET routes can be built:
`/coordinator/health`, `/coordinator/chats` and
`/coordinator/chats/<chat>/messages`; send, resolve and media routes are not.
The bridge's history reads never mark anything as seen, and the tool refuses
to read when health does not report `markSeen: false`, the account identity,
or readiness.

- Without `chat`: the 100 most recently active chats are listed (cached 60 s;
  listing walks every chat and takes seconds). The 25 most recently active
  since `since` are read, each back over its newest 150 messages.
- With `chat` (a `chat.id` from an earlier answer): that chat, back over its
  newest 500 messages. It must be among the 100 most recently active chats.

Left out: the owner's own messages, messages from `assistantAuthorIds`
(Orkestr's replies in shared groups), system notices (group changes, calls,
encryption notices, reactions), status broadcasts and channels.

Group senders appear by masked number and reference only: the bridge returns
no group sender names. A direct chat's sender is named after the chat. A
contact WhatsApp has no name for is listed under its formatted number, so
names made of digits, and "+" numbers inside names, are masked like numbers.

## Answer

- `messages`, newest first. Each has `id` (the provider's message key),
  `account`, `chat` (`id` an opaque `wa-…` reference, `name`, `kind`, and for
  `orkestr` the `threadId`), `sender` (`name`, `number` masked as `+49…62` or
  null for a LID, `ref` an opaque `ws-…` reference), `receivedAt` (`utc` and
  `berlin`; WhatsApp's message time, 1 s precision), `type` (`text`, `image`,
  `voice`, `document`, ...), `text` (null for media without a caption; at most
  4000 characters, with `textTruncated`).
- `hasMore` and `nextCursor`: pass the cursor with the same `account`, `chat`
  and `since` for the next page. Pages are positions (time, reference), so they
  never overlap or skip, also for messages in the same second. Every page reads
  its window again; if the window now ends later than when the listing started
  (new messages pushed a busy chat's window back, the active chats changed),
  the call fails with `whatsapp_cursor_expired` instead of ending the listing
  early: start again without a cursor.
- `coverage`: what was read. `completeAfter` is the time after which the
  answer contains every incoming message in scope; a busy chat whose window
  ended before `since`, a chat that failed, or active chats beyond the scan
  limit move it later, and the pages then stop there (`truncatedChats`,
  `failedChats`, `activeChatsNotScanned`).
- `available` (with `reason` when false), `observedAt`, `since` (default seven
  days ago), `timezone` (`Europe/Berlin`), per-account availability in
  `accounts`, and the account's `limits` in words.

No raw WhatsApp id (they embed phone numbers), token, path, media file or media
link appears in an answer or a cursor. Media is reported by type only.
