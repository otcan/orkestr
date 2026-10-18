# Primary thread authority: fixed structural aggregate checkpoint

`v2/migration/thread_projection.py::thread_metadata_projection(path)` is the next
executable review candidate. It targets the reviewed primary thread authority,
not the job engine. Its only data-column access is
`main.orkestr_threads.data`, evaluated inside fixed SQLite expressions. No JSON,
identifier, prompt, name, model name, phone/chat identifier or other stored string
is returned. Counts and private deployment receipts stay outside OSS.

## Exact paths and source semantics

The following deployed generic source was inspected without reading database
rows, credentials, profiles or registry files:

| Fixed JSON path(s) | Buckets / interpretation | Source |
|---|---|---|
| `$.threadKind` | worker, task-agent; missing/empty/unknown/unsupported | `threads.js::createThread`; `thread-workers.js::createThreadWorkerScoped`; `task-agents.js` creation with threadKind task-agent |
| `$.parentThreadId`, `$.rootThreadId` | nonempty text reference present/absent; no value returned | `threads.js::createThread`; `thread-workers.js::listThreadWorkers` uses parent references |
| `$.runtimeKind`, `$.runtime.runtimeKind`, `$.executor.metadata.runtimeKind` | separate codex-app-server, codex-tmux, claude-code, api-agent, raw-terminal buckets | `threads.js::createThread`; `thread-executor-state.js::activeThreadExecutor`; `codex-app-server-common.js`; `raw-terminal-mode.js::RAW_TERMINAL_RUNTIME_KIND`; `claude-code-runtime-policy.js::threadUsesClaudeCode` |
| `$.executor.type` | generic, codex, claude-code, api-agent; explicit configured class only | `threads.js::createThread`; `task-agents.js`; `thread-executor-state.js::activeThreadExecutor`; `claude-code-runtime-policy.js::threadUsesClaudeCode` |
| `$.lifecycleState`, `$.lifecycle` | separate active/retired markers | `threads.js::threadLifecycleState/createThread` |
| `$.retired`, `$.archived` | true/false/absent/unsupported boolean markers | `threads.js::threadLifecycleState` |
| `$.state` | sleeping, waking, running, blocked, retiring, retired; unknown otherwise | `threads.js::createThread/threadLifecycleState`; `runtime-leases.js`; `runtime-claude-code-adapter.js` |
| `$.binding` | object present/absent/unsupported only; no nested binding fields | `threads.js::createThread` |
| `$.browserSlug`, `$.desktopSlug`, `$.managedDesktopSlug` | nonempty text reference present/absent/unsupported | `threads.js::createThread` |

No role is inferred from missing threadKind, no actual parent is resolved, and
no child count is inferred from parent-reference presence. Runtime locations
remain separate: precedence, default executor inference and conflicts are not
silently resolved. These are explicit configured markers, not effective provider
selection. Executor id is excluded because it can be an arbitrary identifier;
model/provider free text and profiles are not selected.

Lifecycle markers are not a reimplementation of `threadLifecycleState`: that
helper also considers retirement timestamps and state. The projection preserves
separate marker counts and never turns missing/unknown into active. A stale
running marker is not proof of a currently executing process.

There is no reliable persisted thread timer-presence field in the inspected
schema. `timers.js` stores targetType/target in a separate registry; message/event
timerId is not thread configuration. Timer presence therefore remains unknown.
Browser/desktop and binding reference flags do not establish connector enablement,
route availability, a valid lease or effective capability grants. No access to
binding children, routes, resource grants, capabilities, profile or timer registry
is performed in this increment.

## Query and guards

The fixed query operates on an internal subquery which substitutes JSON null for
non-text or malformed input before any JSON path evaluation. Quality buckets are
object, malformed_json, non_object and unsupported_storage. Every field has the
same invalid-document buckets, so each field's counts account for every row.

For valid objects, enum fields distinguish missing/null, empty string, known
constant, unknown text and unsupported type. Incorrect nested container types
are unsupported. Exact comparisons deliberately avoid guessed normalization.
Presence flags only test fixed-path JSON types and text nonemptiness; strings
stay inside SQLite. No unbounded grouping, JSON traversal or arbitrary path
input is accepted. `QUERY` and `SLOTS` expose the exact deterministic SQL and
fixed result-column mapping for independent inspection.

The connection reuses the reviewed mode=ro transaction, query_only,
trusted_schema=OFF, no-extension and ordinary-table checks. The authorizer then
permits only this table's data/empty-column reads, SELECT and
sum/coalesce/typeof/json_valid/json_type/json_extract/length/trim. It rejects
other columns/tables, ATTACH, writes, schema inspection and other functions.
As with previous projections, this protects fixed internal SQL; it cannot make
arbitrary raw data-column SELECTs safe if a caller were given the connection.
The public function exposes no connection, SQL or path-to-JSON argument.

All counts share one pinned read transaction; the report is partial and makes
no cross-store consistency or live activity claim. Errors abort the report and
must not be printed publicly. Normal WAL coordination limitations from the
reviewed live census edge still apply. A bounded external process remains the
recommended execution wrapper.

## Executed evidence and next review

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s v2/migration/tests -q
```

67/67 synthetic tests pass, including nine new primary-thread tests. They cover
fixed enums/reference flags, sensitive sentinel non-disclosure, malformed JSON,
non-object JSON, unsupported storage/types/containers, unknown values, conflicting
markers kept separate, exhaustive bucket totals, no default role inference,
empty/view handling, forbidden reads/operations and a concurrent WAL commit.
The later transaction sees the commit; the pinned projection does not.

Independent review of this exact candidate and its bounded private production
execution remain pending. No new live thread data query occurred in this
increment. Existing private count and run-state receipts remain valid observed
coverage, not used-workflow parity. The next inventory checkpoint should execute
this grouped projection after review, then identify specific missing authorities
from its fixed buckets without publishing private values. Dormant apply/export,
provenance and revision-safe rollback remain a separate Core dependency.


Follow-up count-integrity review applied fixed source-column qualification and
explicit COLLATE BINARY enum comparisons. New tests reject a missing data column
and preserve unknown uppercase role values even with NOCASE data storage.
All 73 synthetic tests pass. These guards do not add JSON paths or broaden data
authority. The updated exact source still awaits independent review/live execution.
