# Personal Agent native session capabilities (OP-26 / ORK-562)

Measured on 2026-10-18 against the installed command, from a disposable
app-server and empty temporary runtime home. No inference turn, login, model
download or live thread modification was performed. The host authentication
check used the existing CLI status helper; no credential files were inspected
directly.

## Installed inventory

| Capability | Codex CLI 0.163.0 app-server | Claude Code |
|---|---|---|
| Availability | `--version`, schema generation and stdio initialization succeeded | Command unavailable in this execution environment; version unknown |
| Subscription status | Existing supported login status reported authenticated `chatgpt` | **UNVERIFIED**; command unavailable |
| Distinct FAST/DEEP identities | Two concurrent metadata-only `thread/start` calls returned distinct native IDs | Fake CLI coverage only |
| Durable resume | Installed `thread/resume` schema supports it; a newly created **empty** thread refused resume with RPC -32600 (no durable rollout yet) | Existing `--resume` adapter; live behavior **UNVERIFIED** |
| Fork | Installed `thread/fork` schema supports it; empty-thread fork refused with RPC -32600 | Bridge explicitly blocks fork; installed support **UNVERIFIED** |
| Steer busy turn | Installed `turn/steer` schema requires `threadId`, `expectedTurnId`, `input`; an idle probe was refused with RPC -32600 | Existing print-mode adapter has no busy steering surface; not implemented |
| Cancellation | Installed `turn/interrupt` schema; idle probe refused with RPC -32600. Fake active-turn cancellation covered | Existing process-group termination and permission broker covered by fake CLI tests; live **UNVERIFIED** |
| Concurrency | Concurrent metadata creation succeeded. Separate native IDs and cross-manager per-session leases tested synthetically | Separate invocations and persisted native IDs tested synthetically |
| Model/effort change | Metadata-only `thread/settings/update` accepted `model=gpt-6-sol`, `effort=high`; subsequent `thread/read` returned the same native ID | Existing `--model` plus managed `--effort`; fake command coverage only |
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
  stopped before a future recovery operation can release it. Cancellation and
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
supervised turn reports it. No UUID is presented as a fabricated Claude ID.

## Storage and integration dependency

Worker 1 owns the conversation/inbox and AgentSession schema, its flag-gated
migration in **agent-jobs.sqlite**, and its SQLite store adapter. This branch
creates no table, migration, secondary database or competing event envelope.
The proposed schema/lease constraints were sent directly to that owner.

The manager currently consumes a small synchronous `transaction(fn)` store:
`get(id)`, `conversation(id)`, `findRole(conversationId, role)`,
`findNative(provider, accountProfileId, nativeSessionId)`, `insert(row)` and
`replace(row)`. All provider awaits occur outside transactions. The schema
adapter must supply atomic cross-process transactions, role/native uniqueness,
foreign keys and rollback. Tests use a transactional fake, not an in-memory
production registry. Row fields are documented in the manager and proposed to
the schema owner; its canonical contract remains authoritative.

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
heartbeat and lost/expired leases; cancellation/late output; missing runtimes,
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
