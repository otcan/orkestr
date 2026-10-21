# New WhatsApp chat from the Rust UI

"New WhatsApp chat" is the Rust UI counterpart of V1's
`orkestr create "<name>" --wa-participant …`. It creates a native V2
conversation and a WhatsApp group with the owner's numbers. The group's V1
thread is delegated to that conversation from the start, so the group talks to
the Rust app.

## Request

`POST /api/v2/whatsapp-chats` takes a browser owner session and CSRF.

```json
{"client_request_id": "<uuid>", "name": "Chat name", "provider": "codex",
 "model": null, "reasoning_effort": "low", "workspace": "/absolute/path"}
```

- `client_request_id` is the idempotency key. A retry with the same id continues
  the same chat from its last completed stage. The same id with another name or
  workspace returns `409 whatsapp_chat_conflict`.
- Provider, model and effort become the conversation settings (revision 1). Claude
  is refused (`409 provider_unavailable`) when the server has no Claude turns.
- `workspace` (optional, absolute) is recorded with the chat and becomes the V1
  thread's `cwd`. Worker command execution in a directory stays operator
  configuration (`workspace_exec` in the beta config). The browser never assigns
  it.
- Participants, accounts and the adapter token never come from the browser.
  `GET /api/v2/whatsapp-chats` reports only `available`, `providers`, how many
  numbers a group gets (`participants`), and the owner's provisions.

## Stages

Each stage is idempotent and recorded in `whatsapp_chat_provisions`
(migration 0058). Stages only move forward. A failed stage records a code in
`error`, and the response is `202`. Reaching `relay_pending` returns `201`.

| Stage | Done by |
| --- | --- |
| `conversation` | V2 conversation keyed by the request id |
| `settings` | provider, model, effort (only while the settings are still defaults) |
| `v1_thread` | V1 `POST /api/threads` with the provision's own fresh id. V1 returns an existing thread when the *name* matches, so a different id stops with `v1_thread_name_taken` instead of taking that thread over |
| `group` | V1 `POST /api/connectors/whatsapp/thread-groups` with the owner numbers (admins) and `mirrorToWhatsApp: false`. V1 journals the operation and reuses the bound group on a retry |
| `adapter_binding` | adapter `PUT /bindings/<route>` (create-only, `enabled: true`). `excluded_public_ids` lists the V1 thread's existing user inputs (none for a fresh thread) |
| `relay_pending` | V1 `PUT /api/threads/:id/binding` with `remoteBackend`, `remoteThreadId`, `remoteRuntimeEnabled: true`, `remoteMirrorEnabled: true`, `mirrorToWhatsApp: false`, read back and checked |
| `ready` | the operator registered the group with the scoped relay (`POST /api/v2/whatsapp-chats/{id}/relay-registered`) |

The sidebar links the new conversation to its V1 thread, so the group appears
once, as the V2 chat. Old V1 deep links to the thread open the conversation.

## Relay registration (operator step)

Inbound group messages reach V1 (and through the delegation, V2) only for groups
in the scoped relay allowlist. That allowlist is `all-threads.json` and
`relay-only.json`, plus the DE owner-groups config. The group map is hash-bound
to the transport journals. Adding a group means four steps:

- append the group;
- migrate each journal's `group_meta.contract`;
- restart the WA worker, the relay and the DE bridge in a quiet window;
- run the probe.

This briefly interrupts routing for every group. A browser request therefore
never triggers it. The private ops runbook (`deployments/thread-migration/new-chat/`
in the ops repository) registers pending chats with these guards:

- no active turn on delegated threads;
- zero `sending`/`uncertain` sends;
- the deploy lock is free;
- backups and contract checks first;
- an observation check of every group afterwards.

The runbook then marks the chat `ready`. Registration without restarts is a
follow-up V1 change.

## Archive

`POST /api/v2/whatsapp-chats/{id}/archive` marks a provision archived. The row
and its links are retained. The operator retires the V1 thread, revokes the
adapter binding (file edit) and removes the group from the relay allowlist.

## Private configuration

`ORKESTR_V2_WHATSAPP_CHATS_CONFIG` names a private file: 0600, owned by the
service user. A packaged service sets it with the plan key `whatsapp_chats`.
The packager copies only the path. The V1 side uses the existing loopback client
(`ORKESTR_V2_DESKTOP_BROKER_CONFIG`).

```json
{"adapter_url": "http://127.0.0.1:<adapter port>", "adapter_token": "<adapter token>",
 "remote_backend": "<V1 remote backend key>", "participants": ["<owner number>@c.us"],
 "allowed_principals": ["<adapter owner principal>"],
 "receiving_account_id": "<V1 account>", "reply_account_id": "<V1 account>",
 "reply_prefix": null, "max_outstanding_inputs": 8, "attachments": true}
```

Without this file, or without the V1 client, the UI says that new WhatsApp chats
are not configured.
