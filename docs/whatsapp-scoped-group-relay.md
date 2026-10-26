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
| `groups` | Array of `{chatId, threadId, name, forwardProgressUpdates?}`; each group's optional boolean overrides the global progress flag |
| `heldInputIds` | Optional array of exact transport input IDs excluded before any API call or send; malformed values fail startup |
| `replyPrefix` | Deployment's configured reply identity |
| `appendDebugFooter` | Enable the shared WhatsApp model/quota/queue footer; per-thread suppression and tenant isolation still apply |
| `maxReplyChars` | Optional single-message budget for new replies, 1000 to 60000 characters (default 20000, or `ORKESTR_WHATSAPP_MAX_REPLY_CHARS`) |
| `forwardProgressUpdates` | Boolean for completed assistant commentary and approval updates; defaults on for the validated owner groups, independently of the legacy mirror |
| `forwardProgressSince` | ISO activation cutoff; required for explicit global `forwardProgressUpdates: true`. When omitted with default-on or group-only activation, process startup is the cutoff |
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

Progress from the built-in V2 adapter (`rust-v2-adapter`) follows the same group policy,
activation cutoff, parent matching, per-thread update suppression and durable
receipt rules as local executor progress. Enable adapter progress export and
clear the thread's update-suppression flag when progress delivery is wanted.
The legacy mirror stays disabled while the scoped relay owns delivery.
Adapter updates already acknowledged by a transport are never replayed after
progress is enabled or the relay restarts.

## Dynamic group registration

A group created for a Rust (V2) chat should not need a contract migration and a
restart of every group's transport. With an optional block in the transport,
relay and DE bridge configs:

```json
"dynamicGroups": {"enabled": true, "since": "<ISO activation>", "journals": ["<DE transport journal>"]}
```

groups may also be registered at runtime in the journal's `group_registered`
table. The static `groups` allowlist and its contract hash are unchanged, so
adding the block needs no journal migration. Each process reads its config at
startup, so it takes effect at the next restart (once).

**Registrar.** The relay is the only registrar. Every 30 s it reads V1's thread
registry. It registers a group in the primary journal and in every
`journals` entry (for example the DE bridge) when V1 shows all of these:

- the thread belongs to `ownerUserId` and is not retired;
- its WhatsApp binding is enabled, names a group chat and has
  `mirrorToWhatsApp: false`;
- the runtime is delegated to a remote backend (`remoteThreadId`, runtime on);
- the thread was created after `since`.

Existing threads (created before `since`) are never picked up. They stay
operator-registered.

**Removal.** When a thread stops being eligible (retired, binding disabled,
delegation off), the relay marks its registration removed at the next poll.
This is the archive path for a disposable chat: retire its V1 thread. Rows are
kept for audit, and a group can be registered again later.

**Safety.**
- A registered group shares the route fence of the static groups when
  `routeControl` is configured.
- Messages sent before the registration (and before `since`) are never
  imported.
- The relay still checks each input against the thread binding before routing
  it.
- The native worker and the reply wrapper accept sends and history reads only
  for static or currently registered groups.

`SELECT chat_id,thread_id,registered_at,removed_at,reason FROM group_registered`
on a journal lists the registrations.

## Owner-only group creation

A scoped native worker never creates chats unless its config has:

```json
"groupCreate": {"enabled": true, "authorizedAt": "<ISO owner authorization>", "ownerParticipantIds": ["<owner number>@c.us"]}
```

With this block, V1's thread-groups `POST /chats` (reached through the
connectors gateway) creates exactly one kind of group:

- **Who is in it.** The worker account is the creator. Every other participant
  must be one of `ownerParticipantIds`, the owner's own numbers. Extra
  participants are refused. The owner members become admins, and the group is
  opened so they can post.
- **Idempotent.** The V1 `operationId` is journaled in `group_create`. A repeat
  returns the recorded group.
- **Lost answers.** When the answer is lost, the attempt is settled by reading
  the account's groups back. It takes exactly one new group with this title and
  these participants, created after the attempt started.
- **No global block.** An attempt that stays unsettled refuses that operation
  id only (`409 scoped_group_create_outcome_unsettled`). It never blocks other
  creates or any send.

The new group still needs relay registration (static, or `dynamicGroups`).

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
byte-identical even when quota or load changes. A reply within the budget
(`maxReplyChars`, default 20000) is sent as one message, never split. A longer
reply is sent as one message with its first part, cut at the last paragraph or
line break in the final quarter of the window (else a sentence end or space, and
never inside a surrogate pair or emoji sequence), ending with
`… (full reply attached)`, followed by the full text as a Markdown document
`reply-<id>.md` in the same group. The document is one more journaled send with
the same parent or timer-proof authorization, deduplication and uncertainty
rules as a text; it needs a scoped native worker (`/send-document`). Timer
notifications behave the same way. Payloads frozen by an older build keep their
stored chunks on retry. The footer stays on the message and is not counted
against the budget; a `dbg:` footer already embedded at the end of a long reply
stays on the message as well. When WhatsApp Web delivers a message but
`sendMessage` returns no usable model (or throws), the transport confirms the
send only by exactly one own, server-acked, not yet journaled message in that
group created after the send started; otherwise it stays `uncertain`. Quota telemetry comes from
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

Local V1 commentary, including Claude Code's started-working acknowledgement,
is eligible on the first relay poll (the runner polls every three seconds).
After the first confirmed send, each input gets at most one commentary update
per minute. The newest pending update replaces older pending notes. This budget
and any unfinished send survive a relay restart; a retry keeps its frozen payload
and provider request ID. Questions, approvals and final answers remain immediate.
Remote V2 exports retain their adapter pacing and acknowledgement contract.
Thread binding update suppression still applies to commentary in either runtime.

## Owner-authorized coordinator access

Only when the account owner explicitly grants one operator agent full use of
their own account, add a `coordinator` block to the transport config:

```json
"coordinator": {"tokenSha256": "<sha256 hex of a dedicated bearer>", "authorizedAt": "<ISO time of the owner's grant>"}
```

The coordinator bearer is a separate credential (it must differ from the
transport token; only its hash is in the config). It reaches only
`/coordinator/*`, and the transport token never reaches those routes:

| Route | Purpose |
| --- | --- |
| `GET /coordinator/health` | Readiness, identity match, uncertain coordinator sends |
| `GET /coordinator/chats?cursor=&limit=&unread_only=1` | Every chat, metadata only, newest first, cursor paging (max 100) |
| `GET /coordinator/chats/<chat>/messages?before=&limit=` | History page older than `before` (max 50); never marks seen |
| `GET /coordinator/groups/<group>/members` | Group participants and admin flags |
| `POST /coordinator/send` `{to, text, requestId}` | Originate a text to any individual or group chat; no reply parent needed |
| `GET /coordinator/sends?state=uncertain` | Recent coordinator send journal rows |
| `POST /coordinator/resolve` `{requestId, outcome, providerId?}` | Operator decision for an uncertain send after reading the chat |

Coordinator sends use their own journal table. A request ID is sent at most
once; a retry with the same text returns the recorded receipt, a different
text conflicts. A send without a usable receipt is confirmed by reading the
chat back (same rule as group replies); otherwise it is `uncertain` and blocks
further coordinator sends to that one chat only. It never blocks group replies
or other chats. A coordinator text in an allowlisted group is admitted as owner
input like a message typed on the phone, so do not run a second relay on the
same group input.

The bridge mounts these routes through `transportOnly.routes(app, getClient)`,
added by `prepare-scoped-group-bridge.mjs`. Without a `coordinator` block,
nothing is mounted and the bearer rules are unchanged.

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
  Retries stop once the input is older than `ORKESTR_REMOTE_RELAY_INPUT_MAX_AGE_MS`
  (default 30 minutes, at least one minute). A paused or refused binding
  answers 503, for example. The input is then closed like a definite refusal
  (`remote_runtime_input_expired:<status>`), so it never runs stale.
- A definite refusal marks the input failed and adds one short explanatory
  answer. The relay sends that answer and closes the turn.
- Replies are imported by the existing remote mirror sync and sent by the relay.
  After every chunk of a mirrored reply is confirmed, the relay reports the
  receipt to `POST /api/threads/<id>/messages/<message-id>/scoped-relay-delivery`.
  The mirror acknowledgement then reports `delivered` to the runtime. A failed
  report is retried on the next poll and never resends.
- Replies to V2 timer turns have no relay input to answer. V1 gives each one a
  local parent (source `orkestr-v2-timer`) and records the server event
  `whatsapp_remote_timer_parent_materialized`. The relay's timer notifications
  (`timerNotifications` must include the thread) deliver the reply to the
  thread's bound chat, labelled `[Timer: <label>]`. They use the same proof
  journal, route fence and uncertain rules as a V1 timer run. The proof chain
  is: event, then the parent bound to the same `remoteThreadId`, then the
  imported final reply. After the send, the relay reports the receipt to
  `scoped-relay-delivery`, and the mirror acknowledgement settles the remote
  input. Some replies are definitely not sent: stale replies, replies on a
  binding with `mirrorReplies: false`, and sends rejected before dispatch.
  These are reported with `{"outcome":"suppressed"|"failed","reason":...}`, so
  the input still settles. An uncertain send blocks delivery and is never
  reported or retried.
- The remote runtime is the delegated thread's only executor. V1-owned timers
  that target the thread do not run there. When one falls due, V1 pauses it
  (`pausedReason: "thread_delegated_to_remote_runtime"`, event
  `timer_due_refused`) and posts a passive notice that the relay delivers once.
  `orkestr timers run` answers `409 timer_target_delegated_to_remote_runtime`.
  Move the timer to V2 (`orkestr timers handoff`), or turn it back on after the
  handback. Timers owned by V2 are not affected.
- Other pending local input on a delegated thread is dropped. This covers UI or
  API messages, executor commands, and V1 timer input queued before the
  delegation. It is marked `failed`/`dropped` with event
  `thread_input_dropped_delegated`, so nothing runs in a burst after the
  handback. Forwarded owner WhatsApp input is not affected.
- Roll back by clearing the remote binding fields, or by setting
  `remoteRuntimeEnabled: false`. The thread then runs locally again. Re-enable
  any timer paused during the delegation.

## Synthetic health probe

`scripts/whatsapp-group-probe.mjs <probe.json>` checks the whole scoped path:
the secondary owner bridge posts one fixed, labelled text into a dedicated
probe group. The primary worker must record it, the relay must route it to
the group's probe thread, and the thread's reply must be `sent`. The probe
config is private and lives with the operator. It names `chatId`, `threadId`,
`senderUrl`, `senderTokenFile`, `senderConfigPath`, `primaryConfigPath`,
`statePath`, `timeoutMs`, `alertAfter` (default 2) and `alertCommand` (argv;
the alert body arrives on stdin, the subject in `PROBE_ALERT_SUBJECT`).

Optional `providerRateLimitLogs` lists Codex log databases (for example
`~/.codex/logs_2.sqlite` of the account running the probe thread). When the
input was recorded but the reply did not arrive in time, and one of those logs
shows an HTTP 429 retry from the model provider since shortly before the probe
started (`rateLimitLookbackMs`, default 10 minutes), the run is `degraded`
(`probe_reply_delayed_provider_rate_limit`) instead of failed: exit code 0, no
failure alert, and the failure streak is neither counted nor reset. A long
degraded streak alerts once after `degradedAlertAfter` runs (default 8).

The probe refuses to run in these cases:

- the group has any participant other than the two owner accounts
- the probe thread is bound to more than one group
- the group is not bound to the configured probe thread

It never sends free text. Bootstrap the group with one message, so the
sender bridge has a recorded parent. Run the probe every 15 minutes from a
timer, and set `ORKESTR_WA_DEPLOY_PROBE_COMMAND` so connector deploys roll
back when it fails.

## Operator notices

Host alerts (disk, memory, health watchers) can be posted into explicitly listed
owner groups without a parent message or a timer proof. This is a separate, opt-in
send class of the scoped transport and native worker:

```json
{ "operatorNotifications": { "enabled": true, "chatIds": ["120000000001@g.us"], "maxPerHour": 60 } }
```

- Every `chatIds` entry must be a statically configured scoped group.
- `POST /send-text` with `operatorNotice: true`, `requestId` of the form `opnotice:<id>`,
  `accountId`, `to` and `text` only. Parent, thread and notification ids are refused.
- Journaled in `group_send` with parent `operator-notice`; deduped by request id; an
  uncertain result blocks retries; at most `maxPerHour` per transport.
- `scripts/scoped-native-group-reply.mjs group-send` accepts `{kind: "operator", to, requestId, text}`.
- It never reads, marks seen or counts as owner input. No proof rows are written or needed.

### Immediate remote reply delivery

A remote backend can advertise `messageChanges: {"version":1,"path":"changes"}`
on its authenticated health endpoint. The scoped relay then holds a request to
V1's admin-only `GET /api/connectors/whatsapp/remote-runtime/changes` gateway.
An adapter export commit wakes that request. The current gateway returns only
changed, currently bound thread IDs; the relay immediately queues independent
per-thread imports and delivery through its admin-only sync endpoint.
The 25-second connection heartbeat does not delay exports. A new adapter epoch
returns a route snapshot, so disconnects and restarts recover pending exports.
The notification cursor advances when work is queued in memory. Each affected
thread remains queued until import and delivery succeed, independently of other
threads. A process restart starts from an adapter snapshot again; unacknowledged
exports plus the existing request/receipt journals recover work without duplicate
sends. Snapshot recovery has two workers; fresh export events have four separate
slots, so a slow reconnect scan cannot consume all delivery capacity. Older V1
gateways retain the original cursor-after-delivery protocol during rollout.
Backends without this capability keep the ordinary scan path.

Unrelated thread reads may continue while immediate delivery runs. The same
input is serialized, actual transport sends remain serialized, and any unresolved
transport send blocks delivery. Binding, parent, participant and route-fence
checks apply to the immediate path too. Confirmed remote receipts are reported
to the adapter immediately. None of these events prove recipient reads.

### Optional twenty-second fallback acknowledgement

An operator may configure a literal acknowledgement and opt in individual groups:

```json
{
  "acknowledgement": {"text":"Received — working on it.","queuedText":"Received, queued behind the current task in this chat; I'll answer when it finishes.","since":"2026-01-01T00:00:00Z"},
  "groups": [{"chatId":"example-group","threadId":"example-thread","name":"Example","deterministicAcknowledgement":true}]
}
```

The acknowledgement is eligible at intake plus twenty seconds, only for new
interactive owner inputs in those groups. Thread update suppression, route
holds and binding checks still apply. Timer and participant inputs are excluded.
Fresh exact-input running evidence (no older than five seconds) is required for
the working acknowledgement. An adapter input whose current phase is `queued`
gets the truthful `queuedText` instead, without claiming execution started.
`queuedText` defaults to the English sentence above; set it in the same language
as `text`. Both share one durable per-input notice slot, so admission does not
produce a second acknowledgement. Unknown, stale or unsupported runtime activity
stays silent. Ready native Fast or final output cancels both notices even before
V1 imports it; state is checked again inside the send queue.
A real reply attempt or known `NO_REPLY` suppresses the acknowledgement; the
sender cannot predict a `NO_REPLY` produced later. An uncertain real send also
suppresses extra traffic. Frozen text, a stable provider request ID and durable
receipts preserve at most one acknowledgement across retries and restarts.
Native Fast/final replies remain deliverable after it. Inputs older than five
minutes never get a late acknowledgement. The transport journal's directory
watch schedules deadlines independently of an unrelated background API scan.
