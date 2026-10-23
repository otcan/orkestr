# Conversation posts

Status: implemented on `v2/rust-rewrite` (migration `0066`).

A conversation post is an assistant-side message written into a V2
conversation from outside any run: an external coordinator session, or
operator alert tooling. It shows in the V2 chat view and is delivered to a
bound WhatsApp group through the V1 runtime adapter
(`v2/compat/v1_runtime`), the same way timer digests are.

A post records one row and nothing else. It never creates an input, never
wakes or steers a provider and never starts execution.

## Storage

Table `conversation_posts` (migration `0066_conversation_posts.sql`):

| Column | Meaning |
| --- | --- |
| `id` | Server-generated UUID |
| `owner_id`, `conversation_id` | Owner and conversation (foreign key to `conversations`) |
| `request_key` | Caller idempotency key, unique per owner and conversation |
| `author` | `coordinator` or `operator` |
| `label` | Short display label (1–40 bytes, default `Coordinator` / `Operator`) |
| `provider`, `model` | Optional tokens `[A-Za-z0-9._:-]{1,64}`, used only for the WhatsApp debug footer |
| `text` | 1–16000 bytes, not blank, not the bare `NO_REPLY` marker, no control characters except newline, carriage return and tab |
| `after_sequence` | The conversation's latest event sequence when the post was written |
| `created_ms` | Server time of the write |
| `delivered_ms` | When the delivery adapter took it over; `NULL` while pending |

Row identity is fixed by a trigger; `delivered_ms` can only go from `NULL` to a
time once.

## HTTP API

All routes take the owner credential like other owner routes: the browser
session cookie (writes also need the `x-orkestr-csrf` header), or
`Authorization: Bearer <owner session>` without an `Origin` header.

### `POST /api/v2/conversations/{id}/posts`

```json
{"request_key": "coord-2026-10-22-1", "author": "coordinator",
 "label": "Coordinator", "text": "Deploy finished.",
 "provider": "claude", "model": "example-model"}
```

`label`, `provider` and `model` are optional. Unknown fields are refused.

- `201` with the post: created.
- `200` with the same post: the same `request_key` with the identical body
  (an omitted label equals the author's default label).
- `409 conversation_post_conflict`: the same `request_key` with a different body.
- `409 conversation_archived`: the conversation's WhatsApp chat was archived.
- `400 invalid_conversation_post`: validation failed.
- `404 not_found`: unknown conversation or not this owner's.
- `401`: no valid owner credential; `403`: browser write without CSRF.

A post:

```json
{"id": "…", "conversation_id": "…", "request_key": "coord-2026-10-22-1",
 "author": "coordinator", "label": "Coordinator", "provider": "claude",
 "model": "example-model", "text": "Deploy finished.", "after_sequence": 42,
 "created_ms": 1792569600000, "delivered_ms": null}
```

### `GET /api/v2/conversations/{id}/posts`

Returns `{"conversation_id": "…", "posts": [post, …]}`, always oldest first.
`limit` is 1–100 (default 50).

- `?pending=true&limit=N`: posts not yet delivered (the delivery adapter).
- `?after_ms=T&limit=N`: posts created strictly after `T`.
- `?limit=N`: the newest N posts (the chat view).

`pending=false`, a negative `after_ms`, `pending` together with `after_ms` or
any other parameter is `400`.

### `POST /api/v2/conversations/{id}/posts/{post}/delivered`

Marks the post delivered and returns it (`200`). Idempotent: a replay keeps
the first `delivered_ms`. An unknown post, or a post of another conversation,
is `404`.

## Delivery through the adapter

Every 5 s, for each enabled binding, the adapter reads
`GET …/posts?pending=true&limit=20`. For each post it writes, in one ledger
transaction:

- a pseudo input in the exact timer shape V1 already imports as a reply parent
  (`origin: "timer"`, `source`/`connector` `orkestr-v2-timer`,
  `publicMessageId: "v2timer-<uuid5(post id)>"`, `timerSourceId: "post"`, text
  = the label). V1 accepts no other listed parent shape for a reply that has no
  WhatsApp input (`whatsapp-remote-timer-parent.js`), so V1 needs no change. V1
  sends it as `[Timer: <label>]` followed by the text.
- its final reply: `phase: "final_answer"`, text exactly the post text, and
  `provider`/`model` from the post (or from the conversation settings when the
  post has no provider) for V1's debug footer. Rust's reply prefix/footer
  settings are not applied: V1 adds its own reply prefix and footer and strips
  an embedded `dbg:` footer.

It then acknowledges with `POST …/posts/{post}/delivered`. Ids are
deterministic, so a lost acknowledgement or a restart adopts nothing new. A post
never waits behind a running input. While a binding is paused
(`enabled: false`) the adapter does not poll; posts stay pending and are
delivered after it is enabled again, like digests.

## Chat view

The UI polls `GET …/posts?limit=50` every 3 s and shows each post as an
assistant-side bubble with a small label badge, after the event at
`after_sequence` and ordered by `created_ms` among posts after the same event.
A post that follows an event older than the loaded page is not shown out of
place.

## Example

```sh
curl -sS -X POST "$ORKESTR_V2/api/v2/conversations/$CONVERSATION/posts" \
  -H "Authorization: Bearer $OWNER_SESSION" -H 'Content-Type: application/json' \
  -d '{"request_key":"coord-1","author":"coordinator","text":"Deploy finished."}'
```
