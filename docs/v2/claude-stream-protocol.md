# Claude stream-JSON adapter boundary

`orkestr-runtime/src/claude_rpc.rs` decodes output from one owned Claude Code
print invocation. It does not launch a process, serialize input, inspect an
account, grant dispatch permission, or publish canonical run state. Runtime owns
module registration and composition with containment, durable authority, payload
storage, and application acceptance.

## Evidence and supported scope

The local CLI help/version inspected for this adapter was Claude Code 2.1.295.
Help describes `--print --output-format stream-json --verbose`, a UUID for
`--session-id`, and `--resume`. The deployed JavaScript adapter in
`packages/core/src/claude-code-client.js` uses that print/output/verbose shape;
its supervised-process and verification modules distinguish session metadata,
assistant content, housekeeping, and terminal results.

Help also lists optional partial-message, input-replay, hook-event, and subagent
output flags. It does not establish JSON-RPC request IDs or a general echoed
request-correlation field. This adapter therefore makes no reusable multi-prompt
or multiplexed connection claim. Unknown top-level event types and unknown
system subtypes are rejected. Partial-message and hook-event modes require a
separately reviewed extension before use.

All tests here use synthetic fixtures. No inference, credentials, provider
capture, entitlement validation, or production activation was performed. The
candidate output subset must be checked against the selected CLI version when
Runtime composes actual execution; help alone is not full wire-schema evidence.

## Ownership and observations

Construct `ClaudeRpc::new(native_session, local_request_key)` once for each owned
invocation. The native identifier must have UUID syntax. The owner supplies a
nonempty local key of at most 128 ASCII letters, digits, or `-_.:` characters.
This key is checked on every `receive` and `finish`; it is not sent to, or echoed
by, Claude. Session comparison is UUID-case insensitive.

Separate roles need distinct owned channels and distinct native sessions. Core
and Runtime must enforce that allocation and the consumed dispatch grant: a pure
parser cannot establish global uniqueness or make recreating a parser safe.
Every frame must have the expected top-level `session_id`. Conflicting identity
aliases in `sessionId` or the message wrapper are rejected too.

| Observation | Meaning |
| --- | --- |
| `Initialized` | One `system/init` frame; metadata, not authentication or a started-turn acknowledgement. |
| `Progress` | Bounded assistant content or a user tool-result frame was observed; no raw content, payload reference, or tool execution is emitted. |
| `CompletedProposal` | Root `result`, subtype `success`, and `is_error: false`, after init and without prior error. Application acceptance remains pending. |
| `Failed` | Explicit assistant error notice or a result with `is_error: true`; raw error details are discarded. |

`rate_limit_event` housekeeping and user text echoes produce no observation.
Assistant/tool/subagent content remains opaque. It cannot execute commands or
turn embedded text saying “completed” into completion. A result or init carrying
a non-null `parent_tool_use_id` cannot terminate or initialize the root invocation.

An assistant error notice is not a terminal result. `terminal_result_seen()`
distinguishes those cases; after an error notice only a failed result can close
the stream successfully. An error result may precede init. A result frame is
still not evidence of process exit or successful containment cleanup.

## Bounds and failure behavior

`receive(local_request_key, line)` takes one complete JSON object without its
newline delimiter. Limits apply to unknown fields as well as known fields:

- 65,536 UTF-8 bytes per frame; raw newline, carriage return, and NUL are rejected.
- 8,192 UTF-8 bytes per string and 128 bytes per object key or metadata identifier.
- 128 entries per collection, 2,048 JSON value nodes, and depth 16 from the root.

The frame bound applies before deserialization; the default JSON deserializer
recursion guard and explicit tree bounds both apply. There is no accumulated
event queue or content buffer. Only the bounded session/key, state flags, and at most 128 telemetry UUIDs
survive a call. Payload persistence, if needed, is a separate authorized boundary.

Any malformed, unknown, mismatched, oversized, replayed-terminal, or contradictory
frame permanently quarantines the parser. Duplicate object keys, including
escaped spellings of the same key, are rejected. Errors contain only a `Blocker` enum,
never raw provider content or native identifiers. This protocol has no retry API.
An explicit owner window-level [native reset](claude-native-reset.md) can replace
continuity after full retirement; it never retries uncertain input.
The closed broker-sanitized `command_lifecycle` and UUID-bearing
`rate_limit_event` shape contains exactly `type`, matching `session_id`, and a
valid `uuid`. These housekeeping frames may precede init or follow a terminal
result and emit no observation. Duplicate telemetry UUIDs and more than 128
telemetry frames poison the parser; no arbitrary control or tool frame is ignored.
The broker must separately validate the native telemetry shape before discarding
or reducing it to this closed form. This supports the selected CLI's lifecycle
notifications without turning them into readiness or completion evidence.
After a terminal result every other frame is rejected, including a duplicate
result. The owner must not accept a proposal before checking subsequent framing,
EOF, process lifecycle, durable fences, and application evidence.

`finish(local_request_key)` accepts clean EOF only after a terminal result and no
protocol error. The transport must additionally reject truncated final lines:
`finish` cannot inspect bytes that the framer did not deliver. EOF before result,
including EOF after an assistant error notice, is a protocol failure. Neither a
successful `finish` nor any observation authorizes redispatch or verified task
completion.

Once Runtime registers the module, its synthetic tests run with
`cargo test --locked -p orkestr-runtime claude_rpc::tests`. Registration and live
process composition are deliberately separate changes owned by Runtime.
