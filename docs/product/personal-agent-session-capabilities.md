# Personal Agent native session capabilities (OP-26 / ORK-562)

Measured on 2026-10-18 against installed runtime commands. Codex used a
disposable app-server and empty temporary runtime home; Claude used only the
operator-identified direct binary with `--version` and `--help`, as the runtime
OS user and with `CLAUDE_CONFIG_DIR` unset. No inference turn, login, model
download or live thread modification was performed. Codex authentication used
the existing CLI status helper; no credential files were inspected directly.

## Installed inventory

| Capability | Codex CLI 0.163.0 app-server | Claude Code 2.1.295 |
|---|---|---|
| Availability | `--version`, schema generation and stdio initialization succeeded | Direct binary `--version` and `--help` succeeded; the original worker environment still lacks its command configuration |
| Subscription status | Existing supported login status reported authenticated `chatgpt` | **UNVERIFIED**; unauthenticated account API GET returned HTTP 401; diagnostics GET was not invoked because it can launch a side-effecting wrapper |
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

Only an unauthenticated `GET /api/llm-accounts` was attempted in this follow-up;
it returned HTTP 401. No profile identity, state or subscription authentication
was independently verified. No browser cookies or credential files were read to
work around that result.

The diagnostics endpoint was deliberately left uncalled: the deployed
`claude-code-subscription-diagnostics.js` resolves the configured command,
prepares profile directories, then executes `auth status --json`. A configured
supervisor wrapper may change ownership or ACLs when `CLAUDE_CONFIG_DIR` is set.
Thus a GET is not sufficient evidence of a side-effect-free host probe. A
strictly read-only inventory needs an authorized API path whose execution
chain is verified not to invoke that wrapper or prepare profile directories.
This observation does not change live settings or authorize bypassing profile
isolation. Subscription authentication, quota and real Claude session behavior
remain **UNVERIFIED** until a safe authorized path is verified.

### Reproduce without inference

```sh
node scripts/personal-agent-session-probe.mjs --run-no-inference
ORKESTR_SESSION_PROBE=1 node --test test/personal-agent-session-installed.test.js
```

Without the opt-in, the installed test is skipped in CI. The script emits only
sanitized version/authentication booleans, schema property names and RPC result
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
  state; holding a fresh lease alone does not establish native readiness. Cancellation and
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
The proposed schema/lease constraints were sent directly to that owner.

The manager consumes Lane A's prepared synchronous store surface:
`create(input)`, `get(id)`, `list({conversationId, scopeKind, scopeId?, roles?, lifecycles?})`,
`acquireLease(id, {expectedVersion, ttlMs})` and
`update(id, {expectedVersion, leaseToken, patch})`. The env-based public wrappers
can prepare this store asynchronously before constructing the manager; the
native event callback cannot await persistence. The manager does not emulate an
async transaction with a synchronous callback. Each store mutation must use its
own `BEGIN IMMEDIATE` and conditional version/lease predicates. A null CAS result
fails closed. Every successful mutation increments the store-managed version.
Missing mutation IDs throw 404; `get` returns null for a missing row.
A new row defaults to `starting`, version 0 and nullable native/lease fields.
Lease tokens fence writers; the store API has no separate holder ID.
Heartbeat updates use `leaseTtlMs`; release uses `releaseLease`. Lease expiry is
numeric epoch milliseconds; the other timestamps are ISO strings.

Canonical session rows use `modelProfile: {model, effort}`, separate provider and
account-profile fields, and no owner column. Global `scopeId` is SQL NULL, never
a sentinel. `resolveConversation(id, {ownerUserId})` is an injected, synchronous,
trusted authorization projection returning `{id, scopeKind, scopeId}` or null;
it must map canonical conversation scope and apply actual owner authorization.
Absent/revoked lookup fails closed. No forged HTTP owner identity is used.
`ownerUserId`, `model` and `effort` are projected only into native runtime context,
not copied into persistent session rows. No production resolver is supplied here.

Active fast/deep uniqueness includes starting/ready/busy/blocked; stopped rows
remain historical and cannot resume. The database enforces native tuple uniqueness
across all conversations and lifecycles. Concurrent role creation returns only a
matching unique winner. The manager never takes over an existing lease token,
even an expired one. Tests use a fake of the prepared CAS store with matching
defaults, mutation errors, lease CAS and list filters. They do not establish SQLite durability,
DDL/trigger enforcement or process-level locking. Worker 1's #70 owns that
implementation and depends on #68's canonical conversations. This runtime PR
remains based on main and does not import unmerged DDL or ingress code.

**Not yet wired:** the schema owner's SQLite adapter/durability tests and the
asynchronous supervisor consuming canonical ordered inbox items. This PR is a
runtime foundation, not feature-complete OP-26 or a working assistant UI.
Ingress IDs remain owned by OP-25; runtime native IDs never replace them.
The manager does not acknowledge, reorder or synthesize inbox events.
Expired-lease reconciliation and cross-provider/account rebind are explicit
future operations rather than automatic recovery guesses.

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
