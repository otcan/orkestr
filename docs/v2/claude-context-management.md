# Claude context-management response metadata

Claude Code 2.1.295 forwards `context_management` from a Messages API
`message_delta` and can copy it into a complete assistant message. Rejecting
every non-null value in either location rejects ordinary output. The observed
refusal identified this field; its exact value was not retained.

The broker validates and discards the same closed response shape in both
locations. It accepts null or an object containing only `applied_edits`, an
array of at most 16 entries. Each entry has exactly one of these shapes:

| `type` | Required counters |
| --- | --- |
| `clear_tool_uses_20250919` | `cleared_input_tokens`, `cleared_tool_uses` |
| `clear_thinking_20251015` | `cleared_input_tokens`, `cleared_thinking_turns` |

Counters must be integers from zero through `2**53 - 1`; booleans, floats,
unknown keys, unknown edit types, and nested payloads are refused. The empty
array is valid. The containing frame consumes the existing byte and event
budgets. Values are neither retained nor forwarded as progress.

These are historical API context-edit summaries. They grant no tool permission,
input identity, control acknowledgement, interrupted terminal, acceptance, or
child-reaping authority. Session/input/API-message correlation, stream order,
text verification, replay protection, tool refusal, and result guards remain
unchanged.

Primary schema evidence is pinned to Anthropic's Python SDK commit
`bcd55fe1d3f0f1240765f8cef04295b67337f55a`:

- [Context-management response](https://github.com/anthropics/anthropic-sdk-python/blob/bcd55fe1d3f0f1240765f8cef04295b67337f55a/src/anthropic/types/beta/beta_context_management_response.py)
- [Tool-use edit response](https://github.com/anthropics/anthropic-sdk-python/blob/bcd55fe1d3f0f1240765f8cef04295b67337f55a/src/anthropic/types/beta/beta_clear_tool_uses_20250919_edit_response.py)
- [Thinking edit response](https://github.com/anthropics/anthropic-sdk-python/blob/bcd55fe1d3f0f1240765f8cef04295b67337f55a/src/anthropic/types/beta/beta_clear_thinking_20251015_edit_response.py)

Validation uses synthetic frames only. Schema compatibility does not establish
that any particular provider attempt completed or that a release is qualified.
