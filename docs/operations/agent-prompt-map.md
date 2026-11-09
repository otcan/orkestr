# Agent prompt map

The default conversation has **one primary Codex or Claude agent**. It receives
the conversation input, owns execution, reports useful progress and supplies the
canonical final answer. Configured Codex agents can delegate explicit, bounded
Worker tasks. There is no automatic Fast answer or Fast-to-Deep handoff.

This map describes the public source in
[PR501, commit `2d7fdea4`](https://github.com/otcan/orkestr/tree/2d7fdea4144ff3890a93c264cc34f78ff2707866).
It documents instruction sources; **this Markdown is not loaded as an agent
prompt**. Merging it does not deploy a runtime, update private rules or establish
which instructions a running Native session has consumed.

## Default execution and compatibility names

[Single-agent windows](../v2/single-agent-windows.md) describes the default and
its acceptance boundaries. Both the
[Core configuration](https://github.com/otcan/orkestr/blob/2d7fdea4144ff3890a93c264cc34f78ff2707866/v2/apps/server/src/beta_config.rs)
and [adapter configuration](https://github.com/otcan/orkestr/blob/2d7fdea4144ff3890a93c264cc34f78ff2707866/v2/compat/v1_runtime/config.py)
default `legacy_companions` to `false`. The
[adapter freezes single-agent handling](https://github.com/otcan/orkestr/blob/2d7fdea4144ff3890a93c264cc34f78ff2707866/v2/compat/v1_runtime/execution_mode.py)
for newly admitted inputs. Keeping old Fast launcher inventory or changing a
reply-visibility setting does not enable a companion.

`deep` remains an internal execution-role name for the primary agent. It does
not mean that a second, faster agent receives the message first. Historical
Fast receipts, role constants and parallel-slot code remain readable for
compatibility. `legacy_companions: true` is a deprecated operator transition
switch, not a normal user flow or an automatic fallback.

## Where the primary agent's instructions come from

| Layer | What it supplies | Exact public source |
| --- | --- | --- |
| Provider turn wrapper | The primary agent's supplied text passes through unchanged; there is no separate fixed primary business prompt in this wrapper. The retained Fast constant applies only to the legacy Fast role. | [`turn_text` and legacy constant](https://github.com/otcan/orkestr/blob/2d7fdea4144ff3890a93c264cc34f78ff2707866/v2/crates/orkestr-runtime/src/execution.rs), [Claude turn](https://github.com/otcan/orkestr/blob/2d7fdea4144ff3890a93c264cc34f78ff2707866/v2/crates/orkestr-runtime/src/execution/claude_lifecycle.rs) |
| Per-conversation rules | An optional binding `instructions_path` adds a leading instruction to read the selected private file. Its content hash identifies the version. The adapter freezes the composed input for retries. | [Exact rule line and loader](https://github.com/otcan/orkestr/blob/2d7fdea4144ff3890a93c264cc34f78ff2707866/v2/compat/v1_runtime/instructions.py), [intake composition](https://github.com/otcan/orkestr/blob/2d7fdea4144ff3890a93c264cc34f78ff2707866/v2/compat/v1_runtime/intake.py) |
| Original input and dispatch context | Task text, attachment references and any grouped-input framing are composed into the committed dispatch. Grouping messages is not spawning more agents. | [Dispatch selection](https://github.com/otcan/orkestr/blob/2d7fdea4144ff3890a93c264cc34f78ff2707866/v2/crates/store-sqlite/src/production_runtime/dispatch.rs), [grouped input](https://github.com/otcan/orkestr/blob/2d7fdea4144ff3890a93c264cc34f78ff2707866/v2/crates/store-sqlite/src/production_runtime/deep_groups.rs) |
| Input-origin labels | Owner, agent and external inputs receive distinct labels and notes. Origin does not grant authority. The agent-origin note still includes caution about consequential requests. | [`NOTES` and `compose`](https://github.com/otcan/orkestr/blob/2d7fdea4144ff3890a93c264cc34f78ff2707866/v2/compat/v1_runtime/local_inputs.py) |
| Managed tool descriptions | Available tool schemas and descriptions provide additional instructions. The retained Root-request description still says “protected owner review”; listing it here does not change its wording or permissions. | [Tool descriptions](https://github.com/otcan/orkestr/blob/2d7fdea4144ff3890a93c264cc34f78ff2707866/v2/provider-broker/codex_service/managed_http.py) |
| Provider and workspace instructions | The selected Native Codex or Claude runtime supplies its own instructions and consumes supported workspace instructions. Those provider-owned instructions and an installation's private files are not reproduced by this map. | [Codex profile selection](https://github.com/otcan/orkestr/blob/2d7fdea4144ff3890a93c264cc34f78ff2707866/v2/provider-broker/codex_service/profile.py), [Claude profile selection](https://github.com/otcan/orkestr/blob/2d7fdea4144ff3890a93c264cc34f78ff2707866/v2/provider-broker/claude_connector.py) |

The per-conversation loader emits this generic line, followed by the original
input. The placeholders describe a private installation; they are not bindings:

```text
[Chat rules v<12 hex>: before answering, read <path> (cat it) unless you already read this version in this session, and follow it.]
```

A rule-file update is read when its new version is loaded. It does not rewrite
an already running turn. Missing or unreadable rule files are reported by the
adapter; a source merge alone does not prove rule consumption.

## Optional bounded Workers

A Worker is an explicit delegated task, not a companion response layer.
The task creator supplies its durable `instructions`, scope and budget.
[Worker task input validation](https://github.com/otcan/orkestr/blob/2d7fdea4144ff3890a93c264cc34f78ff2707866/v2/crates/store-sqlite/src/production_runtime/worker_tasks/input.rs)
checks the saved payload and request digest; task-tagged dispatch does not fall
back to the parent's message text. The runtime wrapper adds no Fast note to a
Worker. Do not assume that the parent's full conversation or private rules are
copied into a Worker assignment. See [Worker tasks](../v2/worker-tasks.md).

The following is a **generic policy example** for private conversation rules.
It is not a compiled constant, an automatically installed policy or a statement
that every scope exposes delegation tools:

> Own the work through completion. Before substantial or complex implementation,
> identify deliverables and dependencies and check for existing workers. When
> agent tools are available and the scope allows them, delegate bounded,
> independent tasks with clear ownership and acceptance criteria. Run independent
> assignments in parallel and avoid duplicate edits. Keep integration,
> consequential decisions and final verification with the primary agent. Work
> directly on simple or tightly coupled tasks; when delegation is unavailable,
> continue useful work. Delegation does not add permissions or budget. Reuse
> existing workers, keep fan-out bounded, review their results and report only
> observed activity.

## Progress and final delivery

Useful progress and the canonical final answer come from the same primary
agent. [Internal-context delivery](../v2/internal-context-delivery.md) can suppress
a classified machine-input echo while preserving Native progress and final
output. Suppression is delivery classification, not a prompt and not evidence
that an action completed. The
[adapter worker](https://github.com/otcan/orkestr/blob/2d7fdea4144ff3890a93c264cc34f78ff2707866/v2/compat/v1_runtime/worker.py)
observes the primary execution role in single-agent mode.

A private communication policy can ask the agent to make a concrete start,
report meaningful milestones and blockers during long work, reconcile uncertain
prior effects before repeating them, and finish with verified results. It can
also ask for plain language and keep machine JSON and permission boilerplate
internal unless needed. Such wording alone does not create a timer, guarantee
an update cadence or prove that a running session followed it.

Keep real prompts, conversation bindings and deployment configuration in the
private overlay loaded through `ORKESTR_OVERLAY_DIR`. Verify the selected build,
actual instruction consumption, progress delivery and completed business work
separately. This map grants no permissions and changes none of those surfaces.
