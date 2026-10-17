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

## Separate transport boundary (disabled until operator activation)

`whatsapp-owner-selfchat-transport.js` is the pure policy module. It admits only
history for one pinned self chat with explicit
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
ingestion, and never retry uncertain delivery automatically.

The adapter, SQLite journal, identity verifier, Unix-socket client/server,
registration planner and dedicated pump are implemented in the neighboring
`whatsapp-owner-selfchat-*` modules. The pump runs inside the existing Orkestr
server only when `ORKESTR_OWNER_SELFCHAT_CONFIG` names an approved, root-owned
configuration file whose ancestors are protected from non-root writes. It does
not sweep the general outbox. The general mirror permanently excludes the
dedicated-origin marker, including after scope revocation. This exclusion must be
deployed before activation; running the pump alongside an older server is unsafe.

The private runtime configuration has `home`, `activationApproved`, and `scope`.
In addition to the scope fields above, set `transport` to
`owner-selfchat-socket`, `socketPath` to the private operator-installed socket,
and `activatedAt` to the reviewed activation cutoff. An explicitly approved
`allowSuppressedThreadReplies: true` permits only replies whose parent is a
verified, allowlisted self-chat input. It never edits or lifts a primary group
hold. Disabled or retired threads remain excluded. API-agent threads are refused
for this subscription-only route. Progress, attachments and unparented replies
are not transported; only completed text responses are eligible.

The operator adapter is separately started with
`scripts/owner-selfchat-adapter.mjs serve <private-config>`. It has no TCP listener,
pairing/restart endpoint or broad inbox access. Its `challenge` and `verify`
commands corroborate the pinned identity using one fresh owner-authored message
with exact self sender/recipient fields. This is an ordinary self-chat message,
not phone authentication or a pairing code. Runtime PID plus systemd invocation
ID pin the proof to the existing session process; a change fails closed.

An alternative `identityVerificationMode: "live-account"` is implemented but
requires separate, explicit operator approval in the protected adapter config.
`liveAccountAttestation` version 2 binds `ownerUserId`, `accountId`, `chatId`,
`runtimeId`, `bridgeBuildHash`, `transportContract`, `approvalRef`, `approvedAt`
and `expiresAt`, with `approved: true`. Generic readiness and old `fromMe`
history are not accepted as identity evidence. Version 1 attestation is refused.

Verification generates a random **machine-only** challenge and requests fresh
account evidence through a fixed authenticated wrapper operation. This never
sends a WhatsApp message or asks the owner to type a phrase. The reviewed bridge
checks current SDK own ID and readiness before and after SDK PN→LID and LID→PN
lookups. Both mappings must agree with the protected self-chat ID. A missing,
ambiguous or mismatched mapping fails closed. The SDK may return cached mapping
data; this is not a claim of a fresh server lookup.

The response must match the outstanding challenge and exact build/policy, be
no older than 30 seconds and no earlier than the request, and come from the
unchanged runtime. The journal atomically consumes the latest challenge and
stores identity evidence. Consumed challenges survive reopening; reused or
superseded responses cannot overwrite identity. Evidence expires after 30 seconds
and is refreshed read-only before further operations. Expired/revoked approval,
wrong owner/scope/runtime or failed evidence refresh blocks dispatch. A refresh
failure latches the adapter closed for the rest of its process lifetime; polling
cannot retry the SDK lookup. Recovery requires an explicit operator action.

The identity record says `humanPresenceVerified: false`; it contains no invented
message ID or manual challenge proof. Explicit owner authorization establishes
which owner may bind the account. This can establish the same account/recipient
identity property as the earlier check, but does **not** establish the earlier
fresh human-phone interaction property. Deployment needs approval of that change.

The separately reviewed `allowVerifiedOwnIdAliases: true` option canonicalizes
only the exact verified own PN/LID pair in authenticated history fetched for that
self-chat. Both sender and recipient must be in the pair, with `fromMe: true`;
raw values remain as `providerFrom` and `providerTo`. Arbitrary LIDs, other
recipients and non-owner messages remain rejected. Outbound addressing always
uses the configured phone-based self-chat. Activation cutoff, duplicate and echo
filtering, parent requirements and uncertain-delivery blocking remain mandatory.
Neither option is enabled merely because an owner declines the manual challenge.

The same contact address on a different connector account can coexist without
replacing its existing binding. Registration refuses missing, malformed or
overlapping account selectors, including legacy aliases. Dedicated selection
state is keyed by owner, account and chat, so it cannot change the older route's
selected thread. The fallback output fence also respects account identity while
continuing to block replies with missing or ambiguous account evidence.

SQLite uses WAL and FULL synchronous commits. Send reservations are persisted
before invoking the existing wrapper, receipt IDs before accepting further
ingress. Pending/uncertain sends survive process restart and are never retried.
The same request key returns its saved receipt; a changed payload conflicts.
For a bounded pilot, protected `maxSendAttempts` limits total reservations in
the retained journal (including uncertain attempts). Saved receipts remain
readable at the limit; a new request is rejected before provider dispatch.
Inbound messages remain pending until the canonical router acknowledges them.
A bounded history overflow stops the pump rather than skipping messages. There
is no automatic reconciliation, history restoration or queue replay.

The adapter also requires an operator-verified `verifiedSendPolicy` for the
current runtime: `attempts: 1`, `textOnly: true`, and `maxTextLength >= 3000`.
The existing wrapper may have its own retry and long-text attachment behavior;
an outer journal cannot disable that. Verify effective provider settings before
attesting. If changing them requires restarting the existing bridge, obtain
specific approval; do not include that silently in installing this adapter.

An attestation alone is insufficient: both identity verification and adapter
readiness require the running bridge's `ownerSelfChatPolicy` to match the pinned
`bridgeBuildHash`. Version 1 requires transport-only operation, one send attempt,
literal text limited to 3000 characters, no marking seen, disabled automatic
routing and strict bearer authentication. Missing or mismatched live policy
blocks history and dispatch. The existing process identity is checked for every
operation; the policy response is cached for at most 30 seconds. Private bridge
code and all dependencies must be reviewed and installed under protected paths.

`scripts/owner-selfchat-router.mjs plan|register|retire <private-config>` manages
only the distinct connector account and supplemental chat binding. Registration
requires verified adapter health, an approved config, unchanged reviewed state
and thread ownership. Run registration during the reviewed release maintenance
window to avoid concurrent legacy JSON writers. It neither creates threads nor
rebinds groups. Retirement disables only the supplemental binding and retains
delivery evidence. The runtime notices config removal/change and pauses; errors
do not restart a bridge, fall back to another account, or trigger general recovery.

Rollout starts with the existing home thread only, then explicitly selected
same-owner thread IDs. The thread selection implementation supports `/threads`,
`/switch` and `@name` without new threads. Quote routing requires quote metadata;
the supported wrapper history currently does not expose it, so use those explicit
commands for this transport. Expanding the allowlist is separately reviewed
configuration, not a primary group change. No live readiness is implied by mocks.
