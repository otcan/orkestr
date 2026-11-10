# Personal Agent Ingress and Reasoning Inbox

OP-25 adds a durable acceptance boundary to the existing Agent Job SQLite store.
It does not start a model session or change WhatsApp routing. All three tables
are created additively only while `ORKESTR_PERSONAL_AGENT_ENABLED` is enabled.

## Owner API

`POST /api/personal-agent/messages` requires the authenticated owner user
session. The server derives the actor ID from that principal and records the
channel as `owner_api`; caller-supplied actor or channel identities are ignored.
Machine, anonymous, non-user, and non-admin principals are rejected. The first
slice accepts the global conversation or an existing project conversation.

Request:

```json
{
  "scope": { "kind": "global" },
  "message": "A user-authored message",
  "idempotencyKey": "client-generated-stable-key",
  "priority": "normal",
  "controlFlags": { "cancel": false, "hold": false, "pause": false }
}
```

`priority` is `low`, `normal`, or `high`; control flags are bounded metadata,
not an authorization decision or a substitute for effect/approval checks. The
endpoint returns HTTP 202 only after a single SQLite transaction has persisted
the canonical conversation, inbound message, reasoning inbox item, and
correlated event-outbox entry. A retry with the same scope, actor and key
returns the original IDs/cursor; reusing the key with a different payload is a
409 conflict. No model call is made or awaited on this request path.

Response:

```json
{
  "accepted": true,
  "replayed": false,
  "conversationId": "pac_example",
  "messageId": "pam_example",
  "eventId": "evt_example",
  "cursor": "pa1.1",
  "inboxItemId": "pai_example",
  "causalSequence": 1
}
```

The event payload contains identifiers and scope metadata only, never the
message body. The full owner-authored message remains in the canonical
conversation transcript table, separate from opt-in memory. The event ID and
cursor correlate the ingress record with the existing OP-05 event envelope;
all Orkestr IDs remain distinct from provider-native session IDs.

## Inbox consumption

Runtime consumers use the `listPersonalAgentReasoningInbox` core service with
an explicit global or project scope. It returns only queued/running/blocked
items for that scope, with message body, actor/channel provenance, priority,
control metadata, causal sequence and event correlations. Results are
causally ordered within the scope; priority remains available as metadata and
must not reorder messages. Provider-session claiming/heartbeat lifecycle is
owned by the runtime-session contract, not inferred from inbox delivery.

Pending rows survive process restart. Event journal dispatch is asynchronous
after commit; the durable outbox remains authoritative if journaling is
temporarily unavailable. A code rollback leaves additive tables and records
untouched; older code ignores them. Feature-off installs keep the existing
database schema and routes' behavior unchanged.
