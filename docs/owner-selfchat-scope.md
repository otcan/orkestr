# Optional owner self-chat scope

This local feature extends the existing Message Yourself router. It does not
register an account, start a bridge, change credentials, enable a production
binding, remove a hold or create threads. The existing connector must already
be authorized, ready and eligible for messaging before activation.

An operator can propose a supplemental chat-level private-owner binding to an
existing home thread. Preserve that thread's primary group binding. Registration
and the supplemental binding remain separately reviewed configuration work.
The onboarding helper that replaces a primary binding must not be used for a
thread already attached to a group.

The private overlay may explicitly supply this disabled-by-default scope:

```json
{
  "enabled": true,
  "ownerUserId": "example-owner",
  "accountId": "example-personal-account",
  "chatId": "15550000001@c.us",
  "homeThreadId": "existing-home-thread",
  "threadIds": ["existing-home-thread", "existing-project-thread"]
}
```

Store it as `ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE`. These are fake examples,
not deployed values. Require an authenticated bridge identity and the account's
verified own chat; a caller-supplied `fromMe` flag is not independent authentication.
Keep the bridge's existing credential boundary and narrowly scoped ingress.

The owner uses `/threads`, `@name request`, `/switch name`, `/switch` to return
home, or quotes an indexed reply. Only explicitly listed threads belonging to
the same owner are eligible, including existing group-bound threads. Original
thread IDs, group bindings, sender accounts and participant ACLs stay unchanged.

Known outbound echoes and duplicate events are rejected before home selection,
focus changes or job triggers. Binding account and inbound security checks also
run before selection state changes. Scoped inputs carry a policy revision and
home-thread identity into the durable thread message. External input cannot
supply those internal markers.

Only completed final assistant replies and router command answers to those
scoped inputs use the self account/chat. Replies recheck the current scope and
owner. Disabling/changing the scope blocks new scoped reply candidates; removing it
also blocks supplemental self-chat ingress. Already accepted outbox jobs still
require explicit reconciliation/hold; this scope is not a provider kill switch.
Existing mirror suppression and
holds still apply. Unsolicited notifications, progress, queue notices and message
mutations are not migrated by this feature. No old queue or campaign is replayed.

This does not claim exactly-once provider delivery. Existing acknowledgement and
uncertain-delivery records remain authoritative; an uncertain send requires
reconciliation, not an automatic resend. The existing bridge's in-flight echo
protection remains necessary alongside durable outbound echo IDs.

Local tests cover same-owner allowlisting, supplemental entry to an already
bound home thread, unchanged original groups, selected-thread replies from the
self account, actual mock outbound echoes, echo/duplicate commands that cannot
steer focus, scope revocation and existing suppression. All identities and
transport responses are fake; no provider sends, model API calls or pairing.

Before enabling, an operator must verify bridge readiness under its existing
service identity, account eligibility, own-chat identity, authorization, and
registered transport support. A status access denial is not permission to read
session files or change filesystem ownership. Existing operator access is
separate from granting the agent new access. After approved activation, an
owner-only test must verify inbound ID, selected existing thread, one reply ID,
and absence of echo-generated input before expanding any scope.

## Separate transport boundary (private implementation in progress)

`whatsapp-owner-selfchat-transport.js` is an inert, pure policy module, not an
installed service. It admits only history for one pinned self chat with explicit
`mark_seen=false`, and bounded text to that same chat. Pairing, service control,
bulk inbox reads, group operations and attachments are not admitted. Constructing
it requires verified identity as well as an activation timestamp; readiness or a
configured phone-number label alone is insufficient identity evidence.

The input filter excludes events at or before activation, synthetic summaries,
wrong-chat events, duplicates, consumed events and known outbound IDs. Pending or
uncertain delivery blocks ingestion to prevent an unacknowledged echo becoming
an owner command. The configured chat ID must match both sender and recipient;
unverified address aliases fail closed. An operator integration must retain a
durable cursor and atomic send reservations, persist receipt IDs before resuming
ingestion, and never retry uncertain delivery automatically. These persistence
and socket components are not implemented by this pure policy module.

Do not repoint a global worker socket to add a second account. Remaining work is
account-specific transport dispatch and status, a scoped operator-owned adapter,
durable acknowledgement handling, supplemental account/chat registration and a
private thread allowlist. Existing primary-group mirror holds remain effective;
any requested owner-only exception requires an explicit scoped policy and tests,
not removal of the original group hold. No live readiness is implied by local
tests, and this module must not be installed as a privileged service as-is.
