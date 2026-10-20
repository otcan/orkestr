# Scoped owner group replies

This optional transport extension uses an already paired WhatsApp Web account
to route fresh messages authored by that account into existing Orkestr threads.
Completed answers return to the original group. It does not create groups or
pair accounts. It supports text, need-input questions and allowlisted image
attachments (JPEG, PNG, GIF and WebP, up to 10 MiB). Images are staged in a
private transport media directory, then submitted through the existing
WhatsApp inbound-media and thread-input path so the thread's normal attachment
publication policy applies. Unsupported, oversized or unavailable media is
represented by a visible skip note in the thread. Other participants are
excluded by default; restoring an existing thread-scoped contact requires the explicit
[participant admission policy](scoped-group-participant-routing.md).

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
| `heldInputIds` | Optional array of exact transport input IDs excluded before any API call or send; malformed values fail startup |
| `replyPrefix` | Deployment's configured reply identity |
| `appendDebugFooter` | Enable the shared WhatsApp model/quota/queue footer; per-thread suppression and tenant isolation still apply |
| `forwardProgressUpdates` | Opt in to completed assistant commentary and approval updates on this transport; independent of the disabled legacy mirror |
| `forwardProgressSince` | Required ISO activation cutoff when updates are enabled; older updates are not replayed |
| `formattingModulePath` | Optional existing immutable Orkestr formatter module for a minimal transport install; defaults to the product module in the same repository |
| `journalPath` | Transport SQLite journal |
| `relayJournalPath` | Orkestr routing and completed reply journal |
| `mediaDir` | Optional private directory for staged media; defaults beside the transport journal |
| `statusPath` | Optional private JSON status file, updated each poll |
| `wrapperPath` | Prepared account wrapper, called using `group-reply` |

The account, cutoff and group map are bound to the transport journal by a hash.
Changing that contract requires a deliberate journal migration; do not reset a
journal to bypass an uncertain delivery. Keep the config, journals and account
credentials private. `ORKESTR_ENV_FILE` selects the local CLI API credentials.

## Delivery and recovery

For an audited recovery, preserve private snapshots of the transport and relay
journals, original inputs, accepted provider receipts and a disposition/reason
ledger. Put unresolved or intentionally deferred original IDs in `heldInputIds`.
Holds do not mark inputs routed, completed or sent, and never expire. Status
reports `configuredHolds`, `held` matching stored inputs, and `excluded` inputs
outside the group whitelist (held takes precedence). IDs and message content are
not emitted in these counters. Unknown hold IDs are allowed for preemptive holds.
The process snapshots holds at startup; change them only through a reviewed
configuration replacement and controlled relay restart. Removing a hold permits
processing again and therefore requires a separate replay decision.

Removing a group from the relay's `groups` whitelist excludes its inputs and
replies without changing the thread binding or any delivery receipts. When the
transport uses a journal-bound group contract, use a separate relay-only config
for a narrower whitelist. Keep the worker/wrapper on the original transport
config; never rewrite the transport contract or journal to remove a relay group.
Reconcile inputs arriving during maintenance before restart: an unheld unfinished
input in the whitelist is eligible, regardless of its age. These holds are not an
automatic time cutoff. Roll back by stopping the relay and preserving holds and
exclusions; do not restart older code that ignores them.

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

## Replies after the turn (bound api-session)

An assistant message posted with `orkestr api-session message` on a WhatsApp
thread whose legacy mirror is off (`mirrorToWhatsApp: false`) is parented to the
newest relay-routed owner input. That input must be newer than
`ORKESTR_API_SESSION_RELAY_PARENT_MAX_AGE_MS` (default 6 hours). An explicit
`parentMessageId` is kept. The response reports `relayParentMessageId` and no
legacy delivery is attempted.

The relay watches the newest completed input of each group for six hours, at
most every ten seconds. It delivers an `api-session` final reply with that
parent once, through the same payload/receipt journal, and never while a send
is uncertain.

With `forwardProgressUpdates`, commentary honours the thread's
`suppressWhatsAppUpdates`. Approval requests are still sent.

## Delegated (remote runtime) threads

A relay thread can be delegated to a remote runtime, for example the Rust
transition adapter (`v2/compat/v1_runtime`). Set the binding's `remoteBackend`,
`remoteThreadId`, `remoteRuntimeEnabled` and `remoteMirrorEnabled`, and keep
`mirrorToWhatsApp: false`. The relay remains the only WhatsApp sender.

- The relay's `POST /api/threads/<id>/input` is forwarded to the backend
  configured in `ORKESTR_REMOTE_THREAD_BACKENDS_JSON` as owner input. The
  principal is `scoped-owner:<ownerUserId>`, because the transport only admits
  owner-authored input. The local dispatch fence keeps V1 from running it.
- Input is refused (409) when the legacy mirror is enabled, and when it comes
  from an admitted non-owner participant.
- A transient backend failure returns 502. The relay retries the same
  idempotent input, and the backend deduplicates it by public message ID.
- A definite refusal marks the input failed and adds one short explanatory
  answer. The relay sends that answer and closes the turn.
- Replies are imported by the existing remote mirror sync and sent by the relay.
  After every chunk of a mirrored reply is confirmed, the relay reports the
  receipt to `POST /api/threads/<id>/messages/<message-id>/scoped-relay-delivery`.
  The mirror acknowledgement then reports `delivered` to the runtime. A failed
  report is retried on the next poll and never resends.
- Roll back by clearing the remote binding fields, or by setting
  `remoteRuntimeEnabled: false`. The thread then runs locally again.

## Synthetic health probe

`scripts/whatsapp-group-probe.mjs <probe.json>` checks the whole scoped path:
the secondary owner bridge posts one fixed, labelled text into a dedicated
probe group. The primary worker must record it, the relay must route it to
the group's probe thread, and the thread's reply must be `sent`. The probe
config is private and lives with the operator. It names `chatId`, `threadId`,
`senderUrl`, `senderTokenFile`, `senderConfigPath`, `primaryConfigPath`,
`statePath`, `timeoutMs`, `alertAfter` (default 2) and `alertCommand` (argv;
the alert body arrives on stdin, the subject in `PROBE_ALERT_SUBJECT`).

The probe refuses to run in these cases:

- the group has any participant other than the two owner accounts
- the probe thread is bound to more than one group
- the group is not bound to the configured probe thread

It never sends free text. Bootstrap the group with one message, so the
sender bridge has a recorded parent. Run the probe every 15 minutes from a
timer, and set `ORKESTR_WA_DEPLOY_PROBE_COMMAND` so connector deploys roll
back when it fails.
