# Personal Agent native session capabilities (OP-26 / ORK-562)

Measured on 2026-10-18 against installed runtime commands. Codex used a
disposable app-server and empty temporary runtime home; Claude used only the
operator-identified direct binary with `--version` and `--help`, as the runtime
OS user and with `CLAUDE_CONFIG_DIR` unset. No inference turn, login, model
download or live thread modification was performed. The original Codex
authentication observation used the existing CLI status helper; no credential
files were inspected directly. The reproduction script no longer repeats that
live-profile check: it reports authentication as unverified for both providers.

## Installed inventory

| Capability | Codex CLI 0.163.0 app-server | Claude Code 2.1.295 |
|---|---|---|
| Availability | `--version`, schema generation and stdio initialization succeeded | Direct binary `--version` and `--help` succeeded; the original worker environment still lacks its command configuration |
| Subscription status | Existing supported login status reported authenticated `chatgpt` | Operator-supplied stored profile metadata: subscription/ready, last verified 2026-09-25 (about three weeks old). **LIVE auth UNVERIFIED**; no wrapper-free live auth probe exists today |
| Distinct FAST/DEEP identities | Two concurrent metadata-only `thread/start` calls returned distinct native IDs | Fake CLI coverage only |
| Durable resume | Installed `thread/resume` schema supports it; a newly created **empty** thread refused resume with RPC -32600 (no durable rollout yet) | Installed help advertises `--resume [value]`; existing adapter covered by fake CLI, actual populated-history resume **UNVERIFIED** |
| Fork | Installed `thread/fork` schema supports it; empty-thread fork refused with RPC -32600 | Installed help advertises `--fork-session` with resume/continue; bridge still explicitly blocks fork; actual fork **UNVERIFIED** |
| Steer busy turn | Installed `turn/steer` schema requires `threadId`, `expectedTurnId`, `input`; an idle probe was refused with RPC -32600 | Existing print-mode adapter has no busy steering surface; not implemented |
| Cancellation | Installed `turn/interrupt` schema; idle probe refused with RPC -32600. Fake active-turn cancellation covered | Existing process-group termination and permission broker covered by fake CLI tests; live **UNVERIFIED** |
| Concurrency | Concurrent metadata creation succeeded. Separate native IDs and cross-manager per-session leases tested synthetically | Separate invocations and persisted native IDs tested synthetically |
| Model/effort change | Metadata-only `thread/settings/update` accepted `model=gpt-6-sol`, `effort=high`; subsequent `thread/read` returned the same native ID | Installed help advertises `--model <model>` and `--effort <level>`; managed execution covered by fake CLI only |
| Quota, inference quality, busy steer, populated-history resume/fork | **UNVERIFIED**; deliberately no model turns | **UNVERIFIED** |

The accepted model setting is not proof that inference with that model is
available. Authentication is not quota availability. No throughput, quality,
latency, subscription entitlement or unlimited-usage claim follows from this
control-plane inventory.

Installed schemas are authoritative for the tested binary. In particular,
`ThreadResumeParams` does **not** accept `dynamicTools` or `ephemeral`, and
`ThreadForkParams` does not accept `dynamicTools` or `serviceName`. The bridge
uses method-specific parameters. The [official app-server documentation](https://developers.openai.com/codex/app-server/)
describes the protocol; it does not replace the above installed evidence.

### Claude metadata-only follow-up

The direct binary reported `2.1.295 (Claude Code)`. Its installed help advertises:

- `-r, --resume [value]`: resume by session ID or open the picker.
- `--fork-session`: create a new session ID when resuming, used with
  `--resume` or `--continue`.
- `--session-id <uuid>`: use a specific, valid UUID for the conversation.
- `--model <model>`: select an alias or full model name.
- `--output-format <format>`: print-mode `text`, `json` or `stream-json`.
- `--effort <level>`: `low`, `medium`, `high`, `xhigh` or `max`. The current
  managed bridge intentionally validates its narrower existing effort set.

These are advertised CLI capabilities, not successful session operations.
No Claude turn, resume, fork, login or auth-status command was executed. A
missing command configuration in a worker environment remains an explicit
blocked capability; it does not establish that the host runtime is absent.
The runtime manager does not discover another environment's binary implicitly.

The worker's unauthenticated account API GET returned HTTP 401. The coordinator
subsequently supplied allowlisted stored metadata from the authorized read-only
`GET /api/llm-accounts?provider=claude-code`: `provider=claude-code`,
`authMode=subscription`, `authenticationMethod=subscription_token`, `state=ready`,
last verified 2026-09-25 (about three weeks before this inventory), with no
recorded failure or revocation. The coordinator also confirmed that Claude Code
is enabled on the instance. This is attributed historical profile metadata,
not an independently executed live authentication check. Private profile IDs and
labels are omitted. No browser cookies or credential files were read.

The diagnostics endpoint was deliberately left uncalled: the deployed
`claude-code-subscription-diagnostics.js` resolves the configured command,
prepares profile directories, then executes `auth status --json`. A configured
supervisor wrapper may change ownership or ACLs when `CLAUDE_CONFIG_DIR` is set.
The coordinator retracted the earlier diagnostics recommendation. The profile
list route reads stored records without exec, spawn or directory creation;
diagnostics is a separate operation and must not be called for this inventory.
No wrapper-free live auth probe exists today, and this PR does not build one.
**Binary and advertised flags are verified; LIVE authentication, quota and turn
behaviour remain UNVERIFIED.** Historical subscription/ready metadata is not
proof that a new turn would authenticate. No live settings or profile isolation
were changed.

### Reproduce without inference

```sh
node scripts/personal-agent-session-probe.mjs --run-no-inference --codex-bin /absolute/path/to/verified/codex
ORKESTR_SESSION_PROBE=1 ORKESTR_SESSION_PROBE_CODEX_BIN=/absolute/path/to/verified/codex node --test test/personal-agent-session-installed.test.js
```

Identify a direct Codex binary before supplying that path. The script does not
verify an arbitrary executable's implementation. It ignores `ORKESTR_CODEX_BIN`
and never resolves a PATH fallback; without an explicit absolute probe binary it
returns `direct_binary_required` without executing a provider. Every Codex
command, including version and the app-server process, uses a disposable launch
cwd, HOME/CODEX_HOME and an allowlisted child environment. Ambient profile
variables and credentials are excluded, including from the shared app-server client's inherited environment. Neither
`codex login status` nor any auth/status command is run. Live Codex auth is
UNVERIFIED by this script; the historical observation above is not a fresh check.

These reproduction commands probe **Codex metadata only**. They never execute Claude,
including a configured wrapper or a PATH fallback, and never run Claude
`auth status`. Claude reports `manual_metadata_verification_required` with
`auth.verified=false`; this says nothing about whether Claude is installed.
The historical Claude inventory above came from the separately authorized,
operator-identified direct binary, not this script. Repeating that manual
inventory requires identifying a safe direct binary and environment first;
do not substitute the configured wrapper or call diagnostics. LIVE Claude auth
remains UNVERIFIED. No wrapper-free live authentication probe is added here.

Without the opt-in, the installed test is skipped in CI. The script emits only
sanitized Codex version, unverified-auth markers, schema property names and RPC result
classifications. It does not emit account identities, native IDs, paths, raw
provider errors or credentials. It closes its own child and removes its own
temporary directory, including generated schemas and empty native sessions.
An RPC allowlist rejects inference methods before dispatch; the sanitized
report counts the permitted control requests.

## Implemented runtime contract

`createPersonalAgentSessionManager` provides `ensure`, `ensureScope`,
`startOrResume`, `runTurn`, `changeProfile` and `get`. It uses the single
canonical `personalAgentFeature(env)` helper. Flag-off calls do not touch the
store or runtimes. There is no new HTTP endpoint, channel route or UI here.

The composition factory in
`packages/connectors/src/personal-agent-session-runtimes.js` injects the
existing supported Codex authentication discovery into the core bridge.
Without that dependency, the core bridge reports unavailable. Core imports no
new connector module and never infers authentication from a selected profile.

- Orkestr session ID, canonical conversation ID and native provider session ID
  are separate. FAST and DEEP are unique roles in an owner/global or exact
  project conversation; worker sessions may be numerous. Fork lineage stays
  within the same conversation and subscription account.
- Existing LLM account profiles resolve the selected subscription credentials.
  An ambient Claude OAuth token is cleared before applying the selected
  profile's execution environment; another account's token cannot survive
  when that profile uses its own CLI login instead.
  An explicit model and optional effort are pinned to the session. A model or
  effort change retains conversation, Orkestr session and native IDs. Switching
  provider/account requires an explicit rebind workflow, which is not provided
  by this change; silently replacing the native conversation is prohibited.
- Runtime probes expose unavailable/authentication/rate-limit blockers. Codex
  requires ChatGPT authentication; Claude requires subscription authentication
  through the existing diagnostics. The existing Claude executor switch stays
  off by default. No executor is automatically enabled and no API/local
  fallback is selected. The optional local Agent Job adapter remains separate.
- Native execution reuses the Agent Job supervisor callbacks, authorization,
  permission broker and effects. A persistent Codex session has a stable tool
  catalog; each call still reaches the current policy/effect checks. Merely
  appearing in that catalog grants nothing. New ingress input is included on
  every managed turn, including resumes. Normal Agent Job retry prompts retain
  their existing behavior.
- A transactionally claimed, renewable lease serializes each native session
  across manager instances. FAST and DEEP can run independently. An expired
  lease is not stolen: reconciliation must establish that the old native turn
  stopped before a future recovery operation can release it. Forks also refuse
  parents that are not ready, including blocked parents with uncertain native
  state; holding a fresh lease alone does not establish native readiness.
  Both `startOrResume` and `runTurn` refuse already blocked sessions until an
  explicit reconciliation clears that state. Eligibility refusals release a
  valid fence without writing lifecycle or diagnosis. Only admitted failures
  may block a session, preserving any existing specific diagnosis.
  Cancellation and
  lease loss reach the native signal; cancelled late output is discarded and
  later tool callbacks refused. The current supervisor remains responsible for
  its own durable job/effect lease and final admission/output validation.
- Native identity is persisted before forwarding `session.started`. An ID
  change, alias of another role, missing native ID, persistence failure or lost
  history fails closed. Provider error prose is not persisted in status.

### Initial-session durability limit

Codex allocates an ID before a first turn materializes durable history. The
manager records `starting`, not `ready`, for this metadata-only start and keeps
the loaded empty native session on its own app-server client until its first
supervised turn. A lost app-server cannot resume that empty history: it blocks
instead of creating a replacement ID or spending quota to seed a transcript.
After a turn starts, normal durable resume is used. A crash before the native
ID can be persisted may leave an unreferenced native session; recovery must not
guess a binding or replay an effect. The empty-session cache is invalidated
**before** `turn/start` dispatch: a lost acknowledgement must reconcile actual
native state rather than bypassing the busy-turn check. Claude print mode cannot allocate a
metadata-only session: its native ID is null/`starting` until the first real
supervised turn reports it. Parking for approval before native creation also
remains `starting`, never `ready` with a null native identity. No UUID is presented as a fabricated Claude ID.

## Storage and integration dependency

Worker 1 owns the conversation/inbox and AgentSession schema, its flag-gated
migration in **agent-jobs.sqlite**, and its SQLite store adapter. This branch
creates no table, migration, secondary database or competing event envelope.
The accepted session migration is additive, runs after #68's canonical
conversation migration, and is gated by `personalAgentFeature(env)`. Schema
changes and their compatibility tests remain with that owner.

The manager consumes Lane A's prepared synchronous store surface:
`create(input)`, `get(id)`, `list({conversationId, scopeKind, scopeId?, roles?, lifecycles?})`,
`acquireLease(id, {expectedVersion, ttlMs})`,
`update(id, {expectedVersion, leaseToken, patch})`. The list filter is
`lifecycles: string[]`, using only `starting|ready|busy|blocked|stopped`.
Only `openPersonalAgentSessionStore()` may be asynchronous; the prepared methods
remain synchronous, including persistence before native event forwarding.
Canonical conversation lookup is injected separately as the trusted synchronous
`resolveConversation(id, {ownerUserId}) -> {id, scopeKind, scopeId} | null`.
It projects #68's `scope_kind` and `project_id`: global/null or project/project ID.
No extra lookup method is required on the session store. The manager uses the
existing list and SQLite uniqueness constraints instead of new role/native lookups.

There is **no runtime-owned transaction adapter** or `transaction(fn)` requirement.
Each canonical SQLite mutation owns its short `BEGIN IMMEDIATE`, validates the
canonical conversation/scope inside that transaction, and fences changes with
version/token predicates. Provider awaits never hold a database transaction.
The env-based wrappers prepare the store asynchronously; native event callbacks
persist synchronously before forwarding an event. A null CAS result fails closed.
Renewal or write/fence conflicts abort the active provider signal without replay;
the uncertain fence is retained for explicit reconciliation.
Workspace preparation uses the same before/after callback guard as tool
authorization and execution: cancellation or a lost fence refuses new preparation
calls and retries, and rejects an in-flight preparation's late result before a
provider can start. This does not undo filesystem work already dispatched inside
a preparation callback; cancellation inside such work requires cooperative checks
by that callback. The manager does not claim to roll back arbitrary side effects.
The synchronous `toolDecision` callback also checks cancellation and the fence
before and after evaluation, preserving its immediate allow/approval/deny return.
Only test fault reporting remains unguarded; it cannot authorize or execute tools.
Every successful mutation increments version. Missing mutation IDs throw 404;
`get` returns null for a missing row. New rows default to `starting`, version 0
and nullable native/lease fields. Lease tokens fence writers, with no separate
holder ID. Heartbeats use `leaseTtlMs`, release uses `releaseLease`; lease expiry
is numeric epoch milliseconds and other timestamps are ISO strings.

Canonical rows use `modelProfile: {model, effort}` with separate provider and
account-profile fields. Neither sessions nor conversations persist an owner
column in this single-user app contract. `ownerUserId` comes from the trusted
factory context, never a message/tool argument. A mandatory synchronous
`authorizeOwner(ownerUserId) -> boolean` must verify the authenticated app owner;
missing, asynchronous or revoked authorization fails closed before storage/native
access. Native account/profile resolution receives that owner transiently, without
writing it to SQLite. This is an application trust boundary, not durable ownership
or isolation against root-capable runtimes.

The injected resolver supplies authoritative canonical scope before creation
and every mutation. It must read canonical scoped conversation storage under
the authenticated app-owner context, never message fields or machine/HTTP
impersonation. A missing resolver, missing canonical storage or asynchronous
resolver is explicit unavailable (503); an unknown/inaccessible conversation is
404. There is no sentinel conversation, schema creation or fallback to an
untrusted projection. IDs/scope,
role, provider/account and fork lineage cannot change under an in-flight lease.
Model/effort updates preserve conversation/session/native IDs; changing provider
or account requires explicit rebind. No production owner authorizer or supervisor
composition is supplied by this foundation.

Active fast/deep uniqueness includes starting/ready/busy/blocked; stopped rows
remain historical and cannot resume. SQLite enforces non-null native tuple
uniqueness across all conversations and lifecycles. Concurrent role creation
returns only a matching unique winner. The manager never acquires an existing
lease token or a busy row, even after expiry. Expired busy sessions stay `busy`
until explicit native reconciliation CAS-updates/releases them. Expiry alone is
never evidence that the provider stopped. #70 must enforce this in its acquisition
predicate too; the earlier expiry-takeover implementation is not compatible.
Tests use a fake prepared CAS store with no outer transaction or owner column.
They demonstrate defaults, authorization, scope checks, fencing and filters;
they do not establish SQLite durability, triggers or process-level locking.
Worker 1 owns that implementation in #70 after #68; this runtime PR copies no
unmerged DDL or ingress code.

**Not yet wired:** the schema owner's SQLite adapter/durability tests and the
asynchronous supervisor consuming canonical ordered inbox items. This PR is a
runtime foundation, not feature-complete OP-26 or a working assistant UI.
Ingress IDs remain owned by OP-25; runtime native IDs never replace them.
The manager does not acknowledge, reorder or synthesize inbox events.
Expired-lease reconciliation and cross-provider/account rebind are explicit
future operations rather than automatic recovery guesses.

### Migration compatibility gates (schema lane)

The real SQLite composition remains unverified until the schema lane is integrated.
Required tests cover flag-off startup without session DDL, dry-run without writes,
post-#68 foreign keys and exact scope validation on create/every mutation,
immutable session/conversation/provider/account bindings, valid profile JSON,
repeated idempotent migration, expired-busy acquisition refusal, and rollback of
CAS lease/heartbeat/version writes within the store's transactions. A previous
flag-off reader must still open the additive database without changing session
rows. Rolling back code preserves rows/native lineage. This contract adds no owner
column or owner backfill; authorization remains in the authenticated app context.

## Acceptance and rollback

Offline tests exercise AT-03 identity separation and same-conversation model
changes; global/project and owner checks; serialization across managers;
heartbeat and lost/expired leases; versioned acquisition/write conflicts;
concurrent role creation; canonical row/profile shape; stopped-session refusal; cancellation/late output; missing runtimes,
authentication and rate limits; fork lineage; native identity tampering and
aliasing; policy callback preservation; exact pinned workspace/model/effort;
strict failed resume; and new input on resumed native turns. Existing native
adapter/conformance tests cover approval parking, denial, cancellation and
ordinary flag-off job behavior. These synthetic results do not prove real
account end-to-end execution.

Rollback: keep `ORKESTR_PERSONAL_AGENT_ENABLED` off (the default) or revert this
runtime change. It introduces no migration or destructive data operation.
Do not erase native transcripts or session bindings during rollback. Any future
SQLite migration follows Worker 1's additive rollback guidance. Application
controls do not isolate a root-capable native runtime from host resources.
