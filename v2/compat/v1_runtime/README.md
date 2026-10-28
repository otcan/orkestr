# Multi-chat WhatsApp transition adapter

This optional adapter keeps V1 as the existing WhatsApp transport and sole
reply producer. New owner (and explicitly listed group member) messages from
explicitly delegated V1 bindings run
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
match its binding refuses only that binding. Every mutation (POST) first
re-checks the server build identity and the session; a read reuses a check
younger than 30 s, and any transport failure forces a new check.

## Pacing

A binding with an input in flight steps it every second. An idle binding
sleeps until its next Rust poll is due (timer occurrences and posts every 5 s,
digests every 30 s, at most 5 s per pass); a new inbound input wakes its
worker at once. A single plain text message is admitted immediately. A queued
burst or attachment under the legacy policy waits until its chat has been quiet for 3 s (each new message of the burst restarts the
wait), and the worker wakes exactly then rather than up to a pass later. With dozens of bindings this keeps idle polling to roughly
about `0.43 x bindings` requests per second.

## Quoted replies

When the owner (or a member) answers an earlier WhatsApp message with a
reply/quote, V1 sends `replyTo` (`messageId`, `author`, `sentAt`, `text` of at
most 500 characters, `isOwnReply`, `unavailable`) beside the input; the visible
`[Replying to ...]` line is already part of `text`. The adapter keeps it in the
ledger (not in the identity digest) and posts it to Rust as `reply_to` with the
message, where it is stored with the input and shown as a quoted bubble. An
unresolvable quote arrives as `unavailable: true` and is never guessed.

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
| `fast_reply_policy` | Optional: `legacy` (default) preserves the progress-dependent Fast policy. Explicit `owner_only` enables immediate Fast replies for a group the operator verified has only owner-visible recipients; participant grants do not establish that visibility. `disabled` suppresses Fast replies (for example a coordinator chat). |
| `owner_only_verified` | Optional, default `false`. Replies in every chat have server-local paths scrubbed (see `outbound_text.py`) unless the operator checked the WhatsApp group holds only the owner and the bot and set this to `true`. `fast_reply_policy` alone does not keep paths. A binding that lists any `participants` (`member` or `none`) is scrubbed even when marked. Adapters before this field refuse a binding that contains it (`binding_fields`): deploy the adapter first. |
| `auto_steer` | Optional: `off` (default), `question` or `running`; enable per binding. See "Auto-steer" below. Adapters before this field refuse a binding that contains it (`binding_fields`). |
| `attachments` | Accept inbound attachments for this binding |
| `max_outstanding_inputs` | 1–64 unsettled inputs before intake answers 409. With `fast_reply_policy: "owner_only"` it is a soft limit: inputs above it are accepted and queued (`capacity_queued`) and only 64 unsettled chat inputs (`HARD_MAX_OUTSTANDING`) answer 409 `binding_capacity_reached` |
| `max_input_age_seconds` | Optional, 60–604800 (default 1800): how long an input may wait without a Rust window before it is refused as `input_expired` |
| `participants` | Optional (default `[]`): other people in the group, see [Group participants](#group-participants) |
| `owner_label` | Optional (default `"Owner"`): the owner's label once the binding has participants |
| `instructions_path` | Optional (default `null`): absolute path to a regular file (at most 32 KiB) with chat rules, see [Chat rules](#chat-rules) |

`conversation_id`, `remote_thread_id`, `public_thread_id` and `chat_id` must be
unique across bindings. A newcomer that collides with a serving binding is
refused; the incumbent continues. The ledger pins owner, conversation, scope,
principals, exclusions and acceptance policy. Changing any of those in the
file refuses that binding (503) without rewriting its ledger; restore the file
or create a new binding. A damaged file pauses only its binding. Revocation is
recorded in the ledger and cannot be undone by editing the file. Every change
applies to one binding only; other bindings keep running.

## Group participants

The owner is always and only the verified `allowed_principals`. Other people in
the group are listed explicitly, one entry per person:

```json
"participants": [
  {"ids": ["491700000001@c.us", "100000000000001@lid"], "label": "Ayse", "role": "member"},
  {"ids": ["491700000005@c.us"], "label": "Cem", "role": "none"}
]
```

* `ids`: that person's WhatsApp phone JID and/or LID (1–8). An id may not be
  an owner principal or belong to two entries.
* `label`: 1–64 printable characters without `:`; unique per binding and not
  the `owner_label`.
* `role`: `member` may instruct this thread; `none` keeps the entry but
  refuses it. There is no participant `owner` or `admin` role.

Members can send messages and instruct their group's thread. They never gain
control: forwarded `originOwner`/`controlAllowed`/`parseCommands` flags confer
nothing and no adapter route changes a binding. The only member requests
refused outright are membership and access changes (adding, inviting or
removing people, roles, ACLs, permissions, bindings; for example "add X to the
group", in English, Turkish or German): `409 member_not_permitted`, before
anything reaches Rust. Everything else, including slash commands and risky
requests, reaches the model with a note: "This message is from <name>, a group
member (not the owner). Use judgment: be careful with destructive, credential,
financial or host-level requests from non-owners; ask the owner when in doubt."

A LID author matches an entry that lists the LID, or the phone JID V1 resolved
for it (`senderPhoneId`, equal to `externalPrincipal.phoneId`). A sender that
claims the owner role without being an owner principal is refused (403). A
well-formed sender that is not a `member` is refused with
`409 participant_not_allowed`; V1 treats it as definite and answers in the
group with a visible notice. Nothing is queued or run.

`participants` and `owner_label` are not pinned in the ledger: editing them and
sending `SIGHUP` applies the new roles to later inputs without refusing the
binding. `GET /threads/<id>/health` reports `members`.

**Author identity.** Each input keeps its verified author (`role`, `id`,
`label`). Once a binding has participants, the text sent to Rust is
`<label>: <text>` after V1's `[WhatsApp: <group>]` header, for the owner as
well, so the conversation shows and the model reads who wrote each message.
Bindings without participants keep the owner's text unchanged. Listed user
rows carry `authorId`, `authorLabel` and `authorRole`. Replies still go to the
group once, through V1, exactly as for the owner.

**Mapping V1's policy at bind time.** `participant_policy` prints the
`participants` V1 currently admits for one thread: phone JIDs in the relay's
`participantAuthors` rule for that group that the V1 binding (with
`allowOtherPeople: true` and `mirrorToWhatsApp: false`) also lists in
`authorizedContactIds`, minus owner aliases and blocked ids, each as `member`.
It never lists more than V1 admits, and V1 still runs its own participant check
before forwarding:

```sh
python3 -m v2.compat.v1_runtime.participant_policy \
  --relay-config /private/relay.json --v1-threads-db /private/threads.sqlite --thread-id <V1 thread>
```

## Intake

The compatibility API requires the configured Bearer secret on every route
and only admits input from the binding's account, group, V1 thread and
verified owner aliases or listed members. Forwarded `originOwner`, command and control flags
confer no additional permission. Edits receive explicit refusals.

### Auto-steer

An owner message that arrives while the head input's Deep run is still running
can go into that same native turn through Rust's supported
`POST /steer` route instead of waiting as a separate turn. `question` mode
does so only after that run asked an asynchronous question (the case where a
queued answer arrives too late); `running` mode does so for any owner message;
`off` keeps the ordinary queue. Only verified owner chat input directly behind
the head is considered, never timer, post, digest, web, member or local-agent
input, attachments, or a message longer than Rust's 16 KiB steer bound, and
only while Rust reports the exact run `running` with the `steer` capability.

The steer request is frozen on the input before any I/O; from then on no queue
path admits it, and a restart replays the same request key. Rust's own steering
state decides: `acknowledged` folds the input into the head (`absorbed_into`,
`steered` audit) so the head's one final answers it and both settle together;
`rejected`, an unconsumed reservation, a definite refusal (for example the run
ended) or a run that ended before any byte was written return it to the
ordinary queue once (`steer_fallback` audit). A queued, non-native steer
admission is first retired through the owner retire route so Core holds no
second copy. Written but unacknowledged delivery is closed with a visible
notice and an operator alert instead of being replayed.

A held input never waits longer than 20 minutes for a definite outcome; it is
then closed with a visible notice and an alert. Unexpected (non-transport)
errors alert once per input and error class. Owner-only Fast intake does not
wait behind a steer Rust already admitted. A steer reference's Core message is
recorded as the adapter's own, so it is never mirrored back as web input.
If the head turn is refused after accepting steered messages, its notice says
so; a deadline continuation carries their text into the new turn.

Known limit: `written_bytes = 0` in Rust's steering status is treated as "no
byte reached the provider". Rust records written bytes in the same transaction
as the bounded write, but a write whose commit fails can leave 0 while bytes
were written, so this is strong evidence, not strict proof. In that rare case
the message may reach the turn and also run once more as an ordinary input.

Rollback (to an adapter without auto-steer):

1. Set `auto_steer: "off"` in the binding (SIGHUP or wait for the rescan). No
   new steers start; held ones still resolve.
2. Wait until the ledger has no input in phase `steering`, and every input
   with a non-empty `steered` list is settled (its final was acknowledged).
3. Remove the `auto_steer` key from the binding file, then install the older
   adapter.

The older adapter refuses a binding that still contains `auto_steer`
(`binding_fields`). It does not know `steer`: it would admit a `steering` row
as an ordinary input (a possible duplicate) and it settles only `burst`
children, so steered rows of an unsettled head would stay listed as
outstanding. Rows with `steer_fallback` or settled steered rows need nothing.

### Owner-only Fast intake

With explicit `fast_reply_policy: "owner_only"`, each verified WhatsApp owner
or listed-member event is admitted individually, even while an earlier Deep
turn is running. (Before, a member message waited on the serial path for the
running Deep turn and held every later owner message, and its Fast reply,
behind it.)
Each pass admits every pending owner input in FIFO order (no per-pass
throttle, no grouping, no quiet window), using the existing owner HTTP message
and execution-window APIs. A deadline-continued or re-admitted owner row is
admitted the same way instead of holding later owner messages until it is the
ledger head. It does not pass an earlier unadmitted
local-agent input or frozen legacy burst. Local-agent/V1-relayed inputs and
other Fast policies keep their existing behavior.

Fast results are observed, exported once, and accepted independently of Deep.
The original message/event IDs select the exact producing run; a separate Fast
cursor leaves Deep progress and questions available to the serial observer.
One shared journal scan per pass (up to 20 pages of 100 events, 3 s) serves
every pending Fast watch, plus one 150 ms tail read per watch, so a finished
Fast reply is exported in the pass that first sees it however far the
journal has moved; before, each watch crawled the journal from its own cursor
100 events per pass, which delayed burst replies by minutes. Only the ledger
head can finish and export its Deep result. Its existing Fast delivery fence
still waits at most 15 seconds and retains uncertain/late transport evidence.
Independent Fast observation failures are logged and retried; they never
refuse or complete the originating input. Admission/window refusals keep
their existing per-input handling.

The owner-only serial observer reads and accepts only Deep. An additive adapter
`fast_watch` table retains the original Fast source, request key, run IDs, cursor
and frozen acceptance independently of any Deep continuation or final delivery.
Only pending inputs create watches; historical completed inputs are not scanned.
At most 24 watches are polled per pass, ordered by last poll so old failures
cannot monopolize new intake. Fast failure/uncertainty does not invent acceptance
or retirement. A substantive Deep final prevents a newly late Fast export;
`NO_REPLY` leaves Fast eligible, including after its silent final is acknowledged.
Already exported Fast and uncertain delivery evidence keep their existing fence.

An unstarted watch closes only after its exact source's canonical Deep acceptance,
a completely read authenticated journal snapshot, and proof its original window
is closed or superseded. This records source/window ineligibility, never an
inferred provider terminal. Otherwise the bounded watch remains for reconciliation.

A repeatedly failing observation gives up locally after 600 seconds from the
committed, canonically accepted Deep final (including `NO_REPLY`). The timestamp
is written atomically with that final export and survives its ACK/restart.
Give-up logs one static operator diagnostic and retains the frozen Fast request,
uncertainty, exports and late-ACK history. It never accepts, cancels or replays a
native run; age alone does not suppress a recovered, valid Fast observation.

Window capacity, queued successor windows, holds, reconciliation and original
child custody still gate execution. This path does not create another provider
actor or bypass those gates. A definite acceptance revision conflict can retry
only the same still-awaiting run/completion/payload after checking canonical
acceptance; unknown transport outcomes retain the frozen request.

Core itself still runs one Fast per execution window at a time: the next
message's Fast starts only after the previous one is accepted or stopped
(`apps/server/src/owned_execution/fast.rs` `run_fast`). The adapter accepts
each Fast as soon as it is proposed, so it is not the gate.

A short Deep final that is exactly the exported Fast reply after
normalization (lowercase words, at most 600 characters) is exported as
`NO_REPLY` (`deep_final_suppressed`). Any digit in either text, or messages
steered into the turn, disable this, so a correction ("11:00", "1,520",
"B14") is always sent. The comparison text is pruned at settlement.

### Bursts

Messages sent in quick succession, such as a text followed by photos sent one
by one, go to Rust as one input under the legacy policy, so one turn answers all
of them with one reply. Explicit owner-only Fast intake keeps each original
owner event separate.
Before an input is sent, the worker waits until the chat has been quiet for 3 s
(`DEFAULT_BURST_QUIET_S`). A continuous stream holds the first input for at
most `BURST_MAX_WAIT_S` (10 s).

The input is then sent together with the queued inputs directly behind it, up
to 8 inputs and 16 KiB of text. This includes inputs that queued while an
earlier turn was running. An input joins only if it:

- comes from the same chat, account and author;
- has not been sent to Rust yet;
- is not a timer, digest or post;
- has not been re-sent.

Every input in the batch has its attachments imported. The combined text starts
with a note that asks for a single reply. The absorbed inputs leave the queue at
once and settle together with the first input's reply or refusal notice.
Each merge logs one `burst_merged` line with the conversation, the first
input's ID, the number of absorbed inputs and the burst span (no message text).

### Grouped Deep turns (owner-only Fast intake)

Under owner-only Fast intake every owner message is admitted on its own and
gets its own Fast reply at once. When several of them queue while a Deep turn
is busy, Core gives the next Deep turn all of them (at most 12 inputs and
20 KiB of owner text), as a numbered list in arrival order with each item's
source reference, and asks the agent to answer every item explicitly
(store-sqlite `deep_groups.rs`). Each grouped input is consumed by that one
run in Core's admission transaction, so it never runs twice; a crash before
that commit leaves the whole burst queued for the next turn. Only verified
owner chat inputs are grouped: timer occurrences, members, local agents,
steers and thread asks keep their own turns and a group never runs past one.
Held inputs (owner Stop) stay held per input.

The exact-run Deep status of such a run lists `grouped_inputs` (head first).
The serial head path then folds the other inputs into the head (each keeps
its own Fast watch), logs one `deep_group_folded` line (identifiers only),
and settles them with the head's final or notice. The one final carries
`quoteSource: true` and `sourceInputId` of the group's LAST input, the V1
quote contract, so WhatsApp can quote the newest message it answers. A
deadline continuation of a grouped turn carries every grouped message,
numbered. The owner switch `deep_grouping` in the conversation settings
(`PUT /api/v2/conversations/{id}/settings`, default `true`, an omitted value
keeps the current one) is read at every Deep admission; `false` restores one
Deep turn per input without a restart.

### Read-only parallel Deep finals (owner-only Fast intake)

With the conversation setting `parallel_deep` on (default off; read from
`GET /settings` at most every 30 s), Core may answer an owner message that
queued behind a running Deep turn with its own read-only parallel Deep turn
(docs/v2/parallel-deep.md). Each pass, `parallel_watch.py` checks the inputs
behind the ledger head for their own run whose exact-run status reports
`parallel_deep: true`. It drives such an input through the ordinary
per-input path, so it settles out of ledger order with its own final and
its own Fast watch.

A Deep final of a burst (`concurrent_deep: true`) carries `quoteSource:
true` and `sourceInputId` of its own input, so WhatsApp quotes the message
it answers. An accepted answer that is exactly `PARALLEL_DEFER` is never
exported, and a failed slot turn sends no notice. In both cases the input
forgets that run, takes a fresh acceptance key and waits for the writer's
own Deep run, which Core gives it next. With the
switch off the watch reads and writes nothing.

### V1-local input

Everything else V1 queues for a delegated thread (thread-to-thread and agent
messages, watch results, Worker assignments, mailbox and job signals, CLI
`orkestr send`, the V1 web UI) is posted to the same route with
`inputKind: "v1_local"`:

```json
{ "inputKind": "v1_local", "role": "user", "connector": "orkestr-v1",
  "publicThreadId", "publicMessageId", "chatId", "accountId", "externalId",
  "source": "cli|thread_watch|mailbox_route|ui|…", "text",
  "origin": { "role": "owner|agent|external", "label": "KDP", "senderRef": "<V1 thread or agent id>" } }
```

The scope (thread, group, account) must match the binding; WhatsApp sources
are refused (422 `invalid_local_input`). The origin is pinned with the input
(a changed origin under the same public ID is `input_identity_changed`) and
grants no control. Rust receives `[Orkestr V1: <label>]`, the text and a note:
the owner's own V1 input is marked as such, agent input carries the member-style
judgment note, and `external` (mailbox, job and e-mail signals) is marked as
untrusted data. The listed user row carries the V1 `source`, `connector:
"orkestr-v1"` and `origin: "v1_local"`. The reply is exported like any other;
V1 keeps it in the V1 thread, where the requester receives it (for example as
its watch result), and acknowledges it as `suppressed` (or `no_reply`), which
settles the input. It is never posted to the WhatsApp group. `GET /health` and
`GET /threads/<id>/health` list the accepted `inputKinds`; V1 forwards local
input only when `v1_local` is listed.

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

### Owner `/switch` (model switch without a model turn)

A WhatsApp message that starts with `/switch` (after V1's `[WhatsApp: ...]`
header, any case) is an adapter command. It is stored already completed in
the same transaction as its intake, so Fast, Deep, bursts, steering and the
queue head never see it, and nothing reaches Rust. The binding's worker
answers it with one `kind: notice` final through the ordinary export and
acknowledgement path; the reply text ends with a short footer saying no model
turn was used. Text such as `please /switch ...` is an ordinary message.

Only the verified WhatsApp owner of the binding may switch. Members, V1-local
senders (agents, threads, CLI, the web UI) and timers or posts (which never
pass intake) are answered with a refusal and nothing runs. Forms:

| Command | Effect |
| --- | --- |
| `/switch status` | This chat's Deep and Fast model and effort, plus the totals of all live chats |
| `/switch deep\|fast <model> [effort]` | This chat only (`--scope <conversation_id>`) |
| `... all` | Every live Codex chat (`--scope codex`) |
| `... from <old>` | Only chats currently on `<old>` (`--from`) |
| `/switch claude` / `/switch codex` (any case) | This chat's Deep to that provider's default: Claude `opus` at the chat's effort when Claude accepts it, else `high`; Codex the configured global Codex default (fallback `gpt-6.1-sol`) at `high`. A provider change, so it asks `/switch yes`; on the same provider it answers "Already on ..." with the status |
| `/switch fast claude\|codex` | Fast is Codex-only: `claude` is refused with that reason, `codex` reports the current Codex Fast setting |
| `/switch deep <codex model> for claude` | Moves the Claude chats to Codex (`--scope claude --provider codex`) |
| `/switch deep <claude model>` in a Codex chat (or the reverse) | Provider switch of this chat |
| `/switch yes` | Confirms a waiting provider switch; it expires after 2 minutes |
| `/switch back` | Undoes the newest switch of this chat that is still in effect: `--revert <record>` when that record changed only this chat, else a switch of this chat back to its recorded previous value |
| `/switch back all` | `--revert latest` |
| `/switch` or `/switch help` | Usage |

`default` as model or effort clears the override. A model with "fable" in
any position is refused before anything runs; other names must match the V2
model contract (`[A-Za-z0-9._:-]{1,120}`), and the tool validates again.
Every change is a dry run first, then the apply; a provider switch stops after
the dry run and needs `/switch yes`. Any new change cancels a waiting
confirmation. The reply names what changed and ends with "/switch back to
undo". An input whose command was running when the adapter stopped is answered
"may or may not have applied" and is never re-run.

The adapter (`switch_tool.py`) runs the operator's model switch tool directly with an argument
list (no shell, a fixed environment, timeouts). Its path comes from the
service environment, never from a message: `ORKESTR_V2_ADAPTER_MODEL_SWITCH`
(an absolute, root-owned, executable file that group and others cannot
write; anything else is refused) and `ORKESTR_V2_ADAPTER_MODEL_SWITCH_RECORDS`
(the tool's record directory, read for `/switch back`). Without them `/switch`
answers that switching is not configured. The tool keeps its own record and
coordination log; the adapter also writes one `SWITCH orkestr-v2-wa-adapter
conversation=... exit=... args=...` line to stderr per call and refusal.

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

## Stranded inputs: Core-gated retry, then one honest notice

A terminal Deep without an accepted answer, or a window that ended before
the input's Deep started, settles the input (`recovery.py`) instead of
leaving it `running` behind a Fast wait.

* A terminal Deep always has a run, so it is never retried (it may already
  have sent mail or posted): one notice plus `ALERT … input_refused`. An owner
  stop is a terminal Deep too.
* An input whose Deep never existed is retried once, silently, only after
  Core retired the original input (`POST /inputs/<message>/retire`). Core
  allows that only while the inbox row is queued, no run references the
  message, it is in no open window and has no queued window intent, so an
  input Core handed to a successor window, an input an owner stop moved to
  the held inputs, or one any run touched is never duplicated. Also required:
  younger than 24 h from `arrived_at` (rows written before that field existed
  are never retried), no final or uncertain export, the journal read through
  Core's head (a non-streaming snapshot read), never retried or continued
  before. When a run references the message (in owner-only chats usually
  its Fast) Core never retires it, so the input closes at once with the
  "interrupted" notice and an ALERT. Only while Core may still run it itself
  (a newer open window, a window request for its event still in Core's
  `/window/queue`, reconciliation, a refused retirement) does the
  serial queue wait, at most 10 minutes, with `ALERT … input_waiting_for_core`
  when the wait starts. "Window ended, no successor" must also be observed
  twice at least 30 s apart, because Core can requeue the input just before
  its dispatcher (1 s poll) opens the successor window. An input in Core's held inputs (an owner stop) is
  never retired or re-admitted: it closes silently (`held`).
* In practice this retry, like the operator re-admission below, applies
  mostly to inputs that never got a Fast run.
* Timer occurrences are never re-sent by the adapter; Core owns their retry.
* Older than 24 h: settled silently (`suppressed`, no export) with
  `ALERT … input_failed_too_old`.

A Deep stop counts as the window's work deadline (and so gets the one-time
`continued` turn) only when `work_deadline_ms` had passed, within 30 s, when
the stop was first seen; a closed window alone (a lapsed lease, a failed
reconciliation) is not deadline evidence. The continuation is admitted only if
Core proves the same native session resumes: Core's intake refuses it unless
the source run's Deep session binding is still current and the provider
generation unchanged (`store-sqlite/src/intake.rs`). A refused or unproven
continuation closes with the "interrupted, nothing is retried" notice.

### Operator re-admission

Run as the adapter service user (the ledger's owner), never as another user
through `sudo`: a SQLite journal created by another user would lock the
service out. The command refuses when its user does not own the ledger.

```
PYTHONDONTWRITEBYTECODE=1 python3 -I -B -m v2.compat.v1_runtime.recovery --ledger <ledger.sqlite3> \
    --public-id <publicMessageId> --request-key <stable-key> --operator <name>
```

(from the installed release directory). The command only records a request
row (`readmit_requests`); the live binding worker decides and performs it on
its own thread. It refuses an input older than 24 h, completed or settled,
already re-admitted, held by a steer, with an accepted Deep, a final or
uncertain export, a live window or an owner-stop hold, and then requires
the same Core retirement as above (`core_still_owns_input` otherwise). One request per
input; repeating the same key returns the recorded outcome.

## Notices

Every notice follows the chat's language (English, Turkish, German), detected
from recent owner/member WhatsApp text (`notices.py`, kept as
`ledger_meta.chat_language`, no text) or the input's own text; anything else
is English. Wording rules: no blame, no promise nothing keeps, honest about
what happened. Members of a shared chat get the short `failure` notice; the
owner (any binding policy) and timers get the technical reason. Templates:
`failure`, `failure_owner`, `interrupted_owner` (never retried),
`timer_failure`, `timer_interrupted`, `steered`, `continue`,
`steer_unknown`, `steer_queued`, `policy`, `activity_running`,
`activity_missing`. The missing-run status is not sent while this input's own
journal match lags Core's head (snapshot `last_sequence` past its cursor);
after 20 minutes of lag the operator gets `ALERT … run_match_lagging`.

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

Occurrences of a binding are driven one at a time, so an occurrence is often
driven after later ones already ran. Its Fast and Deep status is therefore read
by run ID (`/execution?run_id=`, `/fast/execution?run_id=`), never through the
conversation's current view, and an answer the server already accepted is
adopted and classified as usual (silent answers settle as `no_reply`). An
occurrence that has no Deep run of its own once every window of the
conversation is closed (for example a window whose setup failed) is refused as
`timer_window_ended_without_run`, so it never holds later occurrences behind
it. When Core queued the occurrence again after its window failed to open
(once; nothing of it ran), the adapter waits for that retry window instead
(`waiting_for_timer_retry`) and refuses only if the retry ends without a run
as well. Refused occurrences (that one, a failed or lost run, a malformed outcome)
keep a terminal `stalled` marker with `failed: <reason>` and log
`ALERT orkestr-v2-wa-adapter input_failed`, so the operator stall watch reports
them once. A window still open or a run past its deadline stays a normal
20-minute stall. Every `stalled` marker records `since`, when the input arrived
(queued for WhatsApp input, admitted for a timer occurrence).

### Silent runs, digests and message triggers

For calendar timers (`docs/v2/calendar-timers.md`) the adapter does three more
things, all through the same loopback client and all optional on the server side:

- **Silent runs.** Before exporting a timer run's accepted answer it posts the
  raw text to `POST /timer-outcomes {claim_id, text}`. A `deliver: false` answer
  (`NO_REPLY`, or `NO_NEWS` / held `LOW_SIGNAL` for a timer that is silent unless
  changed) is exported as `NO_REPLY` and acknowledged `no_reply`, so V1 sends
  nothing. A server without the route (404) keeps the ordinary reply rules.
- **Digests.** Every 30 s it reads `GET /timer-digests`, records each digest as a
  pseudo timer input (`origin: "timer"`, deterministic ids, idempotent by digest
  id) answered by the digest text, acknowledges it to Rust once the ledger holds
  it, and exports it like any reply (reply prefix and footer apply).
- **Message triggers.** After Core admits an inbound message (not a timer
  occurrence or an agent message) it posts `POST /timer-triggers
  {source: "message", event_key: <public message id>}`, best effort and
  idempotent; a failure never blocks the input.

## Chat rules

V2 Fast and Deep sessions run in one shared role workspace, so a migrated chat
has no per-conversation `AGENTS.md`. A binding may name `instructions_path`
instead. The file must exist, be a regular file readable by the adapter and be
at most 32 KiB when the binding is loaded. Like `participants` it is not pinned
in the ledger: edit the file (or the field) and send SIGHUP.

Every intake the adapter sends to Rust for that binding (owner, member and
V1-local input; never timer occurrences or conversation posts) then starts with
one line, a blank line, and the otherwise unchanged text (`[WhatsApp: ...]`
header, member label and note, reply line):

```
[Chat rules v<first 12 hex of the file's SHA-256>: before answering, read <path> (cat it) unless you already read this version in this session, and follow it.]
```

The line is computed when the input is first sent and frozen with it, so a
retry resends exactly the same text; a deadline continuation reads the file
again. An input whose window ends before any matching run starts is refused
after the grace period as `window_setup_failed`; it is never re-admitted with
a new message ID. The original intake and failed-window evidence remain, the
normal failure notice settles the input, and later inputs can proceed. Timer
occurrences retain their separate Core-owned retry without duplicate intake.
The rules file is never part of the ledger's identity
digest, so a V1 retry after the file changed is still the same input. If the
file is missing or unreadable at send time the input is sent without the line
and `GET /threads/<id>/health` reports `instructionsError`
(`instructions_unreadable`, `instructions_not_regular`,
`instructions_too_large`) until a later send succeeds. The V2 chat view hides
this leading paragraph from the owner's bubble; the model still receives it.

## Conversation posts

A conversation post is an assistant-side message written into a V2
conversation from outside any run (an external coordinator session, operator
alert tooling); see `docs/v2/conversation-posts.md`. Every 5 s (posts are
interactive; digests use 30 s) the adapter reads
`GET /posts?pending=true&limit=20`. For each post it writes, in one ledger
transaction, a pseudo timer input and its final reply, then acknowledges it
with `POST /posts/<id>/delivered`:

- Parent: exactly the timer row shape V1 already materializes (`origin:
  "timer"`, `source`/`connector` `orkestr-v2-timer`, `publicMessageId:
  "v2timer-<uuid5>"`, `timerSourceId: "post"`) with the post's label as its
  text. V1 (`whatsapp-remote-timer-parent.js`) accepts no other parent shape for
  a reply without a WhatsApp input, so no V1 change is needed. V1 shows it as
  `[Timer: <label>]` above the text.
- Reply: `phase: "final_answer"`, text exactly the post text (Rust's reply
  settings are not applied; V1 adds its own prefix and footer), and
  `provider`/`model` from the post, or from the conversation settings when the
  post has no provider, for V1's debug footer.

Ids are deterministic (uuid5 of the post id), so a lost acknowledgement or a
restart adopts nothing new. A post never waits behind a running input, never
reaches Rust as input and never wakes a provider. While a binding is paused
(`enabled: false`) the adapter does not poll: posts stay pending in Rust and
are delivered after it is enabled again (the same as digests).

## Web-UI owner messages

The owner may also type in the V2 web UI of a bound conversation. Those
messages and their answers are mirrored to the group, so WhatsApp shows the
whole conversation. Every 3 s (while the binding is enabled) the worker reads
the conversation snapshot (`GET /api/v2/conversations/<id>?after=<cursor>`)
and adopts each row with `origin: "web"` and `actor_kind: "owner"` that this
adapter did not admit itself:

- **Only web input.** The server marks a row `origin: "web"` only for a
  message the web composer sent (its `client_message_id` starts with `web:`).
  Timer occurrences, steering, conversation posts and every message this
  adapter admitted (WhatsApp and V1-local input; their Core message IDs are
  kept in the ledger) are never mirrored, so nothing echoes back. A server
  without the field mirrors nothing.
- **The message at once.** One pseudo timer input labelled `🖥️ (web)` (the
  same parent shape as conversation posts) whose final reply is the owner's
  text, so V1 sends `[Timer: 🖥️ (web)]` and the text. App attachment notes
  become one line: the file names with `attachments`, otherwise only the
  count. No file bytes are exported. Text is bounded to 3500 characters.
- **The answer when accepted.** The message's own Deep runs are matched by
  its source tuple and read by run ID. The adapter never sends, opens a window
  for or accepts a web message: the web UI (or owner auto-accept) does. Once
  a Deep run of it is accepted, the canonical accepted payload (after Rust's
  reply settings; `NO_REPLY` sends nothing) is exported under a second pseudo
  input labelled `🖥️ (web) ↩ <first 60 characters of the message>`. Several
  web messages in one window each get their own answer.
- **Progress** (`progress_updates` only): at most three notes per message,
  60 s apart, each as its own `🖥️ (web) progress: …` message.
- **Never blocking.** Awaited answers live in their own ledger table, not in
  the serial WhatsApp input queue. One is dropped with a log line
  (`web_answer_dropped ... reason=`) when its Deep run fails or is stopped,
  when it has no run once no window is open, or after 5 hours.
  `GET /threads/<id>/health` reports `webAnswersAwaited`.

Ids are deterministic (uuid5 of the Core message ID) and adoption writes the
mirror and the awaited answer in one transaction, so a restart or a lost
cursor write adopts nothing twice. The first scan of a ledger only records the
current position.

## Returned thread-ask answers

When another conversation answers this binding's thread-ask request after the
asking turn ended, Rust admits the outcome as an input of this conversation
and queues its Deep turn itself. Every web poll, the adapter reads
`GET /thread-ask-inputs?after_sequence=N` and adopts each new row as an
awaited answer. The existing web-answer watch then exports the accepted Deep
answer of exactly that input once, labelled `↩ from <thread name>`.
The other agent's answer text itself is not posted, and the adapter never
opens a window or accepts a run. The first scan only records the current
position. A server without the route answers 404, and nothing happens.

Each chat or V1-local input is posted to Rust with the `author` the adapter
verified (`owner`, `member`, `v1_owner`, `v1_agent` or `v1_external`; timer,
digest and post rows have none). Rust lets only a turn that serves an owner
message ask another thread, so a member or a V1-local sender can never make
an agent contact other threads. The field is sent only when the server's
`/api/v2/health` lists `message_author` in `features`; an older server
(whose request body refuses unknown fields) never receives it, and its
inputs stay unattributed.

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

Rust provider turns receive text only, so a reference UUID alone does not let
the model see the file. When `ORKESTR_V2_ADAPTER_ATTACHMENT_DIR` (an absolute
path) is set in the adapter's environment, each imported file is also written
to `<dir>/<conversation_id>/<sha256><ext>` (directory 0750, file 0640, group
`ORKESTR_V2_ADAPTER_ATTACHMENT_GROUP` when set), and the note names that
local file so a host-mode provider can open it (an image viewing tool or a
file read). A write failure keeps the reference-only note.

Final replies also carry the conversation's `provider` and `model` (from
`GET /settings`, when available) so V1 can show them in its debug footer.

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

### Creating a binding over the loopback API

`PUT /bindings/<remote_thread_id>` (adapter bearer token, JSON binding document)
adds one new binding without an operator writing the file. The Rust server's
"New WhatsApp chat" uses it for a freshly created group thread.
- The document is validated like a file, then written to
  `<bindings_dir>/<remote_thread_id>.json` (0600, created exclusively) and the
  registry reloads. The answer is the binding's `state` and `error`.
- Create-only: if the file exists, an identical document returns `200` and a
  different one returns `409 binding_exists`. The file is never changed.
- A document that shares an identity (route, conversation, V1 thread or chat)
  with another binding is removed again and refused with `409 binding_conflict`.
  The incumbent keeps running.
- Pausing, revoking and every other edit stay operator file edits. A pilot
  configuration without `bindings_dir` answers `409 bindings_dir_unconfigured`.

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

### Rolling back the P0 recovery release

The older adapter runs safely on a ledger written by this one; nothing needs
a migration and no binding field was added:

* New tables/keys (`readmit_requests`, `ledger_meta.chat_language`) and input
  fields (`arrived_at`, `capacity_queued`, `readmitted`, `retired_original`,
  `retry_wait_since`, `deep_stop_seen_ms`, `retry_withheld`, `notice_language`,
  `first_response.echo`, `deep_final_suppressed`) are ignored by it.
* Export rows keep their shape. A re-admitted row is an ordinary queued row
  under fresh keys, which it admits once like any input.
* The older adapter counts every unsettled row against
  `max_outstanding_inputs` on owner-only bindings again, so one holding more
  than that refuses new intake (`binding_capacity_reached`) until
  settlements bring it under the limit; raise the binding's limit first if
  that matters. Core input retirements the adapter made are final either way.
* It reverts to the previous behavior: stranded `running` inputs after a
  closed window, English notices, per-watch journal crawl and the per-pass
  admission limit. Pending operator requests are not executed by it.

### Export change feed

Authenticated `GET /health` advertises `messageChanges` version1. Clients may
hold `GET /changes?cursor=<opaque cursor>&waitMs=25000`; an export wakes it only
after its SQLite transaction commits. The response contains `cursor`, `threads`
(remote binding IDs) and `reset`. It carries no message text and never sends or
re-admits input. Re-read each changed binding through the existing messages API.
Initial, unknown-epoch and future cursors return a route snapshot. A reconnect
with a valid cursor includes every route changed while disconnected. The route
revision map coalesces repeated wakeups without changing export/ACK durability.
Duplicate export inserts and rolled-back transactions do not wake clients.
At most16 long-poll requests may wait concurrently; authentication precedes
admission, and invalid query fields, repeated fields and excessive waits fail.

### Audited export suppression

The local admin command `export_disposition.py` can suppress one completed final
that the operator has independently verified was never imported or transported.
It never sends, replays, acknowledges delivery, changes Core or starts a native
session. Use the immutable installed release's command with `python3 -I -S -B`.
The ledger and its directory must belong to the caller and be private.

First run `inspect --ledger <existing-ledger> --export-id <export-id>`; it prints
only identity, state and SHA256 metadata. For `suppress`, supply the exact
`--input-id`, `--scope-sha256`, `--message-sha256`, an explicit `--request-key`,
`--reason` and `--confirm-never-transported`. This last flag records an operator
attestation, not transport proof: check the importing system and provider
receipts before using it. Recorded or uncertain ACKs, active/batched inputs,
changed scope/content and other pending exports of the input refuse unchanged.

Suppression and its immutable full-text audit commit atomically. The export
outcome becomes `suppressed`, its ACK stays NULL, and complete text remains in
both live and audit records. An identical request is idempotent; a changed
decision with the same key refuses. Later independent inputs and exports retain
their ordinary import/delivery path. No service restart is needed to apply a
disposition using a command already shipped in the installed release.

### Input activity for transport fallbacks

Authenticated `GET /threads/<remote_id>/activity?publicMessageId=<public_id>`
returns version 1 hints for that exact input only: `active`, `observedAtMs`,
`fastReady`, `finalReady`, and `phase`. Missing inputs return 404. A queued,
paused, absorbed, finished, or unobserved input is not active. Native execution
observations older than five seconds cannot authorize a working acknowledgement.
The response contains no message text, credentials, provider session or run IDs.
This read never starts, steers, acknowledges or sends anything; readiness is not
proof that a reply reached its recipient.
