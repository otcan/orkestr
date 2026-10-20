# Multi-chat WhatsApp transition adapter

This optional adapter keeps V1 as the existing WhatsApp transport and sole
reply producer. New owner messages from explicitly delegated V1 bindings run
in saved Rust conversations, one conversation per binding. It does **not**
enable Rust Core's automatic-reply transport, import old V1 commands, or
migrate the linked WhatsApp account. No dependency beyond Python 3.11+ is
needed.

Run tests from the repository root:

```sh
python3 -m unittest discover -s v2/compat/v1_runtime/tests -v
```

Run the loopback-only service from a pinned checkout:

```sh
python3 -m v2.compat.v1_runtime.server --config /private/operator/service.json
```

`SIGHUP` rescans the binding directory immediately; it is also rescanned every
five seconds. `SIGTERM` stops the service.

## Service configuration

All files must be regular private JSON files (mode `0600`) owned by the
service user; directories must be private (`0700`). The owner credentials
reference must resolve through trusted non-writable parents to a regular
mode-0600 owner credential file; provider `auth.json` is always refused.
Cookies and CSRF values remain in memory and never pass through V1. Do not
copy owner credentials into the V1 environment. Actual values belong in
private deployment state, never in this repository.

| Field | Meaning |
| --- | --- |
| `origin` | Canonical HTTPS Rust origin |
| `loopback_url` | Rust API at HTTP IPv4 loopback with an explicit port |
| `credentials_path` | Existing owner username/password JSON reference |
| `expected_owner` | Exact Rust owner UUID |
| `expected_source` | Pinned deployed Rust source commit |
| `token_path` | Private JSON containing a random alphanumeric `token` of at least 32 characters |
| `listen_port` | Unused unprivileged IPv4 loopback port |
| `bindings_dir` | Private directory of binding files |
| `ledger_dir` | Private directory; each binding gets `<remote_thread_id>.sqlite3` |

One owner session is shared by all bindings. A 401 revokes it for every
binding (operator review, restart required); a conversation that does not
match its binding refuses only that binding.

## Binding files

Each binding is `<bindings_dir>/<remote_thread_id>.json`:

| Field | Meaning |
| --- | --- |
| `conversation_id` | Rust conversation UUID owned only by this binding |
| `public_thread_id`, `chat_id`, `account_id` | Exact selected V1 scope |
| `remote_thread_id` | Adapter's private route UUID; must equal the file name |
| `allowed_principals` | Explicit verified owner sender aliases |
| `excluded_public_ids` | Every V1 input already present at the handoff |
| `automatic_accept_roles` | Explicit owner policy, exactly `["fast", "deep"]` |
| `outbound_role` | Exactly `"deep"` |
| `enabled` | `false` pauses intake and execution; exports and acknowledgements continue |
| `revoked` | `true` permanently withdraws the route (intake and export answer 410) |
| `progress_updates` | Export intermediate Deep progress for this binding |
| `attachments` | Accept inbound attachments for this binding |
| `max_outstanding_inputs` | 1–64 unsettled inputs before intake answers 409 |
| `max_input_age_seconds` | Optional, 60–604800 (default 1800): how long an input may wait without a Rust window before it is refused as `input_expired` |

`conversation_id`, `remote_thread_id`, `public_thread_id` and `chat_id` must be
unique across bindings. A newcomer that collides with a serving binding is
refused; the incumbent continues. The ledger pins owner, conversation, scope,
principals, exclusions and acceptance policy. Changing any of those in the
file refuses that binding (503) without rewriting its ledger; restore the file
or create a new binding. A damaged file pauses only its binding. Revocation is
recorded in the ledger and cannot be undone by editing the file. Every change
applies to one binding only; other bindings keep running.

## Intake

The compatibility API requires the configured Bearer secret on every route
and only admits input from the binding's account, group, V1 thread and
verified owner aliases. Forwarded `originOwner`, command and control flags
confer no additional permission. Edits receive explicit refusals.

POST intake commits an idempotent ledger entry before acknowledging delivery.
A changed body under the same public message ID is refused, also after the
input is settled. Remote user rows retain their original public message ID and
scope so V1 can reconcile a lost intake acknowledgement without replaying
execution or enabling orphan replies. Background work uses immutable Core
message, window and acceptance keys saved before each mutation. Both Fast and
Deep must complete; only the canonically accepted Deep payload is exported
with an immutable acceptance ID and its matching V1 parent. Other browser
inputs, Worker output, old proposals and unrelated conversations are never
mirrored.

## Delivery acknowledgement

`GET /threads/<id>/messages` lists, oldest first, every **unsettled** input and
its exports that have no terminal transport outcome yet. Each export carries
a monotonic `exportSequence`; the response carries
`mirrorAck: {version, ackedThrough, outstandingInputs}` and `truncated`.
Because the list is oldest-first and bounded by outstanding inputs, an unseen
reply can never fall out of V1's fetch window; newer rows simply wait.

V1 reports what its WhatsApp outbox did with each imported export:

```
POST /threads/<id>/mirror-acks
{ "remoteMessageId", "parentPublicMessageId", "localMessageId", "publicThreadId",
  "outcome": "delivered|suppressed|no_reply|failed|uncertain",
  "outboxJobId", "connectorMessageIds", "deliveryState", "deliveredAt", "reason" }
```

* `delivered` requires the outbox job receipt; a `NO_REPLY` export can never
  be acknowledged as delivered, and only a `NO_REPLY` export as `no_reply`.
* `uncertain` is recorded but keeps the export listed and the input
  unsettled. It may later become terminal; it is never replayed by either side.
* A terminal outcome on the final reply **settles** the input: unreported
  progress is retired, stored texts and attachment bytes are pruned, and the
  input stops counting against `max_outstanding_inputs`. Identities, digests,
  Core receipts and outcomes are kept, so a duplicate intake is still
  idempotent.
* A changed terminal outcome, wrong parent or unknown export is refused (409
  or 404). Acknowledgements never cause a send; they are accepted while a
  binding is paused or revoked.

`ackedThrough` is the highest sequence below which every export has a
terminal outcome. `GET /threads/<id>/health` reports outstanding inputs,
pending, uncertain and failed deliveries, plus `refusedInputs` and the latest
`recentRefusals` (`publicMessageId`, `reason`, `phase`, `atMs`, `settled`).
`failed` deliveries settle (V1 will not resend them) and remain visible there
for operator review.

## Refused and expired inputs

An input that will not get a reply is closed instead of holding the chat. A
safety refusal (`execution_requires_review`, `window_refused`, a mismatched
receipt, …) or a definite upstream refusal (any 4xx other than 408/425/429, or
a malformed response; reason `upstream_refused:<status>`) makes the input
terminal: its final export is an owner notice, `kind: "notice"`,
`refusal: <reason>`, text `Not accepted: <reason>. …`. V1 delivers and
acknowledges it like any reply, which settles the input, and the next input
proceeds. Nothing is resent to Rust. Transport failures, 5xx, 408/425/429 and a
revoked owner session retry the same frozen request.

An input that waited longer than `max_input_age_seconds` without a Rust window
(queued, admitted, or refused as `window_busy`) is refused as `input_expired`,
also while the binding is paused, so a re-enabled binding never runs stale
input. A window request whose outcome is unknown is never expired, and V2 timer
occurrences follow Core's own dispatch queue. Inputs blocked by an earlier
adapter version are closed with a notice the same way.

A V1 build without acknowledgements never settles anything, so the adapter
then behaves exactly like the pilot: at most `max_outstanding_inputs` inputs.

## Timer occurrences

A V2 timer enabled in a binding's conversation (see
`docs/v2/thread-timers.md`) produces ordinary input that Core admits itself.
The worker discovers those occurrences through
`GET /api/v2/conversations/<id>/timer-inputs`, adopts each one into the
ledger (identity keyed by its Core message ID; capacity never refuses it) and
drives it like an intake without re-sending it: it waits while the server's
window intent is `queued` (reading `/window` keeps the dispatcher session
current), follows a `dispatched` window, or opens the window itself with the
timer input key if the intent was withdrawn. Both roles are accepted and the
canonical Deep reply is exported exactly like a WhatsApp reply. Its listed
parent is a user row with `source`/`connector` `orkestr-v2-timer`,
`origin: "timer"` and `publicMessageId: "v2timer-<remote id>"`, which V1
materializes once as the reply's local parent; acknowledgements then settle it
normally. A held occurrence (timer disabled or handed back before it ran)
settles silently with nothing exported. The first scan of a ledger records
the current position and adopts nothing older.

## Progress, NO_REPLY and attachments

With `progress_updates`, intermediate payloads of the exact matched Deep run
(phase `running`) are exported as `kind: "progress"`, `phase: "commentary"`
rows: at most three per input, at least 60 seconds apart, truncated to 3500
characters. V1 applies the binding's own `suppressWhatsAppUpdates` and footer
settings and drops progress overtaken by the final reply.

A final Deep payload that is exactly `NO_REPLY` (ignoring surrounding
whitespace) is exported as `NO_REPLY` with `noReply: true`. V1 never
transports it and acknowledges it as `no_reply`. Progress that is exactly
`NO_REPLY` is not exported.

With `attachments`, V1 first uploads each file:

```
POST /threads/<id>/attachments
{ "publicMessageId", "filename", "mediaType", "size", "sha256", "contentBase64" }
```

Uploads are verified (size, SHA-256, V2 filename and media-type rules, 16 MiB
per input, 8 files) and idempotent; they are inert until an owner-verified
input with the same public message ID references them as
`attachments: [{uploadId, sha256}]`. Before intake, the worker imports the
bytes into the binding's conversation through the Rust attachment import API
with a frozen request key, then sends the text with a note naming the
imported manifest and references. Missing bytes block the input instead of
dropping a file. Rust currently produces no files, so outbound attachments
are never exported; replies are text only.

## Adding a binding

1. Obtain the exact selected chat, verify its existing account and verified
   owner identities, and snapshot binding, queue, cursors and history privately.
2. Deploy V1's remote-binding executor fences (and its mirror acknowledgement
   support). Preserve a selected-thread queue hold through the handoff, and
   wait for its current local turn to end.
3. Create the target Rust conversation through the normal owner API and retain
   the old history as an archive. Historical text is not fresh execution input.
4. Write the binding file with `enabled: false`, then `SIGHUP` the service and
   confirm `GET /threads/<id>/health` shows `disabled` and no error.
5. The V1 backend entry (`ORKESTR_REMOTE_THREAD_BACKENDS_JSON`) is shared by
   all bindings of this service; configure it once with `fetchLimit` of at
   least `max_outstanding_inputs × 5` (≤ 500).
6. Keep V1 inbound and mirror disabled during the narrow binding update; record
   all preexisting public input IDs as exclusions. Set `remoteBackend`,
   `remoteThreadId`, `remoteRuntimeEnabled` and `remoteMirrorEnabled` through
   supported binding operations. Do not retire, delete or recreate the chat.
7. Set `enabled: true`, `SIGHUP`, then observe a fresh owner message through
   Rust intake, matched execution, canonical acceptance, the original mirror,
   the real transport delivery receipt and the resulting `delivered`
   acknowledgement (`ackedThrough` advances). Do not claim delivery from an
   adapter HTTP acknowledgement alone.

A busy Rust window remains visible as waiting (until `max_input_age_seconds`);
the adapter never forces another conversation to stop. Revocation or scope
changes block the binding; unexpected terminal execution or inconsistent
receipts refuse that input with an owner notice and keep it in health for
operator review. No
alternate provider, local executor, or direct WhatsApp send is used as a
fallback.

## Migrating the single-chat pilot

The pilot's single-file configuration still loads as one static binding
(pilot defaults: no progress, no attachments, 32 outstanding inputs). Its
ledger is upgraded in place on first open: every accepted reply is re-exported
unacknowledged, which V1 deduplicates by remote message ID and then
acknowledges from its existing delivery records. To move the pilot into a
binding directory, stop the service, copy the ledger to
`<ledger_dir>/<remote_thread_id>.sqlite3` (mode `0600`), write a binding file
with the same scope values, and start the service. Never edit, prune or
rotate a ledger by hand.

## Rollback

Disable the selected binding's V1 inbound/mirror and set `enabled: false`
first. Reconcile every admitted input and possible transport effect before
restoring its saved V1 binding. Preserve the ledger, Core receipts and
existing dedupe ledgers. Never reset global WhatsApp routing, replay an
uncertain send, retire the production chat, or release the selected queue
hold while a delegated input could still execute locally. Verify the original
route with a fresh message.
