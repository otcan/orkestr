# Scoped owner group replies

This optional transport extension uses an already paired WhatsApp Web account
to route fresh messages authored by that account into existing Orkestr threads.
Completed answers return to the original group. It does not create groups or
pair accounts. It supports text and need-input questions; it does not transfer
attachments or forward messages from other participants.

The thread registry remains authoritative: before input and each reply the relay
checks the thread owner, group binding, enabled state and retirement state.
The deployment config supplies an explicit allowlist of existing group/thread
pairs. Disable the old binding mirror when this relay owns reply delivery.
Do not enable two transports for the same owner-authored input.

## Preparation

Use `scripts/prepare-scoped-group-bridge.mjs <inactive-bridge-copy>` against a
copy of the preserving self-chat transport runtime. The source-shape checks
reject an incompatible runtime before modifying files. The helper adds the
group policy, wrapper command and relay files. It does not install services.

The bridge keeps the legacy router disabled. Set its existing preserving mode
and identity variables, plus `WA_OWNER_GROUP_CONFIG` pointing to a protected
JSON config. Run `scripts/scoped-group-relay.mjs <config>` as a separate service
with access to the local Orkestr API and the same transport journal.

Config fields:

| Field | Purpose |
| --- | --- |
| `ownChatId` | Exact paired account identifier; checked against the live client |
| `ownerUserId` | Orkestr principal who owns every allowed thread |
| `activatedAt` | ISO timestamp; older input is never imported |
| `groups` | Array of `{chatId, threadId, name}` |
| `replyPrefix` | Deployment's configured reply identity |
| `appendDebugFooter` | Enable the shared WhatsApp model/quota/queue footer; per-thread suppression and tenant isolation still apply |
| `forwardProgressUpdates` | Opt in to completed assistant commentary and approval updates on this transport; independent of the disabled legacy mirror |
| `forwardProgressSince` | Required ISO activation cutoff when updates are enabled; older updates are not replayed |
| `formattingModulePath` | Optional existing immutable Orkestr formatter module for a minimal transport install; defaults to the product module in the same repository |
| `journalPath` | Transport SQLite journal |
| `relayJournalPath` | Orkestr routing and completed reply journal |
| `statusPath` | Optional private JSON status file, updated each poll |
| `wrapperPath` | Prepared account wrapper, called using `group-reply` |

The account, cutoff and group map are bound to the transport journal by a hash.
Changing that contract requires a deliberate journal migration; do not reset a
journal to bypass an uncertain delivery. Keep the config, journals and account
credentials private. `ORKESTR_ENV_FILE` selects the local CLI API credentials.

## Delivery and recovery

The transport records provider message IDs, admits only `fromMe` input in the
allowlist, and suppresses its own output IDs. Sends and observations share a
serial queue so an echo arriving before its receipt is suppressed. On bridge
readiness, the latest 30 messages per group are reconciled against the cutoff
and ledgers. This bounded recovery does not replace a full historical import.

Orkestr input uses a stable idempotency key and never requests the legacy
WhatsApp reply path. Replies are matched to the exact parent message, with
pagination for long turns. A broken thread binding does not starve other
groups. Old questions are skipped when a completed final exists.

Each provider send is reserved durably before the attempt. A timeout, missing
receipt or restart during sending changes it to `uncertain` and blocks further
outbound delivery until an operator checks the provider history. Never retry an
uncertain send blindly. A confirmed receipt can be replayed locally by the same
request ID without another external send.

Formatted chunks are saved in the relay journal before dispatch, keeping retries
byte-identical even when quota or load changes. The footer is appended once, at
the end, without splitting its lines across chunks. Quota telemetry comes from
the existing owner-scoped API and is optional. When upgrading an older relay,
stop it gracefully and confirm every accepted transport send has a relay receipt
and no partially delivered reply remains before enabling changed formatting.

The wrapper allows authenticated health, allowlisted history/group metadata,
and `group-reply <group-id> <request-id> <original-message-id> <text>`. A send
without an observed owner input in the same group is rejected. Reset, pairing,
group mutation, arbitrary destinations and legacy router endpoints are closed.

Validate with:

```sh
node --test test/whatsapp-scoped-group-transport.test.js test/whatsapp-scoped-group-relay.test.js
```

A live end-to-end verification still needs a fresh owner message from WhatsApp.
Service health and membership checks alone do not prove phone delivery.

With progress enabled, only completed commentary/approval messages from known
agent sources and matching the exact inbound parent are forwarded. Streaming
fragments, analysis, tools and context-compaction events are excluded. Updates
keep the turn open, use the same durable payload/receipt journal and label their
footer `msg:*update*`. A final supersedes any unsent progress already in history.
Enabling updates does not reopen completed turns or change legacy group bindings.
