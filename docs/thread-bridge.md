# Thread-native delegated-agent bridge

## Status and intended outcome

This is a **local, disabled-by-default foundation**, not a connected dot
integration. It supports authorized thread discovery, conversation history,
durable change replay, and same-thread delegated comments. It does not create
credentials, connect an account, register subscriptions, deliver webhooks, open
a new listener or provide a remotely authenticated bridge, wake a runtime, or grant execution authority.

The intended complete integration is bidirectional and thread-native: an owner
can authorize observation of their existing and future threads, an external
assistant can fetch current context, and separately authorized comments return
to the original thread. Creating a separate task is not a substitute for this
conversation model.

The HTTP controller is registered but intentionally has **no authentication
adapter**. All existing browser/admin/session callers are denied. Turning on the
feature flag alone does not make it usable remotely. The internal service is
exercised end-to-end with synthetic authenticated principals in tests.

## Threat model and authority

These are different permissions:

1. **Observe**: discover threads, read their visible conversation, and replay
   metadata invalidations. A grant may name selected thread IDs or `all`, which
   means existing and future threads owned by that same account.
2. **Comment**: append a passive, visibly delegated comment to explicitly named
   threads. Observation does not grant this permission. Comment scope does not
   accept `all`.
3. **Execute**: wake/steer a runtime, call a connector, access files or terminal,
   approve an action, change permissions, create tasks, or modify other systems.
   This implementation provides **none** of these capabilities.

An old instruction, quoted message, or observed human approval is historical
context, not a new grant or a fresh approval. Every returned history message has
`contextOnly: true`. Comments are stored as `role: assistant`,
`source: thread_bridge_agent`, `phase: delegated_comment`, and `state: completed`.
Their author, owner, provenance, and execution state are server-selected. They
never pass through the human-input queue, human mailbox reservation, runtime
wake, assistant-output forwarding, or connector outbox creation. Runtime turn
completion helpers exclude this source.

A future execution integration must intersect an explicit current action grant
with the thread's resource permissions and execution/approval policy. It must
preserve delegated source identity through the executor and fail closed when
that executor cannot distinguish agent requests from human authorization. No
text prefix, transcript role conversion, or remembered approval can replace
that boundary.

## Authentication boundary and local grants

The controller reads only `request.orkestrDelegatedPrincipal`. Existing
`requestPrincipal()` defaults an absent identity to admin, so it is deliberately
not used. Neither request JSON, query parameters, raw headers, nor an ordinary
owner/admin session can populate the delegated identity through these routes.
The service accepts this trusted, server-injected shape:

```json
{
  "kind": "delegated-agent",
  "ownerUserId": "example-owner",
  "agentId": "example-agent",
  "grantId": "example-grant",
  "issuer": "example-auth-adapter",
  "authMethod": "example-method"
}
```

The missing adapter must verify issuer, subject, audience, expiry, credential
revocation, and the owner/agent/grant binding before constructing this object.
It must not promote a human credential or a claimed owner header. Existing HTTP
security middleware still applies; future machine-auth changes require a
separate review of every allowed route and bypass path. Do not expose the raw
Orkestr API to make this controller reachable.

An operator-owned `thread-bridge-grants.json` under `ORKESTR_HOME` is reread on
every operation. This is security-sensitive configuration, not a public file or
a new grant-management endpoint. The implementation never creates this file or
adds a grant. Example only:

```json
[
  {
    "id": "example-grant",
    "ownerUserId": "example-owner",
    "agentId": "example-agent",
    "issuer": "example-auth-adapter",
    "authMethod": "example-method",
    "enabled": true,
    "expiresAt": "2030-01-01T00:00:00Z",
    "observe": "all",
    "reply": ["example-thread"]
  }
]
```

Enabling requires explicit local configuration:
`ORKESTR_THREAD_BRIDGE_ENABLED=1` and SQLite message storage. JSON-only storage
fails with `bridge_requires_sqlite`; no durability is simulated with audit
JSONL. Missing, malformed, duplicate, disabled, expired, or mismatched grants
fail closed. No wildcard owner, administrator override, automatic subscription,
or implicit connector permission exists. Operators should protect the grant
file with the same access controls as other authorization configuration, replace
it atomically, disable a grant to revoke it, and use a new grant ID for a new
consent lifecycle.

The registered owner must be active. Thread ownership and active lifecycle are checked afresh for history, replay,
and comments, including just before a reply write. Transferred, retired, and
deleted threads disappear from the returned inventory; their pending journal
entries are filtered. Clients must discard cached resources absent from the
current inventory and discard all cached data for a revoked grant. Checks do
not recall information already delivered. The file-based grant and thread
registry are separate from the message transaction: this first stage does not
promise linearizable cancellation of an already-authorized in-flight request.
A live transport must add a shared revocation/ownership fence before promising
that stronger guarantee.

## Local interface

All paths are under `/api/thread-bridge`, require the feature flag and a valid
injected delegated principal, and remain unreachable as a delegated caller
without the future authentication adapter:

| Method/path | Purpose |
| --- | --- |
| `GET /threads` | Current authorized IDs and a pre-inventory account checkpoint |
| `GET /changes?cursor=...&limit=100` | Forward-only account change replay |
| `GET /threads/:threadId/history?after=...&limit=100` | Current projected conversation, paginated by message ID |
| `POST /threads/:threadId/replies` | Passive delegated comment |

IDs must be canonical internal thread IDs, not names or aliases. Limits are
integers from 1 through 100. History continuation is the last returned message
ID. A missing/deleted continuation returns `bridge_history_reset_required`;
refetch the thread instead of silently skipping messages. History is a current
view, not an immutable event snapshot. Reconcile using the change feed.

The reply body permits only:

```json
{
  "requestId": "example-request",
  "text": "A comment for this thread.",
  "causedByMessageId": "example-message"
}
```

`causedByMessageId` is optional. When present it must identify a currently visible
non-bridge message in the same readable thread. A caller cannot select a role,
source, owner, tool, attachment, approval, execution mode, or arbitrary metadata.
Text is limited to 16,000 characters. A request is idempotent within
owner + authenticated agent + grant + thread + operation. Canonical text and
causal parent are SHA-256 hashed; reuse with a different canonical body returns
`bridge_idempotency_conflict`. The receipt and comment are committed in the same
SQLite transaction. Concurrent identical retries and retries after restart
return the same message ID. Expired/revoked authorization still blocks retries.
The receipt deliberately survives message deletion so a retry cannot resurrect
an old comment.

Self-authored bridge events are suppressed for the same agent, with the scan
cursor still advancing. A bridge-authored message cannot be used as a causal
parent, preventing direct reply-to-reply chains. This is a local loop guard,
not a complete distributed-agent budget: a future adapter must preserve causal
IDs, disallow duplicate event-driven actions, bound fanout/hops and retries, and
avoid manufacturing a new uncaused request for every received event.

## Durable journal and replay

The SQLite message database now records account-scoped ordered invalidations in
the **same transaction** as append, update, replacement, physical removal, or
migration. Updates and logical deletions get new change cursors even when the
message's original display cursor stays unchanged. Replacements compare old and
new messages, so unchanged retained messages do not create duplicate changes.
A failed journal write rolls back the message write and sequence increment.

Each event contains only cursor, thread ID, message ID, change kind, and optional
origin agent ID. No body, attachment, terminal output, tool result, hidden
reasoning, credential field, prompt file, local path, or full message object is
copied into the journal. Changes from invisible analysis/tool/internal messages
are omitted. If a previously visible message becomes hidden, a tombstone is
recorded so an authorized consumer can remove its cached copy.

Metadata capture is local and remains active even when the bridge API is
disabled. This avoids silent gaps across disable/re-enable cycles. The flag
gates access, not the local transaction journal. There is no outbound worker.
Existing SQLite rows are not falsely presented as new events: bootstrap history
is explicit. Legacy JSON rows migrated after this code is installed produce
invalidations when their thread has an explicit owner. The journal uses a
current thread-owner snapshot rather than stale message authorship, including
when an old message is edited after an ownership transfer. Rows whose thread
has missing ownership are not assigned to a guessed account; they remain
discoverable only through current authorized history. Ownership changes racing
a message transaction still require the future shared ownership fence.

A bootstrap/reconnect algorithm is:

1. Call `/threads`; save its `checkpoint`, captured before inventory lookup.
2. Read each returned thread's history to completion, treating all text as
   context. Establish this local baseline before triggering any action.
3. Replay `/changes` from the saved checkpoint, processing events in order.
   Refetch current history for invalidated threads rather than trusting an old
   payload. Apply deletions and reconcile the returned thread inventory.
4. Continue with the response's `cursor` until `hasMore` is false. Persist this
   cursor only after the page is processed successfully. Retries are at least
   once; deduplicate by account + event cursor.
5. Periodically refresh inventory even with no message changes. Thread creation,
   ownership changes, retirement and deletion are reflected in inventory but do
   not yet have dedicated lifecycle journal events or push notifications.

`cursor` is the last **scanned** row in the page, not the database maximum.
`lastDeliveredCursor` is the last returned event, or null if the page was fully
filtered. Advancing the scan cursor over revoked resources or own-agent echoes
prevents loops while preserving later authorized events. `currentCursor` is an
informational watermark; clients must never use it to skip outstanding pages.
An empty page can have `hasMore: true`.

A cursor binds a database epoch to its owner account and includes an
account-local sequence. Malformed,
foreign-epoch and future cursors fail with `bridge_cursor_reset_required`.
Cursors are position tokens, not bearer authorization. This stage retains
journal entries and idempotency receipts indefinitely and provides no pruning
API. A future retention policy must record an explicit low-water mark and
return a reset/resnapshot response for older cursors; silent truncation is
forbidden. Database reset creates a new epoch. Restoring an older backup or
rolling back software while writes continue requires operator-forced resnapshot
and epoch rotation before reconnecting a consumer; automatic restore detection
is not implemented.

## History privacy and limitations

History is an allowlist of message ID, user/assistant role, visible text,
creation time, minimal actor identity and `contextOnly`. It excludes deleted,
superseded, internal, non-final, tool and reasoning messages, and the `NO_REPLY`
sentinel. Attachments and their paths/URLs are not exported. No raw terminal,
runtime metadata, connector account objects or credentials are exported.

Visible user/assistant text itself can contain sensitive information. This
projection is not a secret scanner and must not be advertised as one. An owner
must explicitly consent to sharing the selected conversation content with the
recipient before a future transport is enabled. Outbound events should remain
metadata-only; fetch text under the current grant. If an installation requires
content classification or redaction, add a reviewed outbound content policy
before connecting it. Never include actual account history or configuration in
public examples, test fixtures, logs, or pull requests.

## Remote MCP endpoint (stage 1)

With `ORKESTR_THREAD_BRIDGE_ENABLED=1` the app origin also serves a remote MCP
server for clients such as ChatGPT plugins:

- `POST /mcp` (Streamable HTTP, stateless) with tools `list_threads`,
  `read_thread`, `read_changes`, `comment_on_thread`, `send_message`,
  `get_thread_status` and `wait_for_reply`.
- Messaging (`thread-bridge-messaging.js`) is a separate permission: OAuth
  scope `threads:message` plus grant field `message` (`"all"` or thread IDs).
  `send_message` queues input (`source: thread_bridge_message`, labelled with
  the assistant's id, actor `delegated-agent`) that the thread's agent acts
  on; it is idempotent by `request_id`, limited to 30 per hour per assistant,
  carries no chat route (the answer is not sent to WhatsApp) and is never
  echoed back to the sending assistant as an event. `wait_for_reply` waits
  at most 45 s for the answer to exactly that input: a completed final whose
  `parentMessageId` is the input, or one from the same runtime turn of the
  same generation when several inputs were batched (Codex turn ids repeat per
  Codex thread, so the Codex thread id must match; Claude attempt ids are
  unique). Deleted, internal or superseded finals are skipped, a visible
  answer wins over `NO_REPLY`, and later finals for other inputs never count. It
  returns `answered`, `failed`, `completed_without_reply` (a NO_REPLY final,
  or the runtime recorded the input's own turn as completed without a final)
  or `still_working`. Input state is not turn evidence: Codex marks an input
  completed as soon as `turn/start` is accepted, so only the runtime's
  `lastTurnId`/`lastTurnStatus` for that turn ends a wait early; without such
  evidence the wait runs to its timeout. Protocol errors (header mismatch,
  unsupported version, notifications) are answered before any streaming and
  keep their HTTP status. When the client accepts
  `text/event-stream`, the call is answered as an SSE stream that sends
  keep-alive comments every 2 s, so idle or first-byte timeouts cannot cut it
  off; a client disconnect cancels the wait. `get_thread_status` reports
  working, queued, idle or last_turn_failed.
- Every `POST /mcp` request is recorded as an `mcp_request` event (protocol
  era, method, tool, duration, outcome, HTTP status, JSON-RPC error code,
  client disconnect). Arguments and message content are never recorded.
  Unexpected failures return a JSON-RPC `-32603` and are recorded as
  `outcome: "exception"`. Connections approved before messaging existed must
  reconnect to get the new scope.
- OAuth 2.1 with PKCE (S256) and dynamic client registration:
  `/.well-known/oauth-protected-resource[/mcp]`,
  `/.well-known/oauth-authorization-server`, `/mcp-oauth/register`,
  `/mcp-oauth/authorize`, `/mcp-oauth/token`, `/mcp-oauth/revoke`.
- People authenticate with their normal Orkestr login (Keycloak when
  configured). The consent page names the client and the scope (all threads,
  comments); approving it writes the grant to `thread-bridge-grants.json`
  (`authMethod: orkestr-oauth`, 90 days). Removing or disabling that grant
  revokes access immediately.
- Redirect URIs must be HTTPS on `ORKESTR_MCP_OAUTH_REDIRECT_HOSTS`
  (default `chatgpt.com,chat.openai.com`). Access tokens last one hour;
  refresh tokens rotate. Only token hashes are stored, under `secrets/`.
- `ORKESTR_MCP_PUBLIC_URL` overrides the public base (default: the canonical
  app URL).
- History entries carry `actor.kind`: `human` only for messages typed by a
  person (WhatsApp, web UI); timers, workers, watches, mailbox routing and CLI
  sends are `automation`.

The endpoint is dual-era: requests carrying MCP 2.0 (`2026-07-28`) `_meta`
are served statelessly (`server/discover`, mirrored-header validation,
`resultType`), while legacy clients that open with `initialize` use the SDK
transport. A browser opening `/mcp` gets a page with the address, setup steps
and (signed in) the connected assistants with a revoke button. The OAuth server
also accepts Client ID Metadata Documents (HTTPS `client_id`) and returns `iss`
in authorization responses.

### Live events (MCP Events)

- `events/list` offers `thread.message.created` (arguments: optional
  `thread_id`, `actors` subset of `human`/`assistant`/`automation`, default
  human + assistant). The connected agent's own comments are never echoed.
- `events/subscribe` requires `delivery.mode: "webhook"`, a public HTTPS URL
  and a `whsec_` secret (24-64 bytes). The callback is verified with a signed
  `{type: "verification", challenge}` request whose challenge must be echoed;
  successful verification is cached for 24 h per client and URL.
  Subscriptions are idempotent by owner, client, URL, event and arguments,
  live 24 h by default (1 h - 7 d) and are stored in
  `secrets/mcp-event-subscriptions.json`.
- Delivery (`mcp-event-delivery.js`, every 5 s) replays the bridge journal
  from each subscription's cursor, re-checks the grant each run, and posts one
  Standard Webhooks-signed event per request (`webhook-id` = deterministic
  `eventId`, `x-mcp-subscription-id`, body <= 256 KiB, text <= 8000 chars).
  The cursor advances only after a 2xx; failures back off exponentially (up to
  10 attempts per event), `410` removes the subscription, `413` skips the
  event, and a revoked grant removes it.
- Outbound requests resolve DNS once, refuse private/local/reserved
  addresses, pin the validated address with the original hostname for TLS and
  never follow redirects (`safe-public-fetch.js`).

## Remaining work before a live connection

The local contract above must not be confused with MCP Events support. The
existing connector gateway documentation describes a separate tool surface.
Current authoritative transport guidance:
[OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events).
The published events protocol is `2026-07-28`; simply changing a version string
on an existing MCP server is not an implementation.

A separately reviewed implementation should deliver these stages:

1. **Identity and consent**: verified delegated authentication; narrow machine
   ingress; owner-bound consent UI for existing/future observation, history
   window, selected comment targets and recipient; credential rotation and
   revocation; persistent permissions established only with explicit approval.
2. **Complete lifecycle log**: account/thread create, rename, retirement,
   deletion, ownership and grant changes; resource-generation and grant-revision
   fencing; transactional revocation semantics; stable bounded snapshot/replay
   contract; retention floors and backup-restore handling. Until then, inventory
   polling is necessary and no all-thread push completeness claim is valid.
3. **MCP tools/resources adapter**: map read/change/comment operations to the
   actual negotiated protocol, retain trusted provenance, expose minimal
   schemas, and publish no shell/admin/general-purpose execution escape hatch.
4. **MCP Events transport**: implement the official persistent subscription,
   event discovery, webhook proof/signatures and delivery requirements using
   their specified methods and schemas. Store owner + delegated subject +
   resource filters + authorization revision + destination binding + generation
   and delivery cursor. Revalidate access both at enqueue and immediately before
   delivery. No broad account subscription without express consent.
5. **Delivery reliability/security**: durable transactional outbox tied to the
   journal; verified destination and SSRF restrictions; bounded retry/backoff,
   deduplication, acknowledgement and dead-letter handling; reconnect replay;
   signature verification and rotation; cancellation and credential revocation;
   payload minimization; rate limits and non-content audit records.
6. **Optional execution**: separate explicit grants for concrete actions and
   resources, human approval where required, immutable source identity through
   every runtime, causal budgets, and tests that old transcript approvals cannot
   authorize fresh actions. Passive comments remain usable without this stage.

## Verification

Run the synthetic local suite without connecting any account:

```sh
npm run build:server
node --import ./test/test-bootstrap.mjs --test test/thread-bridge.test.js test/thread-bridge-api.test.js
npm run check
npm run oss:boundary-check
```

Tests cover default denial, owner/agent/issuer binding, scope separation,
future-thread discovery, visible-history projection, pagination beyond 100,
filtered-page continuation, edit/delete invalidations, storage reopen,
ownership changes/revocation/retirement, transactional rollback, concurrent
idempotency, hash conflicts, forged input fields, and passive reply semantics.
Network authentication, webhook delivery and runtime execution are deliberately
not claimed as tested or implemented by this change.
