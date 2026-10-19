# Nullable Claude thinking estimates

Claude Code 2.1.295 emits `thinking_delta.estimated_tokens: null` when a display
estimate is absent. Its synthetic-thinking constructor explicitly emits null,
and its stream coalescer uses `estimatedTokens ?? null`. The pinned Anthropic
[BetaThinkingDelta schema](https://github.com/anthropics/anthropic-sdk-python/blob/bcd55fe1d3f0f1240765f8cef04295b67337f55a/src/anthropic/types/beta/beta_thinking_delta.py)
also declares an optional integer with a null default.

The bounded parser accepts null only alongside an already validated `thinking`
string in an otherwise closed thinking delta. It discards the estimate and
thinking bytes. Present estimates remain nonnegative integers below `2**53`;
booleans, floats, negative values and other types still refuse. A null estimate
with no thinking field refuses. Existing count-only integer metadata behavior
is unchanged.

This does not create input identity, text progress, control acknowledgement or
terminal evidence. First-stream and first-assistant input echoes remain
independent, later events retain the exact API response identity, replay poisons
the channel, and all raw-byte, event and discarded-thinking limits still apply.
Cancellation still requires its separate correlated ACK and genuine interrupted
terminal. This change does not qualify a real provider lifecycle.

The native executable reviewed for these constructors has SHA-256
`4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358`.
The null constructors are at byte offsets 222654377 and 230708083. A synthetic
delta using that exact null shape fails the previous `number()` guard. A prior
real refusal identified only that numeric guard, so its exact field/value
remains unobserved; this compatibility correction is source-supported rather
than a claim to have recovered a raw provider frame.

## Numeric and supported metadata audit

The audit covers every `number()` and `usage()` caller in the partial stream:

| Field or path | Pinned source shape | Existing behavior / correction |
| --- | --- | --- |
| `thinking_delta.estimated_tokens` | Optional integer, including null | Correct null discard; integer bounds retained |
| Usage top-level token counts | Integers; optional cache counts nullable | Already handles null cache counts; finite integer checks retained |
| `cache_creation`, `server_tool_use`, `output_tokens_details` | Nullable containers with integer members | Already handles null containers; nested null values still refuse |
| `ttft_ms` | Optional integer; native rounds and clamps elapsed time | Existing integer rule retained |
| `abandoned_blocks.from_block_index` | Nonnegative safe integer | Existing integer and 128-block bound retained |
| `thinking_duration_ms` | Optional positive integer emitted by a safe-integer check | Existing finite numeric validation accepts the source form |
| `thinking_display` | Optional string, omitted rather than null | Existing bounded string validation retained |
| `speed` | Optional `standard` / `fast`, nullable | Existing closed values retained |

The timing schema is at native byte 207647674; its rounded producer is at
217692309. The abandoned-block schema is at 207649725. Thinking duration is
defined at 207577058 and emitted at 222680187. SDK usage member types are pinned
to the same commit as BetaThinkingDelta: `beta_usage.py`, `beta_cache_creation.py`,
`beta_server_tool_usage.py`, and `beta_output_tokens_details.py`.

Nonempty server-tool usage, iteration/compaction structures, fallback-credit
objects and unsupported header structures remain outside this no-tools slice.
No additional nullable numeric mismatch was found among the supported callers.

Tests exercise discard before genuine text, exact raw-byte charging, malformed
estimates, foreign/missing correlation, replay, event/thinking caps, ACK-only
noncompletion and genuine interrupted terminal. The owned synthetic FD3 child
also sends a nullable thinking estimate before partial text in both completion
and interruption cases. It uses no account or network.
